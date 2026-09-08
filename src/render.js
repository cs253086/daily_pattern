// Headless renderer: drives a deterministic generative-art engine frame by frame
// through Puppeteer, pipes each captured JPEG into ffmpeg, and produces a long
// mp4 plus a short cut. The engine contract is documented in the project brief:
//   URL params : seed, palette, width, height, fps, duration, speed, density, cycleSec
//   window     : READY (bool), TOTAL_FRAMES (int), currentFrame (int),
//                advanceFrame(), advanceFrames(n)

import { spawn } from 'node:child_process';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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
    // optional image-of-the-day palette: "h,s,l;h,s,l;..." recolours the engine
    colors: pick(cli, 'colors', 'COLORS', '', (v) => String(v)),
    // optional image-of-the-day structure: "gw,gh:v1,v2,..." luminance grid
    // (see src/palette.js's encodeStructure) -- lets an engine (currently
    // composer.html) derive layout, not just colour, from the day's image.
    lum: pick(cli, 'lum', 'LUM', '', (v) => String(v)),

    canvasSelector: pick(cli, 'canvas', 'CANVAS_SELECTOR', 'canvas'),
    jpegQuality: pick(cli, 'jpegQuality', 'JPEG_QUALITY', 0.92, num),

    // Scene-based rendering (2026-09-08). User complaint about a geodesic-
    // dome video, verbatim: "I don't see much dynamics here. It just spins
    // for a hour. without dynamics, there is no fun." That engine had
    // PASSED the previous day's composition-drift gate -- its tilt wobble
    // and light oscillation registered as "change" -- and, more to the
    // point, that gate only runs on Gemini engines, while ~75-80% of
    // published videos come from the curated fallback pool, which never
    // runs it in production. A gate cannot make the pool dynamic. Fixing
    // 33 engines by hand isn't realistic either.
    //
    // This fixes it at the renderer instead, for every engine at once: the
    // hour is split into scenes of sceneSec each, and every scene reloads
    // the SAME engine with a fresh, deterministic per-scene seed. Every
    // engine derives its arrangement/counts/layout from the seed, so each
    // scene is a genuinely new composition of the same pattern family --
    // while the image-of-the-day `colors`/`lum` params stay fixed across
    // scenes, so the palette (the video's identity) stays coherent. Scenes
    // are joined by a crossfadeSec cross-dissolve. Scene 0 keeps the
    // original day seed exactly, so the opening, thumbnail and Short stay
    // reproducible. Set sceneSec=0 (or SCENE_SEC=0, wired to a repo var
    // in daily.yml) to get the old single-scene behaviour back.
    //
    // 2026-09-08 follow-up, same day, user: "You do whatever you need to do
    // to generate more dynamics." Re-seeding the SAME engine only gives
    // each scene as much variety as that engine's seed controls (a
    // geodesic dome is still a geodesic dome at every seed). So scenes now
    // also rotate through DIFFERENT engines: scene 0 is the day's headline
    // engine (it owns the title, thumbnail and Short), every later scene
    // is drawn from `scenePool` (the curated pool, described by
    // src/index.js with its 3D/2D dimension and shape archetype) by
    // buildPlaylist(): a seeded shuffle with no engine reused, no two
    // consecutive scenes sharing an archetype, a per-video cap on any
    // archetype's appearances, and a preference for alternating 3D and 2D
    // for contrast. All scenes share the day's image palette (`colors`/
    // `lum`), so it stays one coherent video. Scene lengths get a
    // deterministic +-sceneJitter wobble so the rhythm isn't metronomic.
    // sceneMix=0 (SCENE_MIX=0) keeps the headline engine for every scene.
    sceneSec: pick(cli, 'sceneSec', 'SCENE_SEC', 150, num),
    crossfadeSec: pick(cli, 'crossfadeSec', 'CROSSFADE_SEC', 2, num),
    sceneJitter: pick(cli, 'sceneJitter', 'SCENE_JITTER', 0.3, num),
    sceneMix: pick(cli, 'sceneMix', 'SCENE_MIX', 1, num) !== 0,
    // [{ path, is3D, archetype }] -- only ever supplied programmatically
    // (src/index.js); a bare `node src/render.js` renders one engine.
    scenePool: Array.isArray(cli.scenePool) ? cli.scenePool : [],
    // Palette for playlist scenes when the headline engine itself isn't
    // recoloured (a Gemini engine draws its own colours, but the curated
    // engines that follow it should still share the day's image palette).
    sceneColors: pick(cli, 'sceneColors', null, '', (v) => String(v)),
    sceneLum: pick(cli, 'sceneLum', null, '', (v) => String(v)),
    maxScenesPerArchetype: pick(cli, 'maxScenesPerArchetype', 'MAX_SCENES_PER_ARCHETYPE', 2, num),

    // ffmpeg encode settings
    crf: pick(cli, 'crf', 'CRF', 20, num),
    preset: pick(cli, 'preset', 'PRESET', 'medium'),

    // short cut: a 30s clip. Default (blank) = derived from the FIRST scene
    // so the Short always shows the headline engine the title names (see
    // shortWindow); an explicit value is an absolute offset in seconds.
    shortStart: pick(cli, 'shortStart', 'SHORT_START', '', (v) => String(v)),
    shortDuration: pick(cli, 'shortDuration', 'SHORT_DURATION', 30, num),
    // short aspect ratio: 'fill' = scale-and-crop to vertical 9:16 (best for
    // centered generative art); 'pad' = letterbox the source inside 9:16;
    // 'none' = keep the source aspect (no crop). YouTube Shorts strongly
    // prefer 9:16, so default is 'fill'.
    shortFit: pick(cli, 'shortFit', 'SHORT_FIT', 'fill'),
    shortWidth: pick(cli, 'shortWidth', 'SHORT_WIDTH', 1080, num),
    shortHeight: pick(cli, 'shortHeight', 'SHORT_HEIGHT', 1920, num),

    // thumbnail: extract a single JPEG from the long video for YouTube upload.
    // Fraction of the FIRST SCENE (the headline engine, so the thumbnail
    // matches the title) -- past the build-up, before the first crossfade.
    // For a single-scene render that is the whole video, as before.
    thumbnailFraction: pick(cli, 'thumbnailFraction', 'THUMB_FRACTION', 0.65, num),

    outDir: pick(cli, 'outDir', 'OUT_DIR', path.join(repoRoot, 'output')),
    readyTimeoutMs: pick(cli, 'readyTimeout', 'READY_TIMEOUT_MS', 60000, num),

    // Ambient music: a real license-free (CC0) track fetched from
    // Freesound.org by src/stockMusic.js and looped to cover the render.
    // ON by default (user request, 2026-08-17; source changed from
    // procedurally-synthesized to real fetched CC0 tracks, 2026-08-19, per
    // user request "don't make music yourself, get a license free music
    // somewhere"). Disable with --music=0 / MUSIC=0 (wired through to the
    // workflow as vars.MUSIC, same pattern as IMAGE_PALETTE) if needed.
    // musicTrackPath is the local file path of that day's downloaded
    // track, set by the caller (src/index.js) before calling render() —
    // render() itself does no network fetching. If music is on but no
    // track path is given (fetch failed/skipped upstream), the video is
    // shipped silent rather than failing the run.
    music: pick(cli, 'music', 'MUSIC', true, (v) => !(v === false || v === '0' || v === 'false')),
    musicTrackPath: pick(cli, 'musicTrackPath', 'MUSIC_TRACK_PATH', '', (v) => String(v)),
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

