// Measure the curated pool's real visual diversity using src/fingerprint.js.
//
// Answers two questions nothing in this project could previously answer:
//   1. Which engines actually LOOK alike (as opposed to merely sharing a
//      filename-rotation bucket)?
//   2. How many perceptually distinct patterns can the pool actually show a
//      viewer -- the honest denominator behind "a new pattern every day"?
//
// Usage: node scripts/analyze-pool.js [--threshold=0.55] [--json=out.json]

import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintEngine, zscoreMatrix, distance, cluster, FEATURE_NAMES } from '../src/fingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const MANUAL_DIR = path.join(repoRoot, 'engines', 'manual');

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const THRESHOLD = Number(args.threshold ?? 0.55);

const files = readdirSync(MANUAL_DIR).filter((f) => f.endsWith('.html')).sort();
const names = files.map((f) => path.basename(f, '.html'));

console.log(`[analyze] fingerprinting ${files.length} engines (2 seeds x 3 frames each)...`);
const vectors = [];
for (let i = 0; i < files.length; i++) {
  const p = path.join(MANUAL_DIR, files[i]);
  try {
    const v = await fingerprintEngine(p);
    vectors.push(v);
    console.log(`  [${i + 1}/${files.length}] ${names[i]}`);
  } catch (e) {
    console.warn(`  [${i + 1}/${files.length}] ${names[i]} FAILED: ${e.message}`);
    vectors.push(new Array(FEATURE_NAMES.length).fill(0));
  }
}

const { z } = zscoreMatrix(vectors);

// Nearest neighbour per engine -- "what does this most look like?"
console.log('\n=== nearest neighbour (what each engine most resembles) ===');
const rows = [];
for (let i = 0; i < names.length; i++) {
  let best = -1, bestD = Infinity;
  for (let j = 0; j < names.length; j++) {
    if (i === j) continue;
    const d = distance(z[i], z[j]);
    if (d < bestD) { bestD = d; best = j; }
  }
  rows.push({ name: names[i], nearest: names[best], dist: bestD });
}
rows.sort((a, b) => a.dist - b.dist);
for (const r of rows) {
  const flag = r.dist < THRESHOLD ? '  <-- SIMILAR' : '';
  console.log(`  ${r.dist.toFixed(3)}  ${r.name}  ~  ${r.nearest}${flag}`);
}

// Closest pairs overall
console.log('\n=== closest pairs ===');
const pairs = [];
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) pairs.push({ a: names[i], b: names[j], d: distance(z[i], z[j]) });
}
pairs.sort((x, y) => x.d - y.d);
for (const p of pairs.slice(0, 8)) console.log(`  ${p.d.toFixed(3)}  ${p.a}  <->  ${p.b}`);

// Perceptual clusters
const groups = cluster(names, z, THRESHOLD);
console.log(`\n=== perceptual archetypes at threshold ${THRESHOLD} ===`);
console.log(`  ${files.length} engine files  ->  ${groups.length} distinct-looking groups`);
groups.sort((a, b) => b.length - a.length);
for (const g of groups) {
  console.log(`  [${g.length}] ${g.join(', ')}`);
}

// Persist fingerprints so the production promotion gate (noveltyDistance()
// in src/index.js) only has to fingerprint the ONE new candidate instead of
// re-rendering the whole pool on every daily run. Committed to the repo, so
// re-run this script whenever engines are added or removed.
const cachePath = path.join(repoRoot, 'state', 'engine-fingerprints.json');
const vectorMap = {};
names.forEach((n, i) => { vectorMap[n] = vectors[i].map((v) => Number(v.toFixed(6))); });
writeFileSync(cachePath, `${JSON.stringify({
  featureNames: FEATURE_NAMES,
  updatedAt: new Date().toISOString(),
  vectors: vectorMap,
}, null, 2)}\n`);
console.log(`\n[analyze] wrote fingerprint cache -> state/engine-fingerprints.json (${names.length} engines)`);

if (args.json) {
  writeFileSync(args.json, JSON.stringify({
    featureNames: FEATURE_NAMES, names, vectors, threshold: THRESHOLD,
    groups, nearest: rows,
  }, null, 2));
  console.log(`\n[analyze] wrote ${args.json}`);
}
