// Headless renderer: drives a deterministic generative-art engine frame by frame
// through Puppeteer, pipes each captured JPEG into ffmpeg, and produces a long
// mp4 plus a short cut. The engine contract is documented in the project brief:
//   URL params : seed, palette, width, height, fps, duration, speed, density, cycleSec
//   window     : READY (bool), TOTAL_FRAMES (int), currentFrame (int),
//                advanceFrame(), advanceFrames(n)

import { spawn } from 'node:child_process';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { synthesizeAmbient } from './audio.js';

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
    // optional image-of-the-day palette: "h,s,l;h,s,l;..." recolours the engine
    colors: pick(cli, 'colors', 'COLORS', '', (v) => String(v)),

    canvasSelector: pick(cli, 'canvas', 'CANVAS_SELECTOR', 'canvas'),
    jpegQuality: pick(cli, 'jpegQuality', 'JPEG_QUALITY', 0.92, num),

    // ffmpeg encode settings
    crf: pick(cli, 'crf', 'CRF', 20, num),
    preset: pick(cli, 'preset', 'PRESET', 'medium'),

    // short cut: a 30s clip taken from a dense section (default 35:00)
    shortStart: pick(cli, 'shortStart', 'SHORT_START', 2100, num), // seconds
    shortDuration: pick(cli, 'shortDuration', 'SHORT_DURATION', 30, num),
    // short aspect ratio: 'fill' = scale-and-crop to vertical 9:16 (best for
    // centered generative art); 'pad' = letterbox the source inside 9:16;
    // 'none' = keep the source aspect (no crop). YouTube Shorts strongly
    // prefer 9:16, so default is 'fill'.
    shortFit: pick(cli, 'shortFit', 'SHORT_FIT', 'fill'),
    shortWidth: pick(cli, 'shortWidth', 'SHORT_WIDTH', 1080, num),
    shortHeight: pick(cli, 'shortHeight', 'SHORT_HEIGHT', 1920, num),

    // thumbnail: extract a single JPEG from the long video for YouTube upload.
    // Default to 65% of duration — past the build-up, before fade-out.
    thumbnailFraction: pick(cli, 'thumbnailFraction', 'THUMB_FRACTION', 0.65, num),

    outDir: pick(cli, 'outDir', 'OUT_DIR', path.join(repoRoot, 'output')),
    readyTimeoutMs: pick(cli, 'readyTimeout', 'READY_TIMEOUT_MS', 60000, num),

    // Ambient music (src/audio.js). Off by default for now (user request,
    // 2026-08-13) while the sound design is still being tuned -- opt back
    // in with --music or MUSIC=1 (wired through to the workflow as
    // vars.MUSIC, same pattern as IMAGE_PALETTE) once it's ready again.
    music: pick(cli, 'music', 'MUSIC', false, (v) => v === true || v === '1' || v === 'true'),
  };

  cfg.longPath = path.join(cfg.outDir, pick(cli, 'longName', 'LONG_NAME', 'long.mp4'));
  cfg.shortPath = path.join(cfg.outDir, pick(cli, 'shortName', 'SHORT_NAME', 'short.mp4'));
  cfg.thumbnailPath = path.join(cfg.outDir, pick(cli, 'thumbName', 'THUMB_NAME', 'thumbnail.jpg'));
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
  if (cfg.colors !== '') p.set('colors', cfg.colors);
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
    '-vcodec', 'mjpeg', // declare the piped input as a stream of JPEGs so ffmpeg
                        // doesn't rely on probing (which fails for small frames)
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
      if (process.env.DEBUG_FFMPEG) console.error(`\n[ffmpeg] closed code=${code}\n${stderr.slice(-3000)}`);
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

// Mux the (video-only) file at videoOnlyPath with a freshly synthesized
// ambient audio track, writing the result to cfg.longPath. Video is stream-
// copied (fast, no re-encode); audio is piped in as raw PCM and encoded to
// AAC. See src/audio.js for why this is procedurally generated rather than
// licensed/library music.
function spawnAudioMuxPipe(videoOnlyPath, outPath, sampleRate) {
  const args = [
    '-y',
    '-i', videoOnlyPath,
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', '2',
    '-i', 'pipe:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    '-movflags', '+faststart',
    outPath,
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 64000) stderr = stderr.slice(-64000); });

  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (process.env.DEBUG_FFMPEG) console.error(`\n[ffmpeg] (audio mux) closed code=${code}\n${stderr.slice(-3000)}`);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg (audio mux) exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
  return { proc, done };
}

async function addAmbientMusic(cfg, videoOnlyPath) {
  const sampleRate = 44100;
  const { proc: ff, done: ffDone } = spawnAudioMuxPipe(videoOnlyPath, cfg.longPath, sampleRate);
  let ffmpegError = null;
  ffDone.catch((e) => { ffmpegError = e; });
  ff.stdin.on('error', (e) => { ffmpegError = ffmpegError || e; });

  await synthesizeAmbient({
    seed: cfg.seed,
    duration: cfg.duration,
    sampleRate,
    onChunk: async (buf) => {
      if (ffmpegError) throw ffmpegError;
      await writeChunk(ff.stdin, buf);
    },
  });
  ff.stdin.end();
  await ffDone;
}