// `over` holds per-scene overrides for scene-based rendering (see
// planScenes/buildPlaylist): seed, enginePath, colors, lum. No overrides =
// the headline engine with the day's seed.
function buildEngineUrl(cfg, over = {}) {
  const enginePath = over.enginePath || cfg.enginePath;
  if (!existsSync(enginePath)) {
    throw new Error(`Engine HTML not found: ${enginePath}`);
  }
  const colors = cfg.colors !== '' ? cfg.colors : (over.colors || '');
  const lum = cfg.lum !== '' ? cfg.lum : (over.lum || '');
  const url = pathToFileURL(enginePath);
  const p = url.searchParams;
  p.set('seed', String(over.seed ?? cfg.seed));
  if (cfg.palette !== '') p.set('palette', cfg.palette);
  p.set('width', String(cfg.width));
  p.set('height', String(cfg.height));
  p.set('fps', String(cfg.fps));
  p.set('duration', String(cfg.duration));
  if (cfg.speed !== '') p.set('speed', cfg.speed);
  if (cfg.density !== '') p.set('density', cfg.density);
  if (cfg.cycleSec !== '') p.set('cycleSec', cfg.cycleSec);
  if (colors !== '') p.set('colors', colors);
  if (lum !== '') p.set('lum', lum);
  return url.href;
}

