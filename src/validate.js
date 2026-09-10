// Phase 2 quality gate. Two phases:
//   1. VISUAL — load at a small test resolution, sample frames at evenly
//      spaced points across a representative timeline, and check that the
//      image is not stuck black, not blown out, spatially structured, and
//      actually animating.
//   2. SPEED — load at the planned render resolution and measure per-frame
//      wall time, rejecting engines that would not finish a 1-hour render
//      inside the CI job timeout.
//
// Each phase runs its own browser. Returns { ok, reasons, stats }; never
// throws for engine problems (only on internal failures like browser launch).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { frameFeatures, FEATURE_NAMES } from './fingerprint.js';

const DEFAULTS = {
  // Visual phase config — small canvas, longer virtual timeline so
  // accumulation-style engines (like Bloom) have time to develop.
  // 300s (5 simulated minutes) is long enough to span 2+ cycles for any
  // engine following the prompt's own "regenerate every 30-120s" guidance,
  // and long enough for the monotonic-growth check below to catch an engine
  // that never resets at all (a real production failure: a Gemini engine
  // accumulated for the full 3600s render with no reset and washed to white
  // partway through, while a 60s validation test never ran long enough to
  // reveal the trend). cycleSec is intentionally NOT forced — see
  // buildEngineUrl.
  visualWidth: 480,
  visualHeight: 270,
  visualFps: 24,
  visualDuration: 300,
  seed: 12345,
  readyTimeoutMs: 30000,
  minPeakMean: 1.5,
  maxPeakMean: 252,
  minPeakStd: 5,
  minMotion: 1.0,
  // Fraction (0-1) of sampled pixels allowed to be near-max brightness
  // (luma > 248) at any one sample. Catches shapes clipped to solid white
  // even when diluted by black background keeps the frame-wide average
  // (maxPeakMean, above) looking moderate -- see the check site for the
  // real incident this was calibrated against.
  maxNearWhiteFrac: 0.12,
  // Minimum average HSL saturation (0-100) among non-background,
  // non-blown-out pixels, at the WORST (lowest) sampled point. Standing
  // house-style rule is "vivid and clear, never pale/washed/pastel," but
  // nothing was actually measuring colour saturation -- an engine could
  // pass every other check while being grey/muddy/pastel the whole time.
  // Curated engines bake in 70-95% HSL saturation and pass comfortably;
  // this exists mainly to hold Gemini-generated engines to the same bar
  // numerically instead of relying on prompt wording alone.
  minAvgSat: 22,
  // The visual test window (visualDuration) is much shorter than a real
  // render. Fit a straight line through the sampled mean-brightness trend
  // and extrapolate it across a full production render; if the projected
  // rise is too large, reject even if no single sample looks blown out.
  // This catches "partial reset" engines too -- ones whose fade/clear isn't
  // strong enough to fully undo each cycle's accumulation, so brightness
  // dips periodically (defeating a strict "never dips" check) but still
  // climbs on net every cycle, washing to white by the end of a full hour
  // even though a short test window with a few dips looks fine. This is
  // exactly how a real production engine slipped through: it had periodic
  // fades that dipped brightness locally, so it wasn't flagged by a
  // no-dip-allowed rule, but the fades were too weak relative to the
  // accumulation rate and it was visibly mostly-white by ~56 of 60 minutes.
  productionDurationSec: 3600,
  maxProjectedRise: 50,
  // Short-interval ("is this actually moving right now") motion check.
  // The widely-spaced fraction samples above are tens of seconds apart --
  // fine for detecting long-term whiteout drift, but useless for catching
  // "technically animating but far too slow to read as exciting" (a real
  // complaint: full rotations taking 30-100+s are imperceptible moment to
  // moment). Sample a short burst of frames close together instead and
  // require the change to be a meaningful fraction of the frame's own
  // structure (peakStd), not a fixed pixel value, so it adapts to each
  // engine's contrast rather than needing a magic universal constant.
  fastMotionWindowSec: 1.5,
  minFastMotionAbs: 1.0,
  minFastMotionStdFrac: 0.12,

  // Unit-level motion check (2026-09-10). User, after seeing the first
  // multi-engine "journey" video: "that's not what I meant 'dynamic'.
  // Dynamic means here the video has dynamic movements with the basic
  // pattern units, dynamic doesn't mean completely different pattern
  // changes." Neither existing motion check can see this: fastMotion asks
  // "are pixels changing" and compositionDrift asks "does the arrangement
  // develop over minutes" -- a fixed arrangement spinning as one rigid
  // block satisfies the first and (with a wobble or lighting sweep) can
  // satisfy the second, while its basic units never move relative to each
  // other, which is exactly what read as lifeless. Measured as in
  // scripts/audit-unit-motion.js: two frames unitMotionWindowSec apart,
  // fit ONE rigid transform (rotation about the centre + translation) of
  // the whole frame, and look at what that fit cannot explain. Pure block
  // spin/scroll leaves almost nothing (measured 13-34% of the raw
  // difference across the pool's compute-once-and-rotate engines); units
  // that pulse, sway, orbit or morph relative to each other leave most of
  // it (74-100% on the pool's lively engines). Reject below
  // minUnitMotionNonRigidFrac. Only evaluated when there is enough raw
  // motion to measure (minUnitMotionRawAbs); a nearly static frame is
  // already caught by fastMotion.
  unitMotionWindowSec: 0.25,
  minUnitMotionNonRigidFrac: 0.40,
  minUnitMotionRawAbs: 1.0,

  // Composition-evolution check (2026-09-07). User request: make the videos
  // "more dynamic... more consistent visual changes which makes visually fun
  // to watch. dynamic doesn't necessarily means fast movement."
  //
  // The fastMotion check above only asks "are pixels changing RIGHT NOW",
  // which a fixed shape spinning in place satisfies completely. Nothing
  // asked the different question: does the COMPOSITION still evolve, or is
  // the viewer watching one frozen arrangement rotate for a full hour?
  // That gap was systemic, not accidental: the maxProjectedRise guard above
  // rejects engines whose coverage changes between cycles, so engine after
  // engine was written to compute its geometry ONCE per video and only spin
  // it afterwards (initTiling/initSpiral/initClusters/initDendrites/
  // initStrips/initRosette + a reconfigure*() that resets nothing but angle
  // and phase -- see CLAUDE.md). Each of those was individually correct and
  // collectively produced a pool of videos that stop developing after the
  // first few seconds.
  //
  // Measured with the rotation-invariant SUBSET of fingerprint.js's
  // descriptor (see DRIFT_FEATURES below -- most of that descriptor is NOT
  // rotation-invariant, and using all of it measured spin instead of
  // change), so a fixed arrangement that merely spins scores near the floor
  // while genuine structural change scores high. That is exactly the
  // distinction between "fast movement" and "visual change". Costs no extra
  // rendering: it reuses the luma grids the fraction samples already
  // captured for the brightness trend.
  //
  // Calibrated against a synthetic frozen fixture (a fixed arrangement that
  // does nothing but rotate, deliberately vivid and fast so the ONLY thing
  // wrong with it is that it never develops): the fixture measures
  // 0.0107-0.0127 across seeds, and real engines sit above it, with the
  // closest passing engine (ziggurat) at 0.0181-0.0398. 0.015 sits in that
  // gap. Deliberately set to catch the genuinely FROZEN rather than to
  // demand high dynamism: this gate runs on every Gemini engine daily, and
  // over-tightening it would just push more days onto the curated fallback
  // pool, which is itself the main driver of "I keep seeing the same
  // pattern" (see CLAUDE.md).
  minCompositionDrift: 0.015,

  // Speed phase config — real render resolution.
  speedWidth: 1920,
  speedHeight: 1080,
  speedFps: 24,
  speedDuration: 60,
  speedFrames: 40,                 // how many frames to measure
  maxAvgMsPerFrame: 100,           // budget: 100ms × 86,400 frames ≈ 144 min for 1h
  maxSingleFrameMs: 2000,          // any single frame this slow = catastrophic
  maxTotalSpeedTestMs: 45000,      // total wall-time cap on the speed test
};

