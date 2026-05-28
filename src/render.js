// Headless renderer: drives a deterministic generative-art engine frame by frame
// through Puppeteer, pipes each captured JPEG into ffmpeg, and produces a long
// mp4 plus a short cut. The engine contract is documented in the project brief:
//   URL params : seed, palette, width, height, fps, duration, speed, density, cycleSec
//   window     : READY (bool), TOTAL_FRAMES (int), currentFrame (int),
//                advanceFrame(), advanceFrames(n)

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Parse `--key=value` / `--flag` CLI args into a plain object.
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

// Resolve one setting: CLI arg > env var > default. `cast` coerces the string.
function pick(cli, key, envKey, def, cast = (v) => v) {
  if (cli[key] !== undefined) return cast(cli[key]);
  if (envKey && process.env[envKey] !== undefined && process.env[envKey] !== '') {
    return cast(process.env[envKey]);
  }
  return def;
}

const num = (v) => Number(v);

// Build the full render configuration from CLI args + env + defaults.
export function resolveConfig(cli = {}) {
  const engine = pick(cli, 'engine', 'ENGINE', path.join(repoRoot, 'engines', 'bloom.html'));
  const enginePath = path.isAbsolute(engine) ? engine : path.resolve(repoRoot, engine);

  const cfg = {
    enginePath,
    seed: pick(cli, 'seed', 'SEED', String(defaultSeed())),
    palette: pick(cli, 'palette', 'PALETTE', '', (v) => String(v)),
    width: pick(cli, 'width', 'WIDTH', 1920, num),
    height: pick(cli, 'height', 'HEIGHT', 1080, num),
    fps: pick(cli, 'fps', 'FPS', 24, num),
    duration: pick(cli, 'duration', 'DURATION', 3600, num), // seconds
    speed: pick(cli, 'speed', 'SPEED', '', (v) => String(v)),
    density: pick(cli, 'density', 'DENSITY', '', (v) => String(v)),
    cycleSec: pick(cli, 'cycleSec', 'CYCLE_SEC', '', (v) => String(v)),

    canvasSelector: pick(cli, 'canvas', 'CANVAS_SELECTOR', 'canvas'),
    jpegQuality: pick(cli, 'jpegQuality', 'JPEG_QUALITY', 0.92, num),

    // ffmpeg encode settings
    crf: pick(cli, 'crf', 'CRF', 20, num),
    preset: pick(cli, 'preset', 'PRESET', 'medium'),

    // short cut: a 30s clip taken from a dense section (default 35:00)
    shortStart: pick(cli, 'shortStart', 'SHORT_START', 2100, num), // seconds
    shortDuration: pick(cli, 'shortDuration', 'SHORT_DURATION', 30, num),

    outDir: pick(cli, 'outDir', 'OUT_DIR', path.join(repoRoot, 'output')),
    readyTimeoutMs: pick(cli, 'readyTimeout', 'READY_TIMEOUT_MS', 60000, num),
  };

  cfg.longPath = path.join(cfg.outDir, pick(cli, 'longName', 'LONG_NAME', 'long.mp4'));
  cfg.shortPath = path.join(cfg.outDir, pick(cli, 'shortName', 'SHORT_NAME', 'short.mp4'));
  return cfg;
}

// Deterministic per-day seed: YYYYMMDD as an integer (UTC).
function defaultSeed() {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// ---------------------------------------------------------------------------
// Engine URL
// ---------------------------------------------------------------------------

function buildEngineUrl(cfg) {
  if (!existsSync(cfg.enginePath)) {
    throw new Error(`Engine HTML not found: ${cfg.enginePath}`);
  }
  const url = pathToFileURL(cfg.enginePath);
  const p = url.searchParams;
  p.set('seed', cfg.seed);
  if (cfg.palette !== '') p.set('palette', cfg.palette);
  p.set('width', String(cfg.width));
  p.set('height', String(cfg.height));
  p.set('fps', String(cfg.fps));
  p.set('duration', String(cfg.duration));
  if (cfg.speed !== '') p.set('speed', cfg.speed);
  if (cfg.density !== '') p.set('density', cfg.density);
  if (cfg.cycleSec !== '') p.set('cycleSec', cfg.cycleSec);
  return url.href;
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

// Spawn ffmpeg reading a stream of concatenated JPEGs from stdin (image2pipe)
// and encoding an H.264 mp4. Returns { proc, done } where done resolves on exit.
function spawnFfmpegPipe(cfg, outPath) {
  const args = [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(cfg.fps),
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', cfg.preset,
    '-crf', String(cfg.crf),
    '-pix_fmt', 'yuv420p',
    '-r', String(cfg.fps),
    '-movflags', '+faststart',
    outPath,
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 64000) stderr = stderr.slice(-64000); });

  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg (encode) exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
  return { proc, done };
}

// Write a buffer to a stream, respecting backpressure.
function writeChunk(stream, buf) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(buf, (err) => err && reject(err));
    if (ok) resolve();
    else stream.once('drain', resolve);
  });
}