// ---------------------------------------------------------------------------
// Scenes (see resolveConfig's sceneSec comment for the why)
// ---------------------------------------------------------------------------

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// Scene 0 uses the day's seed unchanged (so the opening, thumbnail region
// and Short stay exactly reproducible, and a single-scene render is
// byte-identical to the pre-scenes renderer). Later scenes derive a fresh
// integer seed deterministically from it, so the whole hour is still a
// pure function of the date.
function sceneSeedFor(baseSeed, k) {
  return k === 0 ? String(baseSeed) : String(hashStr(`${baseSeed}:scene:${k}`));
}

// Split totalFrames into ~equal scenes of about sceneSec each, plus the
// crossfade length in frames. Every scene's frame count is what gets
// WRITTEN for it; the fade between scene k and k+1 is built from `fade`
// extra frames captured off the end of scene k (never written directly)
// blended onto the first `fade` frames of scene k+1 -- so written frames
// always sum to exactly totalFrames. A duration too short for two scenes
// (every local test render, e.g. DURATION=8) degrades to one scene and no
// fade, i.e. exactly the old behaviour.
//
// `jitter` (0..0.5) varies each scene's length deterministically from the
// seed by up to +-jitter of the mean, so scene changes don't land on a
// metronome; the frame total is still exact. jitter=0 gives equal scenes.
export function planScenes(totalFrames, fps, sceneSec, crossfadeSec, seed = '', jitter = 0) {
  if (!(sceneSec > 0)) return { scenes: [totalFrames], fade: 0 };
  const perScene = Math.max(1, Math.round(sceneSec * fps));
  const count = Math.max(1, Math.round(totalFrames / perScene));
  const j = Math.max(0, Math.min(0.5, Number(jitter) || 0));
  // Antithetic pairs (w, 2-w) so the weights sum to exactly `count` and
  // every scene stays within +-jitter of the mean -- a plain random draw
  // normalised afterwards can overshoot when the draws happen to sum low.
  const weights = Array.from({ length: count }, (_, k) => {
    if (k % 2 === 1) return 2 - (1 + j * (2 * (hashStr(`${seed}:len:${k - 1}`) / 4294967296) - 1));
    if (k === count - 1) return 1; // odd count: last scene takes the mean
    return 1 + j * (2 * (hashStr(`${seed}:len:${k}`) / 4294967296) - 1);
  });
  const sumW = weights.reduce((a, b) => a + b, 0);
  const scenes = weights.map((w) => Math.max(1, Math.floor((totalFrames * w) / sumW)));
  let extra = totalFrames - scenes.reduce((a, b) => a + b, 0);
  for (let k = 0; extra > 0; k = (k + 1) % count) { scenes[k]++; extra--; }
  for (let k = 0; extra < 0; k = (k + 1) % count) { if (scenes[k] > 1) { scenes[k]--; extra++; } }
  let fade = count > 1 ? Math.max(0, Math.round((crossfadeSec || 0) * fps)) : 0;
  const shortest = Math.min(...scenes);
  if (fade * 2 >= shortest) fade = Math.max(0, Math.floor((shortest - 1) / 2));
  return { scenes, fade };
}