const PUPPETEER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'];

// In-page: downscale the engine canvas to 64xH and return luma stats + a small
// luma array (for temporal diffing across samples).
function frameStats(selector) {
  const c = document.querySelector(selector);
  if (!c) return null;
  const sw = 64, sh = Math.max(1, Math.round(64 * (c.height / c.width)) || 36);
  const off = document.createElement('canvas');
  off.width = sw; off.height = sh;
  const o = off.getContext('2d');
  o.drawImage(c, 0, 0, sw, sh);
  const d = o.getImageData(0, 0, sw, sh).data;
  const n = sw * sh;
  const luma = new Array(n);
  let sum = 0;
  // Colourfulness ("is this actually vivid, not grey/pastel") is measured
  // separately from luma: HSL saturation of pixels that are neither
  // near-black nor near-white -- background and blown-out highlights have
  // no meaningful hue, so including them would just dilute the signal
  // toward "looks fine" regardless of how washed-out the actual coloured
  // shapes are.
  let satSum = 0;
  let satCount = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    luma[p] = l; sum += l;
    if (l > 20 && l < 235) {
      const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
      const lNorm = (max + min) / 2;
      const delta = max - min;
      const sat = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lNorm - 1));
      satSum += sat; satCount++;
    }
  }
  const mean = sum / n;
  let varAcc = 0;
  let nearWhite = 0;
  for (let p = 0; p < n; p++) {
    const dv = luma[p] - mean; varAcc += dv * dv;
    if (luma[p] > 248) nearWhite++;
  }
  return {
    mean,
    std: Math.sqrt(varAcc / n),
    luma,
    // Grid dimensions travel with the samples so callers (compositionDrift)
    // don't have to re-derive them from the canvas aspect ratio.
    w: sw,
    h: sh,
    nearWhiteFrac: nearWhite / n,
    avgSat: satCount > 0 ? (satSum / satCount) * 100 : 0,
  };
}

