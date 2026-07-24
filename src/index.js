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
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'dotenv/config';

import { render, resolveConfig } from './render.js';
import { buildMetadata } from './metadata.js';
import { uploadAll } from './upload.js';
import { generateEngine } from './generate.js';
import { validateEngine } from './validate.js';
import { dailyImagePalette, encodeColors } from './palette.js';

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

// Persisted rotation cursor for the curated pool (committed to git by the
// workflow after each run — see .github/workflows/daily.yml). Tracks the
// index of the NEXT curated engine to use whenever a fallback actually
// happens, independent of calendar date.
const ROTATION_STATE_PATH = path.join(repoRoot, 'state', 'engine-rotation.json');

function readRotationIndex() {
  try {
    const data = JSON.parse(readFileSync(ROTATION_STATE_PATH, 'utf8'));
    if (Number.isInteger(data.nextIndex) && data.nextIndex >= 0) return data.nextIndex;
  } catch { /* missing or corrupt state file -- caller bootstraps instead */ }
  return null;
}

function writeRotationIndex(nextIndex) {
  try {
    mkdirSync(path.dirname(ROTATION_STATE_PATH), { recursive: true });
    writeFileSync(
      ROTATION_STATE_PATH,
      `${JSON.stringify({ nextIndex, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (e) {
    console.warn(`[index] could not persist engine rotation state: ${e.message}`);
  }
}

// Fallback when Gemini isn't available or fails: pick the next curated
// engine in true round-robin order (persisted across runs), not a date-hash
// pick. A date-hash pick (previous approach: seed % pool.length) can
// coincidentally repeat the same engine on two different fallback days --
// this happened for real (2026-07-21 and 2026-07-24 both hashed to
// kaleidoscope, producing two visually-similar videos days apart even
// though Gemini succeeded on the days in between). Round-robin guarantees
// the whole pool cycles before any curated engine repeats, regardless of
// how many Gemini-generated days fall in between fallbacks. Falls back to
// Bloom only if the manual pool is somehow empty (should never happen in
// normal operation).
function curatedOr(reason, seed) {
  const pool = curatedPool();
  if (pool.length === 0) {
    if (!existsSync(BLOOM)) throw new Error(`No curated engines found (need engines/manual/*.html or engines/bloom.html)`);
    if (reason) console.warn(`[index] ${reason} — engines/manual/ is empty, using emergency Bloom fallback.`);
    return { engine: BLOOM, source: 'curated:bloom' };
  }
  let idx = readRotationIndex();
  if (idx === null || idx >= pool.length) {
    // No usable persisted state (first run ever, or pool size changed since
    // last persisted) -- bootstrap deterministically from the seed rather
    // than always starting at 0.
    const n = Number(String(seed).replace(/\D/g, '')) || 0;
    idx = n % pool.length;
  }
  const engine = pool[idx];
  writeRotationIndex((idx + 1) % pool.length);
  if (reason) console.warn(`[index] ${reason} — using curated engine ${path.basename(engine)}.`);
  return { engine, source: `curated:${path.basename(engine, '.html')}` };
}

// Decide which engine to render:
//   1. explicit --engine wins (with Bloom fallback if the path is missing);
//   2. otherwise, if GEMINI_API_KEY is set and generation isn't disabled, ask
//      Gemini for today's engine and run it through the quality gate — on any
//      failure, fall back to Bloom;
//   3. otherwise, Bloom.
async function chooseEngine(cli) {
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
  const genOpts = { seed };

  try {
    const gen = await generateEngine(genOpts);
    console.log('[index] validating generated engine…');
    let result = await validateEngine(gen.path, validateOpts);
    if (result.ok) {
      console.log(`[index] generated engine passed (peakStd=${result.stats.peakStd.toFixed(1)}, motion=${result.stats.motion.toFixed(1)}, ${result.stats.avgMsPerFrame}ms/frame, ~${result.stats.projectedHourRenderMin}min for 1h).`);
      return { engine: gen.path, source: 'gemini' };
    }

    // One repair attempt: hand the validator's reasons + the previous file
    // back to Gemini and ask for a fix.
    console.warn(`[index] first attempt failed: ${result.reasons.join('; ')}`);
    console.log('[index] asking Gemini to repair…');
    const previousHtml = await readFile(gen.path, 'utf8');
    const gen2 = await generateEngine({
      ...genOpts,
      repair: { previousHtml, reasons: result.reasons },
    });
    result = await validateEngine(gen2.path, validateOpts);
    if (result.ok) {
      console.log(`[index] repaired engine passed (peakStd=${result.stats.peakStd.toFixed(1)}, motion=${result.stats.motion.toFixed(1)}, ${result.stats.avgMsPerFrame}ms/frame, ~${result.stats.projectedHourRenderMin}min for 1h).`);
      return { engine: gen2.path, source: 'gemini-repaired' };
    }
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

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const dryRun = cli['no-upload'] === true || process.env.DRY_RUN === '1';

  console.log(`[index] === daily run ${new Date().toISOString()} ===`);

  const { engine, source } = await chooseEngine(cli);
  const engineName = path.basename(engine, '.html');

  // Resolve config once so render + metadata agree on seed/duration.
  const cfg = resolveConfig({ ...cli, engine });

  console.log(`[index] engine=${engineName} (${source}) seed=${cfg.seed} duration=${cfg.duration}s upload=${!dryRun}`);

  // Optional "image of the day" palette (NASA APOD). Only for curated engines —
  // Gemini engines generate their own colours. Enabled when IMAGE_PALETTE!=0
  // and not an AI engine. Any failure is non-fatal (engine uses its own palette).
  const renderCli = { ...cli, engine };
  let imageCredit = null;
  const wantImagePalette = process.env.IMAGE_PALETTE !== '0'
    && cli['no-image'] !== true
    && !source.startsWith('gemini')
    && !cli.colors && !process.env.COLORS;
  if (wantImagePalette) {
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      const pal = await dailyImagePalette({ date: dateStr });
      if (pal && pal.colors) {
        renderCli.colors = encodeColors(pal.colors);
        imageCredit = pal;
        console.log(`[index] recolouring ${engineName} from ${pal.source}: "${pal.title}" (${pal.colors.length} colours)`);
      } else {
        console.log('[index] no image palette today; using engine default palette.');
      }
    } catch (e) {
      console.warn(`[index] image palette skipped: ${e.message}`);
    }
  }

  const renderResult = await render(renderCli);

  const metadata = buildMetadata({
    seed: cfg.seed,
    durationSec: cfg.duration,
    imageCredit,
    engineName,
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