// Which engine plays in each scene. Scene 0 is always the headline engine
// (`headline` = { path, is3D, archetype }); later scenes come from `pool`
// (same shape) via a seeded shuffle drawn WITHOUT replacement, subject to:
//   - no two consecutive scenes share a shape archetype (the "same basic
//     unit" notion of repetition from src/index.js's SHAPE_ARCHETYPES, so
//     e.g. two cube-vocabulary engines never play back to back);
//   - no archetype appears more than `maxPerArchetype` times per video
//     (multi-member archetypes are exactly the ones that look alike);
//   - 3D scenes are PACED evenly across the hour rather than front-loaded
//     (soft: whichever dimension is behind its target share is preferred,
//     relaxed when it has nothing eligible left). A naive "alternate 3D
//     and 2D" preference used every 3D engine in the first half and left
//     the second half all-2D -- measured, not guessed.
// The pool is only refilled (allowing a repeat, with a new seed) if it is
// smaller than the scene count -- never in production (34 engines vs ~24
// scenes), only for tiny test pools. Pure function of its inputs, so the
// whole hour is still reproducible from the date.
export function buildPlaylist(headline, pool, count, seed, maxPerArchetype = 2) {
  const out = [headline];
  if (count <= 1 || !pool.length) {
    while (out.length < count) out.push(headline);
    return out;
  }
  // Mulberry32 seeded shuffle -- deterministic, same PRNG family the
  // engines themselves use.
  let a = hashStr(`${seed}:playlist`) >>> 0;
  const rng = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const shuffled = (arr) => { const c = arr.slice(); for (let i = c.length - 1; i > 0; i--) { const k = Math.floor(rng() * (i + 1)); [c[i], c[k]] = [c[k], c[i]]; } return c; };

  let deck = shuffled(pool.filter((e) => e.path !== headline.path));
  const used = new Map([[headline.archetype, 1]]);
  // How many 3D scenes this video can hold under the cap (so pacing aims
  // at a reachable share instead of one the deck can't supply).
  const perArch3D = new Map();
  for (const e of deck) if (e.is3D) perArch3D.set(e.archetype, (perArch3D.get(e.archetype) || 0) + 1);
  let target3D = headline.is3D ? 1 : 0;
  for (const [arch, n] of perArch3D) target3D += Math.min(n, maxPerArchetype - (used.get(arch) || 0));
  // ...aiming for up to half the scenes in 3D (the channel prefers 3D, but
  // a short test render shouldn't come out all-3D just because the pool
  // could supply it).
  target3D = Math.min(target3D, Math.ceil(count / 2));
  let refills = 0;
  while (out.length < count) {
    const prev = out[out.length - 1];
    const k = out.length;
    const used3D = out.filter((e) => e.is3D).length;
    const want3D = (used3D + 0.5) / (k + 1) < target3D / count;
    const okArch = (e) => e.archetype !== prev.archetype;
    const underCap = (e) => (used.get(e.archetype) || 0) < maxPerArchetype;
    const passes = [
      (e) => okArch(e) && underCap(e) && e.is3D === want3D,
      (e) => okArch(e) && underCap(e),
      (e) => okArch(e),
      () => true,
    ];
    let idx = -1;
    for (const pass of passes) { idx = deck.findIndex(pass); if (idx !== -1) break; }
    if (idx === -1) {
      // Deck exhausted (pool smaller than the scene count): refill,
      // excluding the current scene's engine so it can't play twice in a
      // row, and reset the per-archetype cap for the new lap.
      if (++refills > count) break; // defensive: can't happen with a non-empty pool
      deck = shuffled(pool.filter((e) => e.path !== prev.path));
      used.clear();
      continue;
    }
    const [e] = deck.splice(idx, 1);
    used.set(e.archetype, (used.get(e.archetype) || 0) + 1);
    out.push(e);
  }
  while (out.length < count) out.push(headline);
  return out;
}

// In-page helpers. Each is passed to page.evaluate as a function value, so
// it must be self-contained (no closure over Node-side variables).

// Per-scene setup: an offscreen 2D canvas for compositing crossfades, so the
// engine's own canvas is never drawn on (an accumulating engine would
// otherwise carry the overlay into its next frame).
function installSceneHelpers() {
  window.__scene = { off: document.createElement('canvas'), tails: [] };
}