// In-page: luminance of the canvas at a reduced size (for the unit-motion
// rigid fit, which wants more resolution than frameStats' 64x36).
function frameLuma(selector, w, h) {
  const c = document.querySelector(selector);
  if (!c) return null;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const o = off.getContext('2d');
  o.drawImage(c, 0, 0, w, h);
  const d = o.getImageData(0, 0, w, h).data;
  const out = new Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) out[p] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return out;
}

// Residual of b against a warped by one rigid transform (rotation about the
// frame centre plus a translation), nearest-neighbour. Same construction as
// scripts/audit-unit-motion.js so the two agree on what "rigid" means.
function rigidResidual(a, b, w, h, theta, dx, dy) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2, c = Math.cos(theta), s = Math.sin(theta);
  let sum = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const rx = x - cx - dx, ry = y - cy - dy;
    const sx = Math.round(cx + rx * c + ry * s), sy = Math.round(cy - rx * s + ry * c);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    sum += Math.abs(b[y * w + x] - a[sy * w + sx]); n++;
  }
  return n ? sum / n : Infinity;
}

// { raw, residual, nonRigidFrac }: how much of the change between two
// frames is NOT one rigid motion of the whole frame. Coarse search then a
// local refinement; identity is always a candidate so residual <= raw.
function unitMotion(a, b, w, h) {
  if (!a || !b) return null;
  const raw = meanAbsDiff(a, b);
  let best = raw, arg = { deg: 0, dx: 0, dy: 0 };
  for (let deg = -15; deg <= 15; deg += 1) for (let dx = -8; dx <= 8; dx += 2) for (let dy = -8; dy <= 8; dy += 2) {
    const r = rigidResidual(a, b, w, h, deg * Math.PI / 180, dx, dy);
    if (r < best) { best = r; arg = { deg, dx, dy }; }
  }
  for (let deg = arg.deg - 1; deg <= arg.deg + 1; deg += 0.25) for (let dx = arg.dx - 1; dx <= arg.dx + 1; dx++) for (let dy = arg.dy - 1; dy <= arg.dy + 1; dy++) {
    const r = rigidResidual(a, b, w, h, deg * Math.PI / 180, dx, dy);
    if (r < best) { best = r; arg = { deg, dx, dy }; }
  }
  return { raw, residual: best, nonRigidFrac: raw > 0 ? best / raw : 0 };
}

