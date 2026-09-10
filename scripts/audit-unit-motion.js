// Audit: how much of each engine's frame-to-frame motion is NOT explained by
// one rigid transform of the whole frame (rotation about the centre plus a
// translation). A pattern that only spins or scrolls as a rigid block scores
// ~0 residual no matter how fast it moves; a pattern whose basic units move
// relative to each other (pulse, sway, orbit, morph) leaves a residual the
// rigid fit cannot remove. User definition of "dynamic" (2026-09-10):
// "dynamic movements with the basic pattern units", not whole-pattern spin
// and not cutting to a different pattern.
//
//   node scripts/audit-unit-motion.js [engine.html ...]   (default: whole pool)
//
// Output per engine: raw = mean |frame(t+dt) - frame(t)| luma; rigid = best
// rigid-fit residual; nonRigidFrac = rigid / raw (0 = pure block motion,
// 1 = nothing rigid about it). Ranked by residual (absolute luma), the
// amount of genuinely unit-level motion.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureLuma } from '../src/fingerprint.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 160, H = 90;
const DT = 6; // frames apart at 24fps = 0.25s -- per-unit oscillation scale

function meanAbs(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

// Residual of b vs a warped by (theta about centre, dx, dy), nearest-neighbour.
function residual(a, b, theta, dx, dy) {
  const cx = (W - 1) / 2, cy = (H - 1) / 2, c = Math.cos(theta), s = Math.sin(theta);
  let sum = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const rx = x - cx - dx, ry = y - cy - dy;
    const sx = Math.round(cx + rx * c + ry * s), sy = Math.round(cy - rx * s + ry * c);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
    sum += Math.abs(b[y * W + x] - a[sy * W + sx]); n++;
  }
  return n ? sum / n : Infinity;
}

function bestRigid(a, b) {
  let best = Infinity, arg = null;
  for (let deg = -15; deg <= 15; deg += 1) for (let dx = -8; dx <= 8; dx += 2) for (let dy = -8; dy <= 8; dy += 2) {
    const r = residual(a, b, deg * Math.PI / 180, dx, dy);
    if (r < best) { best = r; arg = { deg, dx, dy }; }
  }
  // refine around the coarse optimum
  for (let deg = arg.deg - 1; deg <= arg.deg + 1; deg += 0.25) for (let dx = arg.dx - 1; dx <= arg.dx + 1; dx++) for (let dy = arg.dy - 1; dy <= arg.dy + 1; dy++) {
    const r = residual(a, b, deg * Math.PI / 180, dx, dy);
    if (r < best) { best = r; arg = { deg, dx, dy }; }
  }
  return { best, arg };
}

export async function auditEngine(enginePath, seed = 12345) {
  const starts = [240, 720, 1440];
  const frames = starts.flatMap((f) => [f, f + DT]);
  const { shots } = await captureLuma(enginePath, { seed, frames, sampleW: W, sampleH: H, width: 640, height: 360 });
  const pairs = [];
  for (let i = 0; i < shots.length; i += 2) {
    const a = shots[i].luma, b = shots[i + 1].luma;
    const raw = meanAbs(a, b);
    const { best, arg } = bestRigid(a, b);
    pairs.push({ raw, rigid: best, frac: raw > 0 ? best / raw : 0, fit: arg });
  }
  const avg = (k) => pairs.reduce((s, p) => s + p[k], 0) / pairs.length;
  return { name: path.basename(enginePath, '.html'), raw: avg('raw'), residual: avg('rigid'), nonRigidFrac: avg('frac'), pairs };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const files = args.length ? args : readdirSync(path.join(root, 'engines/manual')).filter((f) => f.endsWith('.html')).sort().map((f) => path.join(root, 'engines/manual', f));
  const rows = [];
  for (const f of files) {
    try { const r = await auditEngine(f); rows.push(r); console.error(`${r.name.padEnd(60)} raw ${r.raw.toFixed(1).padStart(5)}  residual ${r.residual.toFixed(1).padStart(5)}  nonRigid ${(r.nonRigidFrac * 100).toFixed(0).padStart(3)}%`); }
    catch (e) { console.error(`${path.basename(f)}: FAILED ${e.message.split('\n')[0]}`); }
  }
  rows.sort((a, b) => a.residual - b.residual);
  console.log('\nRanked by unit-level (non-rigid) motion, least dynamic first:');
  for (const r of rows) console.log(`${r.residual.toFixed(1).padStart(6)}  ${(r.nonRigidFrac * 100).toFixed(0).padStart(3)}%  raw ${r.raw.toFixed(1).padStart(5)}  ${r.name}`);
}
