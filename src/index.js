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
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'dotenv/config';

import { render, resolveConfig } from './render.js';
import { buildMetadata } from './metadata.js';
import { uploadAll } from './upload.js';
import { generateEngine } from './generate.js';
import { validateEngine } from './validate.js';

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

function bloomOr(reason) {
  if (!existsSync(BLOOM)) throw new Error(`Bloom fallback missing at ${BLOOM}`);
  if (reason) console.warn(`[index] ${reason} — falling back to Bloom.`);
  return { engine: BLOOM, source: 'bloom' };
}

// Decide which engine to render:
//   1. explicit --engine wins (with Bloom fallback if the path is missing);
//   2. otherwise, if GEMINI_API_KEY is set and generation isn't disabled, ask
//      Gemini for today's engine and run it through the quality gate — on any
//      failure, fall back to Bloom;
//   3. otherwise, Bloom.
async function chooseEngine(cli) {
  if (cli.engine) {
    const requested = path.isAbsolute(cli.engine) ? cli.engine : path.resolve(repoRoot, cli.engine);
    if (existsSync(requested)) return { engine: requested, source: 'explicit' };
    return bloomOr(`requested engine not found (${requested})`);
  }

  const generateEnabled = !!process.env.GEMINI_API_KEY
    && cli['no-generate'] !== true
    && process.env.GENERATE !== '0';

  if (!generateEnabled) {
    return bloomOr(process.env.GEMINI_API_KEY ? null : 'no GEMINI_API_KEY');
  }

  const seed = cli.seed ?? (process.env.SEED || undefined);
  const validateOpts = seed ? { seed: Number(seed) } : {};
  const genOpts = seed ? { seed } : {};

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
    return bloomOr(`generated engine failed validation after repair: ${result.reasons.join('; ')}`);
  } catch (e) {
    return bloomOr(`generation error: ${e.message}`);
  }
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

  const renderResult = await render({ ...cli, engine });

  const metadata = buildMetadata({
    seed: cfg.seed,
    durationSec: cfg.duration,
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