// How much an engine's COMPOSITION changes across the sampled timeline,
// as opposed to how much it moves. Uses fingerprint.js's frameFeatures --
// built to survive rotation and cycle phase (see its own header), which is
// precisely what separates "a fixed arrangement spinning" from "the
// arrangement itself developing".
//
// ONLY the rotation-invariant features, and this list is load-bearing: a
// synthetic fixture (a fixed arrangement that does nothing but spin) scored
// 0.022 when every bounded feature was used -- HIGHER than real evolving
// engines like quasicrystal (0.0139) -- because most of the descriptor is
// not rotation-invariant at all. mirrorLR/mirrorUD are symmetry about fixed
// SCREEN axes, orient0..7 is a gradient-orientation histogram whose bins
// rotate with the image, and periodX/periodY are axis-aligned. Including
// them measured rotation, i.e. exactly the thing this check must ignore.
// What is left is invariant under rotation about the frame centre:
//   radial0..5     mass profile by radius
//   coverage       fraction of the frame lit
//   edgeDensity    fraction of pixels on an edge
//   angularUneven  spread of mass across angles (a std over ALL angles)
//   rotSym2..8     polar autocorrelation over angular shifts
//   largestBlobFrac  share of lit area in the biggest connected shape
// blobCount/blobSizeCV are rotation-invariant too but are a raw count and
// an unbounded ratio, so they would dominate a plain mean-absolute-diff;
// every feature kept below is bounded ~0..1, which makes the result an
// ABSOLUTE number comparable across engines.
//
// Deliberately NOT z-scored across the samples either: normalising by an
// engine's own variance rescales a nearly-frozen engine's noise up to look
// identical to a genuinely evolving one (the first version of this
// measurement did exactly that, and reported every engine as equally
// dynamic).
const DRIFT_FEATURES = new Set([
  'rotSym2', 'rotSym3', 'rotSym4', 'rotSym5', 'rotSym6', 'rotSym8',
  'radial0', 'radial1', 'radial2', 'radial3', 'radial4', 'radial5',
  'angularUneven', 'edgeDensity', 'coverage', 'largestBlobFrac',
]);
const DRIFT_FEATURE_IDX = FEATURE_NAMES
  .map((n, i) => (DRIFT_FEATURES.has(n) ? i : -1))
  .filter((i) => i >= 0);

function compositionDrift(lumaGrids, w, h) {
  const usable = lumaGrids.filter((g) => Array.isArray(g) || ArrayBuffer.isView(g));
  if (usable.length < 2) return null;
  let feats;
  try {
    feats = usable.map((g) => frameFeatures(g, w, h));
  } catch {
    return null; // never fail a render over a diagnostic
  }
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < feats.length; i++) {
    for (let j = i + 1; j < feats.length; j++) {
      let d = 0;
      for (const k of DRIFT_FEATURE_IDX) d += Math.abs(feats[i][k] - feats[j][k]);
      sum += d / DRIFT_FEATURE_IDX.length;
      pairs++;
    }
  }
  return pairs > 0 ? sum / pairs : null;
}

function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// Least-squares slope of y over x (luma per second, here).
function linRegSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? 0 : num / den;
}

function buildEngineUrl(enginePath, { seed, width, height, fps, duration, cycleSec }) {
  const url = pathToFileURL(enginePath);
  const p = url.searchParams;
  p.set('seed', String(seed));
  p.set('width', String(width));
  p.set('height', String(height));
  p.set('fps', String(fps));
  p.set('duration', String(duration));
  // Deliberately do NOT force a cycleSec here unless explicitly given.
  // Production (render.js/index.js) never sets cycleSec either — it lets
  // each engine use its own internal default. If validation forced a short
  // cycleSec (e.g. 30s) it could hide a real production failure: an engine
  // whose actual default cycle is much longer (or that never resets at all)
  // would look fine under a forced-short cycle but still saturate to white
  // over a full 1-hour render. Testing with the engine's real default keeps
  // validation honest about what will actually ship.
  if (cycleSec !== undefined && cycleSec !== null && cycleSec !== '') {
    p.set('cycleSec', String(cycleSec));
  }
  return url.href;
}