// Build the -vf filter for the Short based on shortFit. Returns null for 'none'.
function shortFilter(cfg) {
  const w = cfg.shortWidth, h = cfg.shortHeight;
  switch (cfg.shortFit) {
    case 'none':
      return null;
    case 'pad':
      // Fit the source inside w x h preserving aspect, then pad with black.
      // Even dimensions are required for yuv420p, hence trunc(...) * 2.
      return `scale=w='if(gt(a,${w}/${h}),${w},-2)':h='if(gt(a,${w}/${h}),-2,${h})',`
           + `scale='trunc(iw/2)*2':'trunc(ih/2)*2',`
           + `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
    case 'fill':
    default:
      // Scale up so the source covers w x h, then center-crop.
      return `scale=w='if(gt(a,${w}/${h}),-2,${w})':h='if(gt(a,${w}/${h}),${h},-2)',`
           + `crop=${w}:${h},setsar=1`;
  }
}

// Cut a clip from the long video, re-encoding so the in/out points are exact
// (stream copy would snap to keyframes). Clamps to the available duration and
// applies the configured aspect transform (default: fill to 1080x1920).
// hasAudio reflects whether cfg.longPath actually has an ambient-music track
// muxed in (see addAmbientMusic) -- carry it into the Short when present,
// otherwise keep the Short silent as before rather than asking ffmpeg to
// encode an audio stream that doesn't exist.
async function cutShort(cfg, hasAudio) {
  const total = cfg.duration;
  const dur = Math.min(cfg.shortDuration, total);
  const start = Math.max(0, Math.min(cfg.shortStart, total - dur));
  const vf = shortFilter(cfg);

  const args = [
    '-y',
    '-ss', String(start),
    '-i', cfg.longPath,
    '-t', String(dur),
    ...(vf ? ['-vf', vf] : []),
    '-c:v', 'libx264',
    '-preset', cfg.preset,
    '-crf', String(cfg.crf),
    '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    '-movflags', '+faststart',
    cfg.shortPath,
  ];
  await runFfmpeg(args, 'short-cut');
  return { start, dur, fit: cfg.shortFit, vf };
}

// Extract a single JPEG thumbnail from the long video at a configurable point.
async function extractThumbnail(cfg) {
  const t = Math.max(0, Math.min(cfg.duration - 0.1, cfg.duration * cfg.thumbnailFraction));
  const args = [
    '-y',
    '-ss', String(t),
    '-i', cfg.longPath,
    '-frames:v', '1',
    '-q:v', '2',           // high-quality JPEG
    cfg.thumbnailPath,
  ];
  await runFfmpeg(args, 'thumbnail');
  return { at: t };
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

    const videoOnlyPath = `${cfg.longPath}.noaudio.mp4`;
    const { proc: ff, done: ffDone } = spawnFfmpegPipe(cfg, videoOnlyPath);
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
    console.log(`[render] wrote ${videoOnlyPath} (video only)`);

    // Add procedurally generated ambient music (see src/audio.js for why
    // it's synthesized rather than licensed/library audio) -- unless
    // disabled (cfg.music, off by default for now, see resolveConfig).
    // Non-fatal by design when enabled: a mux failure falls back to
    // shipping the video-only file rather than losing the whole day's
    // render over it.
    let hasAudio = false;
    if (!cfg.music) {
      await rename(videoOnlyPath, cfg.longPath);
      console.log(`[render] wrote ${cfg.longPath} (music disabled)`);
    } else {
      try {
        await addAmbientMusic(cfg, videoOnlyPath);
        await unlink(videoOnlyPath).catch(() => {});
        hasAudio = true;
        console.log(`[render] wrote ${cfg.longPath} (with ambient music)`);
      } catch (e) {
        console.warn(`[render] ambient music mux failed, falling back to video-only: ${e.message}`);
        await rename(videoOnlyPath, cfg.longPath);
        console.log(`[render] wrote ${cfg.longPath} (video only, no music)`);
      }
    }

    const shortInfo = await cutShort(cfg, hasAudio);
    console.log(`[render] wrote ${cfg.shortPath} (start ${shortInfo.start}s, ${shortInfo.dur}s, fit=${shortInfo.fit}, audio=${hasAudio})`);

    const thumbInfo = await extractThumbnail(cfg);
    console.log(`[render] wrote ${cfg.thumbnailPath} (frame at ${thumbInfo.at.toFixed(1)}s)`);

    return {
      long: cfg.longPath,
      short: cfg.shortPath,
      thumbnail: cfg.thumbnailPath,
      seed: cfg.seed,
      width: cfg.width,
      height: cfg.height,
      fps: cfg.fps,
      duration: cfg.duration,
      totalFrames,
      hasAudio,
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
