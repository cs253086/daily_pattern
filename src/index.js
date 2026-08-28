// Orchestrator: render today's video, generate metadata, upload both the long
// video and the Short. Phase 1 uses the built-in Bloom engine. Phase 2 will add
// AI engine generation + validation ahead of the render step (see generate.js /
// validate.js) and fall back here to Bloom on failure.
//
// Flags / env:
//   --no-upload | DRY_RUN=1     render only, skip YouTube upload
//   --duration=N | DURATION     override duration (seconds)
//   --engine=path | ENGINE      override engine HTML
//   (all other render flags pass through — see src/render.js)

import path from 'node:path';
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { readFile, copyFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'dotenv/config';

import { render, resolveConfig } from './render.js';
import { buildMetadata } from './metadata.js';
import { uploadAll } from './upload.js';
import { generateEngine } from './generate.js';
import { validateEngine } from './validate.js';
import { dailyImagePalette, encodeColors, encodeStructure } from './palette.js';
import { fingerprintEngine, zscoreMatrix, distance } from './fingerprint.js';
import { dailyStockTrack } from './stockMusic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

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

const BLOOM = path.join(repoRoot, 'engines', 'bloom.html');
const MANUAL_DIR = path.join(repoRoot, 'engines', 'manual');

// The curated pool: every hand-crafted GEOMETRIC engine in engines/manual/.
// Bloom is kept on disk as a last-resort emergency fallback (see curatedOr)
// but excluded from the normal rotation — it's organic, not the house style.
function curatedPool() {
  const pool = [];
  if (existsSync(MANUAL_DIR)) {
    for (const f of readdirSync(MANUAL_DIR).filter((f) => f.endsWith('.html')).sort()) {
      pool.push(path.join(MANUAL_DIR, f));
    }
  }
  return pool;
}

// Classify an engine file as real WebGL 3D (getContext('webgl'/'webgl2'))
// vs everything else (Canvas2D, incl. wireframe.html which only fakes 3D by
// projecting edges onto a flat canvas -- see CLAUDE.md's "3D / WebGL
// engines" section for why that distinction matters). Content-sniffed
// rather than a hardcoded name list so future engines -- hand-written OR
// Gemini-generated-then-promoted via promoteToCuratedPool() -- are
// classified automatically without needing this list maintained.
const WEBGL_RE = /getContext\(\s*['"]webgl2?['"]/;
function isWebGLEngine(enginePath) {
  try {
    return WEBGL_RE.test(readFileSync(enginePath, 'utf8'));
  } catch {
    return false;
  }
}

// Persisted rotation cursor for the curated pool (committed to git by the
// workflow after each run — see .github/workflows/daily.yml). Tracks the
// NAME of the last curated engine used PER DIMENSION BUCKET (3D vs 2D, see
// below), not a numeric index. This matters once the pool can grow (see
// promoteToCuratedPool() below): curatedPool() is sorted alphabetically, so
// inserting a new file can shift every OTHER engine's position in that sort
// order. A persisted numeric index would then silently point at a
// different engine than intended the moment the pool changes shape -- e.g.
// adding "auto-2026-08-05-....html" (sorts before "geometric") would shift
// geometric from index 0 to 1, kaleidoscope from 2 to 3, etc., breaking the
// "never immediately repeat" guarantee without any error. Storing the NAME
// and looking up its current position each time sidesteps this entirely:
// "next after whatever we last used" is always computed against the pool
// as it exists right now.
const ROTATION_STATE_PATH = path.join(repoRoot, 'state', 'engine-rotation.json');

function readRotationState() {
  try {
    const data = JSON.parse(readFileSync(ROTATION_STATE_PATH, 'utf8'));
    // Old schema (pre dimension-weighting, single `lastEngine` field, no
    // 3D/2D split): migrate it into whichever bucket it turns out to
    // belong to, rather than discarding it and losing the "don't
    // immediately repeat" guarantee for one bucket right after this
    // change ships. The other bucket just bootstraps normally below.
    if (typeof data.lastEngine === 'string' && data.last3D === undefined && data.last2D === undefined) {
      const p = curatedPool().find((f) => path.basename(f, '.html') === data.lastEngine);
      if (p && isWebGLEngine(p)) return { last3D: data.lastEngine, last2D: null };
      if (p) return { last3D: null, last2D: data.lastEngine };
    }
    return {
      last3D: typeof data.last3D === 'string' ? data.last3D : null,
      last2D: typeof data.last2D === 'string' ? data.last2D : null,
    };
  } catch { /* missing or corrupt state file -- caller bootstraps instead */ }
  return { last3D: null, last2D: null };
}

function writeRotationState(state) {
  try {
    mkdirSync(path.dirname(ROTATION_STATE_PATH), { recursive: true });
    writeFileSync(
      ROTATION_STATE_PATH,
      `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (e) {
    console.warn(`[index] could not persist engine rotation state: ${e.message}`);
  }
}

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// Round-robin within a single bucket (a list of engine paths + that
// bucket's persisted "last used" name). Bootstraps deterministically from
// the seed if there's no usable cursor (first run, or the last-used engine
// no longer exists in this bucket), same logic as the pre-weighting
// version, just parameterised over which subset of the pool to cycle.
function nextInBucket(bucketPool, lastName, seed) {
  const names = bucketPool.map((p) => path.basename(p, '.html'));
  const lastIdx = lastName ? names.indexOf(lastName) : -1;
  const idx = lastIdx === -1
    ? (Number(String(seed).replace(/\D/g, '')) || 0) % bucketPool.length
    : (lastIdx + 1) % bucketPool.length;
  return bucketPool[idx];
}

// Fallback when Gemini isn't available or fails: pick the next curated
// engine in true round-robin order (persisted across runs), not a date-hash
// pick. A date-hash pick (previous approach: seed % pool.length) can
// coincidentally repeat the same engine on two different fallback days --
// this happened for real (2026-07-21 and 2026-07-24 both hashed to
// kaleidoscope, producing two visually-similar videos days apart even
// though Gemini succeeded on the days in between). Round-robin guarantees
// the pool cycles before any curated engine repeats, regardless of how many
// Gemini-generated days fall in between fallbacks. Falls back to Bloom only
// if the manual pool is somehow empty (should never happen in normal
// operation).
//
// Dimension-weighted, 2026-08-19 (user request: "generate more 3d patterns
// than 2d patterns"): the pool is split into a 3D bucket (real WebGL
// engines, content-sniffed via isWebGLEngine) and a 2D bucket (everything
// else), each with its OWN independent round-robin cursor so neither bucket
// can repeat before it fully cycles. Which bucket today's pick comes FROM
// is a deterministic weighted choice from the seed (not true randomness --
// keeps this project's "same seed -> same everything" reproducibility
// convention), favouring 3D on clear majority of days without starving 2D
// variety entirely. Falls back to whichever bucket is non-empty if the
// other is (e.g. before any 3D engine existed).
//
// DESIRED_P_3D (0.65) is a TARGET, not applied blindly -- see
// effectiveP3D() below for why a fixed target regressed real-world variety
// once it was actually shipped (2026-08-22 incident, documented in
// CLAUDE.md): weighting 65% of days toward a bucket that only had 2
// engines gave one specific file (solids3d) a ~32.5% chance on ANY
// curated-fallback day, a WORSE single-engine repeat rate than the flat,
// unweighted round-robin this replaced. The fix is to cap how much total
// weight a bucket can be given based on how many engines are actually in
// it, so the weighting is self-correcting as the pool grows (via
// promoteToCuratedPool() or the daily creative-research routine) instead
// of requiring a human to notice and manually re-tune a percentage again.
const DESIRED_P_3D = 0.65;
// No single engine's expected pick frequency should exceed ~20% -- chosen
// to be comfortably better than the ~13-way flat round-robin's ~7-8%
// per-engine rate this project ran before dimension-weighting existed,
// while still allowing a real bias once a bucket is big enough to support
// it (e.g. 4+ engines fully supports the full 65% target: 0.65/4 ≈ 16%).
const MAX_SINGLE_ENGINE_FREQ = 0.20;
function effectiveP3D(n3D) {
  return Math.min(DESIRED_P_3D, MAX_SINGLE_ENGINE_FREQ * n3D);
}
function curatedOr(reason, seed) {
  const pool = curatedPool();
  if (pool.length === 0) {
    if (!existsSync(BLOOM)) throw new Error(`No curated engines found (need engines/manual/*.html or engines/bloom.html)`);
    if (reason) console.warn(`[index] ${reason} — engines/manual/ is empty, using emergency Bloom fallback.`);
    return { engine: BLOOM, source: 'curated:bloom' };
  }
  const pool3D = pool.filter(isWebGLEngine);
  const pool2D = pool.filter((p) => !isWebGLEngine(p));
  const state = readRotationState();

  const p3D = effectiveP3D(pool3D.length);
  const want3D = pool3D.length > 0 && (pool2D.length === 0 || (hashStr(`${seed}:dim`) % 100) < p3D * 100);
  const bucketPool = want3D ? pool3D : pool2D;
  const bucketKey = want3D ? 'last3D' : 'last2D';

  const engine = nextInBucket(bucketPool, state[bucketKey], seed);
  const name = path.basename(engine, '.html');
  writeRotationState({ ...state, [bucketKey]: name });
  if (reason) console.warn(`[index] ${reason} — using curated engine ${path.basename(engine)} (${want3D ? '3D' : '2D'} bucket).`);
  return { engine, source: `curated:${name}` };
}

// Decide which engine to render:
//   1. explicit --engine wins (with Bloom fallback if the path is missing);
//   2. otherwise, if GEMINI_API_KEY is set and generation isn't disabled, ask
//      Gemini for today's engine and run it through the quality gate — on any
//      failure, fall back to Bloom;
//   3. otherwise, Bloom.
async function chooseEngine(cli, imageInfo) {
  const seed = cli.seed ?? (process.env.SEED || defaultSeedStr());

  if (cli.engine) {
    const requested = path.isAbsolute(cli.engine) ? cli.engine : path.resolve(repoRoot, cli.engine);
    if (existsSync(requested)) return { engine: requested, source: 'explicit' };
    return curatedOr(`requested engine not found (${requested})`, seed);
  }

  const generateEnabled = !!process.env.GEMINI_API_KEY
    && cli['no-generate'] !== true
    && process.env.GENERATE !== '0';

  if (!generateEnabled) {
    return curatedOr(process.env.GEMINI_API_KEY ? null : 'no GEMINI_API_KEY', seed);
  }

  const validateOpts = { seed: Number(String(seed).replace(/\D/g, '')) || 1 };
  const genOpts = { seed, imageInfo };

  try {
    const gen = await generateEngine(genOpts);
    console.log('[index] validating generated engine…');
    let result = await validateEngine(gen.path, validateOpts);
    if (result.ok) {
      console.log(`[index] generated engine passed (peakStd=${result.stats.peakStd.toFixed(1)}, motion=${result.stats.motion.toFixed(1)}, ${result.stats.avgMsPerFrame}ms/frame, ~${result.stats.projectedHourRenderMin}min for 1h).`);
      return {
        engine: gen.path, source: 'gemini', themeHint: gen.themeHint, date: gen.date,
      };
    }

    // One repair attempt: hand the validator's reasons + the previous file
    // back to Gemini and ask for a fix. imageInfo (via genOpts) is the same
    // object as the first attempt, so generateEngine() derives the
    // identical theme/dimension again -- no special reuse needed, since
    // both are now pure functions of imageInfo/seed rather than a
    // stateful rotation cursor.
    console.warn(`[index] first attempt failed: ${result.reasons.join('; ')}`);
    await logEngineSnippet('first attempt', gen.path);
    console.log('[index] asking Gemini to repair…');
    const previousHtml = await readFile(gen.path, 'utf8');
    const gen2 = await generateEngine({
      ...genOpts,
      repair: { previousHtml, reasons: result.reasons },
    });
    result = await validateEngine(gen2.path, validateOpts);
    if (result.ok) {
      console.log(`[index] repaired engine passed (peakStd=${result.stats.peakStd.toFixed(1)}, motion=${result.stats.motion.toFixed(1)}, ${result.stats.avgMsPerFrame}ms/frame, ~${result.stats.projectedHourRenderMin}min for 1h).`);
      return {
        engine: gen2.path, source: 'gemini-repaired', themeHint: gen2.themeHint, date: gen2.date,
      };
    }
    await logEngineSnippet('repair attempt', gen2.path);
    return curatedOr(`generated engine failed validation after repair: ${result.reasons.join('; ')}`, seed);
  } catch (e) {
    return curatedOr(`generation error: ${e.message}`, seed);
  }
}

// Match render.js's default per-day seed (YYYYMMDD, UTC) so the curated
// rotation and the render agree when no seed is supplied.
function defaultSeedStr() {
  const d = new Date();
  return String(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate());
}

// Diagnostic aid for validation failures: engines/auto/*.html is git-ignored
// (ephemeral per-run) and only otherwise preserved as a CI artifact, which
// some sandboxed dev environments cannot download (network policy blocks
// the artifact blob-storage host). Logging a snippet directly into the job
// log means a failure is debuggable from `get_job_logs` alone, no artifact
// access needed. Kept short so it doesn't bloat every log -- this is a
// diagnostic breadcrumb, not a full dump.
//
// A recurring failure signature ("locally blown out to white" + "near-zero
// motion" together -- consistent with the canvas rendering something bad
// once and then effectively freezing, not a slow drift) turned out to be
// undiagnosable from just the file's first 500 chars: that's always the
// boilerplate URL-param/canvas-setup header, never the actual draw loop
// where a bug like this would live. Also capture a window of context
// around the REAL advanceFrame assignment (distinguished from an earlier
// placeholder like "window.advanceFrame = null;" by matching an actual
// function/arrow assignment), which is far more likely to contain the bug.
async function logEngineSnippet(label, htmlPath) {
  try {
    const html = await readFile(htmlPath, 'utf8');
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    const script = scriptMatch ? scriptMatch[1] : html;
    const suspiciousPatterns = ['getContext(\'webgl', 'getContext("webgl', 'white', 'rgba(255,255,255', '#fff', '#FFF'];
    const found = suspiciousPatterns.filter((p) => script.includes(p));

    console.log(`[index] ${label} head (first 300 chars of script):\n${script.slice(0, 300)}`);

    const assignMatches = script.match(/advanceFrame\s*=\s*(?:function|\()/g);
    const anchorText = assignMatches ? assignMatches[assignMatches.length - 1] : 'advanceFrame';
    const anchor = script.lastIndexOf(anchorText);
    if (anchor >= 0) {
      const start = Math.max(0, anchor - 100);
      const region = script.slice(start, start + 1400);
      console.log(`[index] ${label} render-loop region (near advanceFrame):\n${region}`);
    } else {
      console.log(`[index] ${label} could not locate "advanceFrame" anywhere in the script (${script.length} chars total) -- likely missing entirely.`);
    }

    console.log(`[index] ${label} suspicious tokens present: ${found.length ? found.join(', ') : '(none)'}`);
  } catch (e) {
    console.warn(`[index] could not log ${label} snippet: ${e.message}`);
  }
}

function slugify(s, maxLen = 40) {
  const slug = String(s || 'engine').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'engine').slice(0, maxLen).replace(/-+$/g, '');
}

// Standing requirement (user-stated): every video should be genuinely new,
// not just "not an exact repeat." Beyond rotating the fixed pool of
// hand-written curated engines and Gemini theme hints (see CLAUDE.md), the
// combinatorial space itself grows every day this runs: any Gemini engine
// that passes the SAME quality gate used to approve it for today's actual
// published video also gets copied into the permanent curated pool
// (engines/manual/), so it becomes available as a fallback option on any
// future day Gemini fails or is disabled -- engines x themes x palettes x
// seeds compounds daily instead of staying fixed at 6 hand-written engines.
// Not gated on "first attempt only" -- if it was good enough to publish
// today, it's good enough to be a future fallback candidate, same bar.
async function promoteToCuratedPool(enginePath, themeHint, date) {
  const destName = `auto-${date}-${slugify(themeHint)}.html`;
  const destPath = path.join(MANUAL_DIR, destName);
  await copyFile(enginePath, destPath);
  console.log(`[index] promoted today's Gemini engine to the curated pool: engines/manual/${destName}`);
  return destPath;
}

// Novelty gate on promotion (2026-08-25). promoteToCuratedPool() used to
// admit anything that passed validate.js -- but validate.js scores an engine
// in ISOLATION against absolute thresholds and has no cross-engine
// comparison at all, so a Gemini engine that merely re-renders an existing
// curated composition passed cleanly and became a permanent pool member.
// That is not hypothetical: auto-2026-08-12-radial-mandala-built-from-
// straight-line was admitted this way and measured 0.546 from
// kaleidoscope -- a near-duplicate, and the closest pair in the whole pool
// (next-closest unrelated pair 0.674, median 1.263). It was removed and this
// gate added, because deleting the one file does nothing to stop the next
// one. Same lesson as the earlier "too white" incident: when a promoted
// engine turns out bad, the fix belongs in the gate so it can't recur for
// ANY engine.
//
// Reads precomputed fingerprints from state/engine-fingerprints.json
// (refresh with `node scripts/analyze-pool.js`) so a production run only
// has to fingerprint the ONE new candidate (~20s) rather than re-render the
// whole pool.
//
// FAILS CLOSED: if the cache is missing/unusable or fingerprinting throws,
// promotion is skipped rather than allowed. Promotion is entirely optional
// -- the day's video still renders and publishes either way -- so declining
// to grow the pool is strictly cheaper than admitting an unverified engine.
const FINGERPRINT_CACHE_PATH = path.join(repoRoot, 'state', 'engine-fingerprints.json');
const MIN_NOVELTY_DISTANCE = 0.60;

async function noveltyDistance(enginePath) {
  const cache = JSON.parse(readFileSync(FINGERPRINT_CACHE_PATH, 'utf8'));
  const names = Object.keys(cache.vectors || {});
  if (names.length < 3) throw new Error(`fingerprint cache has only ${names.length} entries`);
  const candidate = await fingerprintEngine(enginePath);
  const { z } = zscoreMatrix([...names.map((n) => cache.vectors[n]), candidate]);
  const cz = z[z.length - 1];
  let nearest = null, best = Infinity;
  for (let i = 0; i < names.length; i++) {
    const d = distance(cz, z[i]);
    if (d < best) { best = d; nearest = names[i]; }
  }
  return { nearest, distance: best };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const dryRun = cli['no-upload'] === true || process.env.DRY_RUN === '1';

  console.log(`[index] === daily run ${new Date().toISOString()} ===`);

  // Fetch today's NASA APOD image ONCE, up front -- it now drives BOTH
  // Gemini's creative theme (imageThemeHint() in generate.js, replacing the
  // old round-robin theme-hint list -- see CLAUDE.md/generate.js for why)
  // and curated-engine recoloring below, instead of being fetched twice for
  // two separate purposes. Non-fatal: imageInfo stays null on any failure
  // and both consumers degrade gracefully (Gemini falls back to a generic
  // "invent your own" instruction; curated engines keep their built-in
  // palette).
  const wantImage = process.env.IMAGE_PALETTE !== '0' && cli['no-image'] !== true;
  let imageInfo = null;
  if (wantImage) {
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      imageInfo = await dailyImagePalette({ date: dateStr });
      if (!imageInfo) console.log('[index] no image available today (APOD not an image, or fetch failed).');
    } catch (e) {
      console.warn(`[index] image fetch skipped: ${e.message}`);
    }
  }

  const { engine, source, themeHint, date } = await chooseEngine(cli, imageInfo);
  const engineName = path.basename(engine, '.html');

  // Resolve config once so render + metadata agree on seed/duration.
  const cfg = resolveConfig({ ...cli, engine });

  console.log(`[index] engine=${engineName} (${source}) seed=${cfg.seed} duration=${cfg.duration}s upload=${!dryRun}`);

  // Grow the curated pool from today's approved Gemini engine (see
  // promoteToCuratedPool for why). Skipped on dry runs so ad-hoc/test
  // invocations don't leave permanent files behind, and skippable via
  // --no-promote / PROMOTE_ENGINES=0 as an escape hatch.
  const promoteEnabled = process.env.PROMOTE_ENGINES !== '0' && cli['no-promote'] !== true;
  if (!dryRun && promoteEnabled && source.startsWith('gemini')) {
    try {
      // Novelty gate first -- see noveltyDistance() for why validate.js
      // passing is not sufficient grounds to admit an engine permanently.
      const nov = await noveltyDistance(engine);
      if (nov.distance < MIN_NOVELTY_DISTANCE) {
        console.warn(`[index] NOT promoting: too similar to ${nov.nearest} `
          + `(novelty ${nov.distance.toFixed(3)} < ${MIN_NOVELTY_DISTANCE}). `
          + `Today's video still ships; the pool just doesn't gain a near-duplicate.`);
      } else {
        console.log(`[index] novelty ok: ${nov.distance.toFixed(3)} from nearest (${nov.nearest}).`);
        await promoteToCuratedPool(engine, themeHint, date);
      }
    } catch (e) {
      // Fail closed -- skip promotion rather than admit an unverified engine.
      console.warn(`[index] skipping promotion (novelty check unavailable): ${e.message}`);
    }
  }

  // Recolor curated engines from the same already-fetched NASA image (see
  // the fetch near the top of main()). Only for curated engines -- Gemini
  // engines generate their own colours. An explicit --colors/COLORS
  // override always wins.
  const renderCli = { ...cli, engine };
  let imageCredit = null;
  const wantRecolor = imageInfo && !source.startsWith('gemini') && !cli.colors && !process.env.COLORS;
  if (wantRecolor) {
    renderCli.colors = encodeColors(imageInfo.colors);
    imageCredit = imageInfo;
    console.log(`[index] recolouring ${engineName} from ${imageInfo.source}: "${imageInfo.title}" (${imageInfo.colors.length} colours)`);
    // Structure (a low-res luminance grid sampled from the same image) is
    // only meaningful to engines that read the `lum` param (currently
    // composer.html) -- harmless no-op extra URL param for every other
    // engine, which just ignores params it doesn't know.
    if (imageInfo.structure) {
      renderCli.lum = encodeStructure(imageInfo.structure, imageInfo.gridW, imageInfo.gridH);
    }
  } else if (!imageInfo) {
    console.log('[index] no image palette today; using engine default palette.');
  }

  // Optional license-free (CC0) background music, fetched from Freesound.org
  // (src/stockMusic.js) rather than synthesized -- user request 2026-08-19,
  // "don't make music yourself, get a license free music somewhere".
  // Enabled/disabled by the same cfg.music flag render() itself would use
  // (--music=0 / MUSIC=0). Any failure is non-fatal: renderCli.musicTrackPath
  // just stays unset and render() ships the video silent, same as before
  // this feature existed.
  let musicCredit = null;
  if (cfg.music) {
    try {
      mkdirSync(cfg.outDir, { recursive: true });
      const dateStr = new Date().toISOString().slice(0, 10);
      const trackPath = path.join(cfg.outDir, 'stock-track.mp3');
      const track = await dailyStockTrack({ date: dateStr, seed: cfg.seed, destPath: trackPath });
      if (track) {
        renderCli.musicTrackPath = track.path;
        musicCredit = track;
        console.log(`[index] background music: "${track.title}" by ${track.username} (CC0, freesound.org)`);
      } else {
        console.log('[index] no stock music available today; video will be silent.');
      }
    } catch (e) {
      console.warn(`[index] stock music skipped: ${e.message}`);
    }
  }

  const renderResult = await render(renderCli);

  const metadata = buildMetadata({
    seed: cfg.seed,
    durationSec: cfg.duration,
    imageCredit,
    engineName,
    hasAudio: renderResult.hasAudio,
    musicCredit: renderResult.hasAudio ? musicCredit : null,
  });
  console.log(`[index] long title : ${metadata.long.title}`);
  console.log(`[index] short title: ${metadata.short.title}`);

  if (dryRun) {
    console.log('[index] DRY RUN — skipping upload. Outputs:');
    console.log(`        long : ${renderResult.long}`);
    console.log(`        short: ${renderResult.short}`);
    console.log(`        thumb: ${renderResult.thumbnail}`);
    return;
  }

  const uploaded = await uploadAll({
    longFile: renderResult.long,
    shortFile: renderResult.short,
    thumbnailFile: renderResult.thumbnail,
    metadata,
  });

  console.log('[index] uploaded:');
  if (uploaded.long) console.log(`        long : https://youtu.be/${uploaded.long.id}`);
  if (uploaded.short) console.log(`        short: https://youtu.be/${uploaded.short.id}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('[index] FAILED:', e.stack || e.message);
    process.exit(1);
  });
}

export { main };