async function setupPage(browser, width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  return { page, pageErrors };
}

async function loadAndReady(page, url, readyTimeoutMs) {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: readyTimeoutMs });
  } catch (e) { return { ok: false, reason: `page failed to load: ${e.message}` }; }
  try {
    await page.waitForFunction('window.READY === true', { timeout: readyTimeoutMs });
  } catch { return { ok: false, reason: 'window.READY never became true' }; }
  const api = await page.evaluate(() => ({
    total: window.TOTAL_FRAMES,
    hasAdvance: typeof window.advanceFrame === 'function',
    hasAdvanceN: typeof window.advanceFrames === 'function',
    hasCanvas: !!document.querySelector('canvas'),
  }));
  if (!api.hasCanvas) return { ok: false, reason: 'no <canvas> element' };
  if (!api.hasAdvance) return { ok: false, reason: 'window.advanceFrame is not a function' };
  if (!Number.isFinite(api.total) || api.total <= 0) return { ok: false, reason: `invalid TOTAL_FRAMES: ${api.total}` };
  return { ok: true, api };
}

// ---- Visual phase -----------------------------------------------------------

async function runVisual(enginePath, cfg) {
  const reasons = [];
  const url = buildEngineUrl(enginePath, {
    seed: cfg.seed, width: cfg.visualWidth, height: cfg.visualHeight,
    fps: cfg.visualFps, duration: cfg.visualDuration,
  });
  const browser = await puppeteer.launch({ headless: true, args: PUPPETEER_ARGS });
  try {
    const { page, pageErrors } = await setupPage(browser, cfg.visualWidth, cfg.visualHeight);
    const ready = await loadAndReady(page, url, cfg.readyTimeoutMs);
    if (!ready.ok) {
      reasons.push(ready.reason);
      if (pageErrors.length) reasons.push(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
      return { ok: false, reasons, stats: null };
    }

    // Sample at later fractions so accumulation-style engines have time to
    // bloom, with enough points spread across the whole window to detect a
    // "still rising, never reset" trend (see maxUnresetRise check below).
    const total = ready.api.total;
    const fractions = [0.08, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.98];
    const targets = fractions.map((f) => Math.max(1, Math.min(total, Math.round(total * f))));

    const samples = [];
    let cur = 0;
    for (const target of targets) {
      const step = target - cur;
      if (step > 0) {
        await page.evaluate((n) => window.advanceFrames(n), step);
        cur = target;
      }
      const stat = await page.evaluate(frameStats, 'canvas');
      if (!stat) { reasons.push('could not read canvas pixels'); break; }
      samples.push(stat);
    }

    if (pageErrors.length) reasons.push(`page errors during render: ${pageErrors.slice(0, 3).join(' | ')}`);
    if (samples.length < 2) {
      reasons.push('not enough samples captured');
      return { ok: false, reasons, stats: null };
    }

    const means = samples.map((s) => s.mean);
    const stds = samples.map((s) => s.std);
    const peakMean = Math.max(...means);
    const peakStd = Math.max(...stds);
    const peakNearWhiteFrac = Math.max(...samples.map((s) => s.nearWhiteFrac));
    // Mean (not worst-sample) across the window -- an engine with periodic
    // hard resets can legitimately have a near-black, low-saturation frame
    // right at a reset instant; averaging avoids a single unlucky sample
    // timing coincidence failing an otherwise-vivid engine.
    const avgSat = samples.reduce((a, s) => a + s.avgSat, 0) / samples.length;
    let motion = 0;
    for (let i = 1; i < samples.length; i++) {
      motion = Math.max(motion, meanAbsDiff(samples[i].luma, samples[i - 1].luma));
    }

    if (peakMean < cfg.minPeakMean) reasons.push(`image stays near-black (peak mean luma ${peakMean.toFixed(2)})`);
    if (peakMean > cfg.maxPeakMean) reasons.push(`image is blown out to white (peak mean luma ${peakMean.toFixed(2)})`);
    if (peakStd < cfg.minPeakStd) reasons.push(`image lacks spatial structure (peak std ${peakStd.toFixed(2)})`);
    if (motion < cfg.minMotion) reasons.push(`little/no motion between frames (max diff ${motion.toFixed(2)})`);
    if (avgSat < cfg.minAvgSat) {
      reasons.push(
        `colors read as pale/washed/grey rather than vivid (average saturation ${avgSat.toFixed(1)}, `
        + `need >= ${cfg.minAvgSat}) — house style requires punchy, saturated color, not pastel`,
      );
    }
    // Catches shapes that are individually clipped to solid white even when
    // the FRAME-WIDE average looks moderate -- a real engine slipped
    // through here: additively-overlapping cube faces blew out to solid
    // white blobs from frame 1 (not a drift), but plenty of black
    // background between the sparse blobs diluted the frame average to a
    // passing ~140/255, and peak std stayed high (black bg + white blobs is
    // still "structured"). Measures the fraction of sampled pixels that are
    // near-max brightness directly, independent of the rest of the frame.
    if (peakNearWhiteFrac > cfg.maxNearWhiteFrac) {
      reasons.push(
        `shapes are locally blown out to solid white: ${(peakNearWhiteFrac * 100).toFixed(1)}% of sampled `
        + `pixels are near-max brightness (>${cfg.maxNearWhiteFrac * 100}% threshold), even though the `
        + `frame-wide average may look moderate — reads as washed-out clipped shapes, not vivid saturated color`,
      );
    }

    // Trend-based "will this whiteout over a full render" detector. Fit a
    // straight line through the sampled means (vs. their real-world sample
    // time within visualDuration) and extrapolate across a full production
    // render. Using a fitted trend instead of a strict "never dips" rule
    // catches partial-reset engines too: a fade/clear that's too weak to
    // fully undo a cycle's accumulation still produces small periodic dips
    // (which would satisfy a naive no-dip check) while the brightness climbs
    // on net every cycle -- exactly how a real engine slipped through
    // validation and was still visibly mostly-white by ~56 of 60 minutes in
    // production.
    const times = fractions.slice(0, samples.length).map((f) => f * cfg.visualDuration);
    const slopePerSec = linRegSlope(times, means);
    const projectedRise = slopePerSec * cfg.productionDurationSec;
    if (projectedRise > cfg.maxProjectedRise) {
      reasons.push(
        `brightness trend extrapolates to a ${projectedRise.toFixed(1)} luma-level rise over a full `
        + `${cfg.productionDurationSec}s render (fit from an ${cfg.visualDuration}s test window, `
        + `slope ${slopePerSec.toFixed(3)} luma/s) — net upward drift even allowing for partial dips `
        + `along the way, which predicts whiteout over the full render length`,
      );
    }

    // Short-interval ("is this actually moving right now") motion check.
    // The fraction samples above are tens of seconds apart -- fine for the
    // whiteout trend, useless for "technically animating but far too slow to
    // read as exciting" (a real complaint: full rotations taking 30-100+s
    // are imperceptible moment to moment). Sample a tight burst near the
    // middle of the timeline instead, and require the change to be a
    // meaningful fraction of the frame's own structure (peakStd) rather than
    // a fixed pixel value, so it adapts to each engine's own contrast.
    const midTarget = Math.max(1, Math.min(total, Math.round(total * 0.5)));
    if (cur < midTarget) {
      await page.evaluate((n) => window.advanceFrames(n), midTarget - cur);
      cur = midTarget;
    }
    const burstFrames = Math.max(1, Math.round(cfg.visualFps * cfg.fastMotionWindowSec));
    const burstBefore = await page.evaluate(frameStats, 'canvas');
    await page.evaluate((n) => window.advanceFrames(n), burstFrames);
    const burstAfter = await page.evaluate(frameStats, 'canvas');
    const fastMotion = meanAbsDiff(burstBefore?.luma, burstAfter?.luma);
    const fastMotionFloor = Math.max(cfg.minFastMotionAbs, peakStd * cfg.minFastMotionStdFrac);
    if (fastMotion < fastMotionFloor) {
      reasons.push(
        `motion is too slow to read as exciting: only ${fastMotion.toFixed(2)} luma diff over `
        + `${cfg.fastMotionWindowSec}s mid-timeline (need >= ${fastMotionFloor.toFixed(2)}, `
        + `${(cfg.minFastMotionStdFrac * 100).toFixed(0)}% of this frame's own structure) — `
        + `a viewer would perceive this as nearly static`,
      );
    }

    // Do the basic UNITS move relative to each other, or is all the motion
    // one rigid block? See minUnitMotionNonRigidFrac in DEFAULTS. Sampled
    // right after the burst above (same mid-timeline region), a short
    // window apart so a fast whole-frame spin still fits inside the rigid
    // search range.
    const umW = 160, umH = 90;
    const umFrames = Math.max(1, Math.round(cfg.visualFps * cfg.unitMotionWindowSec));
    const umBefore = await page.evaluate(frameLuma, 'canvas', umW, umH);
    await page.evaluate((n) => window.advanceFrames(n), umFrames);
    const umAfter = await page.evaluate(frameLuma, 'canvas', umW, umH);
    const um = unitMotion(umBefore, umAfter, umW, umH);
    if (um && um.raw >= cfg.minUnitMotionRawAbs && um.nonRigidFrac < cfg.minUnitMotionNonRigidFrac) {
      reasons.push(
        `the pattern's units do not move relative to each other: ${((1 - um.nonRigidFrac) * 100).toFixed(0)}% of the `
        + `frame-to-frame change over ${cfg.unitMotionWindowSec}s is explained by ONE rigid rotation/translation of the `
        + `whole frame (need at least ${(cfg.minUnitMotionNonRigidFrac * 100).toFixed(0)}% unexplained) — a fixed `
        + `arrangement spinning or scrolling as a block reads as lifeless; give the basic units their own motion `
        + `(travelling waves of scale/offset/rotation across units, per-unit spin, counter-rotating rings, morphing)`,
      );
    }

    // Does the composition actually DEVELOP over the timeline, or is it one
    // fixed arrangement spinning? See minCompositionDrift in DEFAULTS for
    // the full reasoning. Reuses the fraction samples' luma grids, so this
    // costs no extra rendering. Returns null (skipped, never a failure) if
    // the descriptor can't be computed -- a diagnostic must not be the thing
    // that loses a day's video.
    const drift = compositionDrift(
      samples.map((s) => s.luma),
      samples[0]?.w ?? 64,
      samples[0]?.h ?? 36,
    );
    if (drift !== null && drift < cfg.minCompositionDrift) {
      reasons.push(
        `the composition never develops: structural change of only ${drift.toFixed(4)} across the `
        + `${cfg.visualDuration}s timeline (need >= ${cfg.minCompositionDrift}) — measured with a `
        + `rotation-invariant descriptor, so this is NOT about speed: the arrangement itself is `
        + `frozen and merely spinning/scrolling in place, which reads as the same picture for the `
        + `whole hour. Make the composition itself evolve (see the prompt's EVOLVE OVER THE HOUR `
        + `section), not just move`,
      );
    }

    return {
      ok: reasons.length === 0,
      reasons,
      stats: {
        peakMean, peakStd, motion, total,
        avgSat: Number(avgSat.toFixed(1)),
        peakNearWhiteFrac: Number(peakNearWhiteFrac.toFixed(4)),
        slopePerSec: Number(slopePerSec.toFixed(4)),
        projectedRise: Number(projectedRise.toFixed(1)),
        fastMotion: Number(fastMotion.toFixed(2)),
        fastMotionFloor: Number(fastMotionFloor.toFixed(2)),
        compositionDrift: drift === null ? null : Number(drift.toFixed(4)),
        unitMotionResidual: um ? Number(um.residual.toFixed(2)) : null,
        unitMotionNonRigidFrac: um ? Number(um.nonRigidFrac.toFixed(3)) : null,
      },
    };
  } finally {
    if (browser.connected) await browser.close().catch(() => {});
  }
}

// ---- Speed phase ------------------------------------------------------------

async function runSpeed(enginePath, cfg) {
  const reasons = [];
  const url = buildEngineUrl(enginePath, {
    seed: cfg.seed, width: cfg.speedWidth, height: cfg.speedHeight,
    fps: cfg.speedFps, duration: cfg.speedDuration,
  });
  const browser = await puppeteer.launch({ headless: true, args: PUPPETEER_ARGS });
  try {
    const { page, pageErrors } = await setupPage(browser, cfg.speedWidth, cfg.speedHeight);
    const ready = await loadAndReady(page, url, cfg.readyTimeoutMs);
    if (!ready.ok) {
      reasons.push(ready.reason);
      if (pageErrors.length) reasons.push(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
      return { ok: false, reasons, stats: null };
    }

    const N = Math.min(cfg.speedFrames, ready.api.total);
    const t0 = Date.now();
    let worstFrameMs = 0;

    for (let i = 1; i <= N; i++) {
      const fs = Date.now();
      await page.evaluate(() => window.advanceFrame());
      const ms = Date.now() - fs;
      if (ms > worstFrameMs) worstFrameMs = ms;

      if (ms > cfg.maxSingleFrameMs) {
        reasons.push(`single frame too slow (${ms}ms > ${cfg.maxSingleFrameMs}ms) at ${cfg.speedWidth}x${cfg.speedHeight} — engine would never finish`);
        return { ok: false, reasons, stats: { worstFrameMs: ms, framesMeasured: i } };
      }
      if (Date.now() - t0 > cfg.maxTotalSpeedTestMs) {
        const avg = (Date.now() - t0) / i;
        reasons.push(`speed test exceeded ${cfg.maxTotalSpeedTestMs}ms after ${i} frames (avg ${avg.toFixed(0)}ms/frame)`);
        return { ok: false, reasons, stats: { avgMsPerFrame: Number(avg.toFixed(1)), framesMeasured: i, worstFrameMs } };
      }
    }

    const totalMs = Date.now() - t0;
    const avgMsPerFrame = totalMs / N;
    const projectedHourRenderMin = (avgMsPerFrame * 3600 * cfg.speedFps) / 60000;

    if (pageErrors.length) reasons.push(`page errors during speed test: ${pageErrors.slice(0, 3).join(' | ')}`);
    if (avgMsPerFrame > cfg.maxAvgMsPerFrame) {
      reasons.push(
        `too slow: ${avgMsPerFrame.toFixed(0)}ms/frame avg at ${cfg.speedWidth}x${cfg.speedHeight} `
        + `(>${cfg.maxAvgMsPerFrame}ms budget) — a 1h render would take ~${projectedHourRenderMin.toFixed(0)}min`,
      );
    }
    return {
      ok: reasons.length === 0,
      reasons,
      stats: {
        avgMsPerFrame: Number(avgMsPerFrame.toFixed(1)),
        worstFrameMs,
        projectedHourRenderMin: Number(projectedHourRenderMin.toFixed(1)),
        framesMeasured: N,
      },
    };
  } finally {
    if (browser.connected) await browser.close().catch(() => {});
  }
}

// ---- Public API -------------------------------------------------------------

export async function validateEngine(enginePath, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  if (!existsSync(enginePath)) {
    return { ok: false, reasons: [`engine file not found: ${enginePath}`], stats: null };
  }

  const visual = await runVisual(enginePath, cfg);
  if (!visual.ok) return { ok: false, reasons: visual.reasons, stats: visual.stats };

  const speed = await runSpeed(enginePath, cfg);
  return {
    ok: speed.ok,
    reasons: speed.reasons,
    stats: { ...(visual.stats || {}), ...(speed.stats || {}) },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) { console.error('usage: node src/validate.js <engine.html>'); process.exit(1); }
  validateEngine(path.resolve(target))
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => { console.error('[validate] internal error:', e.message); process.exit(2); });
}