// Cut a clip from the long video, re-encoding so the in/out points are exact
// (stream copy would snap to keyframes). Clamps to the available duration.
async function cutShort(cfg) {
  const total = cfg.duration;
  const dur = Math.min(cfg.shortDuration, total);
  const start = Math.max(0, Math.min(cfg.shortStart, total - dur));

  const args = [
    '-y',
    '-ss', String(start),
    '-i', cfg.longPath,
    '-t', String(dur),
    '-c:v', 'libx264',
    '-preset', cfg.preset,
    '-crf', String(cfg.crf),
    '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart',
    cfg.shortPath,
  ];
  await runFfmpeg(args, 'short-cut');
  return { start, dur };
}

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 64000) stderr = stderr.slice(-64000); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg (${label}) exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export async function render(cli = {}) {
  const cfg = resolveConfig(cli);
  await mkdir(cfg.outDir, { recursive: true });

  const url = buildEngineUrl(cfg);
  console.log(`[render] engine : ${cfg.enginePath}`);
  console.log(`[render] params : seed=${cfg.seed} ${cfg.width}x${cfg.height} ${cfg.fps}fps ${cfg.duration}s palette=${cfg.palette || 'auto'}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
    ],
  });

  const startedAt = Date.now();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: cfg.width, height: cfg.height, deviceScaleFactor: 1 });

    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });

    await page.goto(url, { waitUntil: 'load', timeout: cfg.readyTimeoutMs });

    // Wait for the engine to signal it is ready to be driven.
    await page.waitForFunction('window.READY === true', { timeout: cfg.readyTimeoutMs })
      .catch((e) => {
        const extra = pageErrors.length ? `\nPage errors:\n${pageErrors.join('\n')}` : '';
        throw new Error(`Engine never set window.READY=true within ${cfg.readyTimeoutMs}ms.${extra}\n${e.message}`);
      });

    const totalFrames = await page.evaluate('window.TOTAL_FRAMES');
    if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
      throw new Error(`Engine reported invalid TOTAL_FRAMES: ${totalFrames}`);
    }
    console.log(`[render] frames : ${totalFrames}`);

    // Confirm the canvas exists before we start the (long) loop.
    const hasCanvas = await page.evaluate((q) => !!document.querySelector(q), cfg.canvasSelector);
    if (!hasCanvas) {
      throw new Error(`No element matches canvas selector "${cfg.canvasSelector}".`);
    }

    const { proc: ff, done: ffDone } = spawnFfmpegPipe(cfg, cfg.longPath);
    // Surface a broken pipe (ffmpeg died) instead of hanging on writes.
    let ffmpegError = null;
    ffDone.catch((e) => { ffmpegError = e; });
    ff.stdin.on('error', (e) => { ffmpegError = ffmpegError || e; });

    const logEvery = Math.max(1, Math.round(totalFrames / 100));
    for (let i = 0; i < totalFrames; i++) {
      if (ffmpegError) throw ffmpegError;

      // Advance one frame and read the canvas back as a JPEG data URL in a
      // single round-trip to minimise CDP overhead per frame.
      const dataUrl = await page.evaluate(
        (q, quality) => {
          window.advanceFrame();
          return document.querySelector(q).toDataURL('image/jpeg', quality);
        },
        cfg.canvasSelector,
        cfg.jpegQuality,
      );

      const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      await writeChunk(ff.stdin, buf);

      if (i % logEvery === 0 || i === totalFrames - 1) {
        const pct = (((i + 1) / totalFrames) * 100).toFixed(1);
        const elapsed = (Date.now() - startedAt) / 1000;
        const eta = elapsed > 0 ? (elapsed / (i + 1)) * (totalFrames - i - 1) : 0;
        process.stdout.write(`\r[render] ${pct}%  frame ${i + 1}/${totalFrames}  elapsed ${elapsed.toFixed(0)}s  eta ${eta.toFixed(0)}s   `);
      }
    }
    process.stdout.write('\n');

    ff.stdin.end();
    await ffDone;
    console.log(`[render] wrote ${cfg.longPath}`);

    const shortInfo = await cutShort(cfg);
    console.log(`[render] wrote ${cfg.shortPath} (start ${shortInfo.start}s, ${shortInfo.dur}s)`);

    return {
      long: cfg.longPath,
      short: cfg.shortPath,
      seed: cfg.seed,
      width: cfg.width,
      height: cfg.height,
      fps: cfg.fps,
      duration: cfg.duration,
      totalFrames,
    };
  } finally {
    await browser.close();
  }
}

// Run directly: `node src/render.js [--duration=10 ...]`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  render(parseArgs(process.argv.slice(2)))
    .then((r) => {
      console.log('[render] done:', JSON.stringify(r, null, 2));
    })
    .catch((e) => {
      console.error('[render] FAILED:', e.message);
      process.exit(1);
    });
}