// Decode the previous scene's tail frames (JPEG data URLs) into Image objects
// once per scene, instead of once per blended frame.
async function loadTailImages(urls) {
  const imgs = await Promise.all(urls.map((u) => new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('crossfade tail frame failed to decode'));
    im.src = u;
  })));
  window.__scene.tails = imgs;
}

function captureFrame(q, quality) {
  window.advanceFrame();
  return document.querySelector(q).toDataURL('image/jpeg', quality);
}

// Advance the (new) scene one frame, then composite: previous scene's tail
// frame underneath at full opacity, this scene's live canvas on top at
// alpha t. Result = tail*(1-t) + live*t. Reading a WebGL canvas via
// drawImage relies on preserveDrawingBuffer, which the engine contract
// already requires (validate.js/fingerprint.js read canvases the same way).
function captureBlendedFrame(q, quality, tailIdx, t) {
  window.advanceFrame();
  const live = document.querySelector(q);
  const { off, tails } = window.__scene;
  if (off.width !== live.width || off.height !== live.height) {
    off.width = live.width; off.height = live.height;
  }
  const c = off.getContext('2d');
  c.globalAlpha = 1;
  c.drawImage(tails[tailIdx], 0, 0, off.width, off.height);
  c.globalAlpha = t;
  c.drawImage(live, 0, 0);
  c.globalAlpha = 1;
  return off.toDataURL('image/jpeg', quality);
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

// Mux the (video-only) file at videoOnlyPath with a real license-free
// track downloaded to trackPath (see src/stockMusic.js), writing the
// result to cfg.longPath. Video is stream-copied (fast, no re-encode);
// the track is looped with -stream_loop -1 to cover the full video length
// (the track is almost always much shorter than a 1-hour render) and
// trimmed to match via -shortest.
async function muxStockTrack(cfg, videoOnlyPath, trackPath) {
  const args = [
    '-y',
    '-i', videoOnlyPath,
    '-stream_loop', '-1',
    '-i', trackPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    '-movflags', '+faststart',
    cfg.longPath,
  ];
  await runFfmpeg(args, 'audio mux');
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
// hasAudio reflects whether cfg.longPath actually has a music track muxed
// in (see muxStockTrack) -- carry it into the Short when present,
// otherwise keep the Short silent as before rather than asking ffmpeg to
// encode an audio stream that doesn't exist.
//
// `scene0Sec` is the headline scene's length: by default the Short is cut
// from inside it (starting ~30% in, past any accumulation warm-up, and
// ending before the first crossfade when the scene is long enough), so
// the Short always shows the engine the title names. An explicit
// shortStart is an absolute offset and wins.
async function cutShort(cfg, hasAudio, scene0Sec = cfg.duration) {
  const total = cfg.duration;
  const dur = Math.min(cfg.shortDuration, total);
  let start;
  if (cfg.shortStart !== '' && Number.isFinite(Number(cfg.shortStart))) {
    start = Number(cfg.shortStart);
  } else {
    start = Math.min(scene0Sec * 0.3, Math.max(0, scene0Sec - dur));
  }
  start = Math.max(0, Math.min(start, total - dur));
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
// Taken from inside the first (headline) scene -- see thumbnailFraction.
async function extractThumbnail(cfg, scene0Sec = cfg.duration) {
  const t = Math.max(0, Math.min(cfg.duration - 0.1, scene0Sec * cfg.thumbnailFraction));
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

  // Shared by every scene: navigate, wait for READY, install helpers.
  const loadScene = async (page, sceneUrl, pageErrors) => {
    await page.goto(sceneUrl, { waitUntil: 'load', timeout: cfg.readyTimeoutMs });
    await page.waitForFunction('window.READY === true', { timeout: cfg.readyTimeoutMs })
      .catch((e) => {
        const extra = pageErrors.length ? `\nPage errors:\n${pageErrors.join('\n')}` : '';
        throw new Error(`Engine never set window.READY=true within ${cfg.readyTimeoutMs}ms.${extra}\n${e.message}`);
      });
    await page.evaluate(installSceneHelpers);
  };

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

    // Scene 0 uses the day's seed unchanged. Load it first so TOTAL_FRAMES
    // and the canvas can be validated before anything long-running starts.
    await loadScene(page, url, pageErrors);

    const totalFrames = await page.evaluate('window.TOTAL_FRAMES');
    if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
      throw new Error(`Engine reported invalid TOTAL_FRAMES: ${totalFrames}`);
    }

    // Confirm the canvas exists before we start the (long) loop.
    const hasCanvas = await page.evaluate((q) => !!document.querySelector(q), cfg.canvasSelector);
    if (!hasCanvas) {
      throw new Error(`No element matches canvas selector "${cfg.canvasSelector}".`);
    }

    const { scenes, fade } = planScenes(totalFrames, cfg.fps, cfg.sceneSec, cfg.crossfadeSec, cfg.seed, cfg.sceneJitter);
    console.log(`[render] frames : ${totalFrames}`);
    const secs = scenes.map((f) => (f / cfg.fps).toFixed(0));
    console.log(`[render] scenes : ${scenes.length}`
      + (scenes.length > 1 ? ` (${Math.min(...secs)}-${Math.max(...secs)}s each, ${fade}-frame crossfades)` : ' (single scene, no crossfade)'));

    // Engine per scene. The headline entry's archetype/dimension come from
    // the caller when it knows them (index.js); a bare render() call gets
    // a headline that is simply its own archetype.
    const headline = cfg.scenePool.find((e) => e.path === cfg.enginePath)
      || { path: cfg.enginePath, is3D: /getContext\(\s*['"]webgl2?['"]/.test(readFileSync(cfg.enginePath, 'utf8')), archetype: path.basename(cfg.enginePath, '.html') };
    const pool = cfg.sceneMix ? cfg.scenePool.filter((e) => e.path && existsSync(e.path)) : [];
    const playlist = buildPlaylist(headline, pool, scenes.length, cfg.seed, cfg.maxScenesPerArchetype);
    const playlistNames = playlist.map((e) => path.basename(e.path, '.html'));
    if (scenes.length > 1) {
      const distinct = new Set(playlistNames).size;
      console.log(`[render] playlist: ${distinct} engine${distinct === 1 ? '' : 's'} across ${scenes.length} scenes`
        + (pool.length ? '' : ' (scene mix off or no pool: headline engine only)'));
      playlist.forEach((e, k) => console.log(`[render]   scene ${String(k).padStart(2)}  ${secs[k].padStart(4)}s  ${e.is3D ? '3D' : '2D'}  ${playlistNames[k]}`));
    }

    const videoOnlyPath = `${cfg.longPath}.noaudio.mp4`;
    const { proc: ff, done: ffDone } = spawnFfmpegPipe(cfg, videoOnlyPath);
    // Surface a broken pipe (ffmpeg died) instead of hanging on writes.
    let ffmpegError = null;
    ffDone.catch((e) => { ffmpegError = e; });
    ff.stdin.on('error', (e) => { ffmpegError = ffmpegError || e; });

    const logEvery = Math.max(1, Math.round(totalFrames / 100));
    let written = 0;
    const emit = async (dataUrl) => {
      if (ffmpegError) throw ffmpegError;
      const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      await writeChunk(ff.stdin, buf);
      written++;
      if (written % logEvery === 0 || written === totalFrames) {
        const pct = ((written / totalFrames) * 100).toFixed(1);
        const elapsed = (Date.now() - startedAt) / 1000;
        const eta = elapsed > 0 ? (elapsed / written) * (totalFrames - written) : 0;
        process.stdout.write(`\r[render] ${pct}%  frame ${written}/${totalFrames}  elapsed ${elapsed.toFixed(0)}s  eta ${eta.toFixed(0)}s   `);
      }
    };

    // Tail frames of the previous scene (JPEG data URLs), blended onto the
    // head of the next one. Empty for scene 0.
    let tails = [];
    for (let k = 0; k < scenes.length; k++) {
      if (k > 0) {
        const seed = sceneSeedFor(cfg.seed, k);
        const over = { seed, enginePath: playlist[k].path, colors: cfg.sceneColors, lum: cfg.sceneLum };
        try {
          await loadScene(page, buildEngineUrl(cfg, over), pageErrors);
        } catch (e) {
          // One bad pool engine must not cost the whole day's video: fall
          // back to the headline engine for this scene (same seed), and
          // only fail if even that won't load.
          if (playlist[k].path === cfg.enginePath) throw e;
          console.warn(`\n[render] scene ${k}: ${playlistNames[k]} failed to load (${e.message.split('\n')[0]}); using ${playlistNames[0]} instead`);
          playlist[k] = headline; playlistNames[k] = playlistNames[0];
          await loadScene(page, buildEngineUrl(cfg, { ...over, enginePath: cfg.enginePath }), pageErrors);
        }
      }
      const isLast = k === scenes.length - 1;
      const head = k > 0 ? fade : 0;

      // 1) Crossfade in: blend the previous scene's tail under this scene's
      //    first `head` frames, t rising from ~0 to ~1.
      if (head > 0) {
        await page.evaluate(loadTailImages, tails);
        for (let j = 0; j < head; j++) {
          const t = (j + 1) / (head + 1);
          await emit(await page.evaluate(captureBlendedFrame, cfg.canvasSelector, cfg.jpegQuality, j, t));
        }
      }

      // 2) The scene proper. Each capture advances one frame and reads the
      //    canvas back in a single round-trip to minimise CDP overhead.
      const plain = scenes[k] - head;
      for (let j = 0; j < plain; j++) {
        await emit(await page.evaluate(captureFrame, cfg.canvasSelector, cfg.jpegQuality));
      }

      // 3) Capture (but don't write) `fade` more frames as this scene's
      //    natural continuation, to dissolve under the next scene's opening.
      tails = [];
      if (!isLast && fade > 0) {
        for (let j = 0; j < fade; j++) {
          tails.push(await page.evaluate(captureFrame, cfg.canvasSelector, cfg.jpegQuality));
        }
      }
    }
    process.stdout.write('\n');
    if (written !== totalFrames) {
      throw new Error(`scene planner wrote ${written} frames, expected ${totalFrames}`);
    }

    ff.stdin.end();
    await ffDone;
    console.log(`[render] wrote ${videoOnlyPath} (video only)`);

    // Mux in a real license-free (CC0) track fetched upstream by the caller
    // (see src/stockMusic.js) -- unless disabled (cfg.music) or no track was
    // available (fetch skipped/failed upstream, e.g. no API key or a
    // network hiccup). Non-fatal by design: any problem falls back to
    // shipping the video-only file rather than losing the whole day's
    // render over it.
    let hasAudio = false;
    if (!cfg.music || !cfg.musicTrackPath) {
      await rename(videoOnlyPath, cfg.longPath);
      const why = !cfg.music ? 'music disabled' : 'no track available';
      console.log(`[render] wrote ${cfg.longPath} (${why})`);
    } else {
      try {
        await muxStockTrack(cfg, videoOnlyPath, cfg.musicTrackPath);
        await unlink(videoOnlyPath).catch(() => {});
        hasAudio = true;
        console.log(`[render] wrote ${cfg.longPath} (with license-free music)`);
      } catch (e) {
        console.warn(`[render] music mux failed, falling back to video-only: ${e.message}`);
        await rename(videoOnlyPath, cfg.longPath);
        console.log(`[render] wrote ${cfg.longPath} (video only, no music)`);
      }
    }

    const scene0Sec = scenes[0] / cfg.fps;
    const shortInfo = await cutShort(cfg, hasAudio, scene0Sec);
    console.log(`[render] wrote ${cfg.shortPath} (start ${shortInfo.start}s, ${shortInfo.dur}s, fit=${shortInfo.fit}, audio=${hasAudio})`);

    const thumbInfo = await extractThumbnail(cfg, scene0Sec);
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
      scenes: scenes.length,
      playlist: playlistNames,
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
