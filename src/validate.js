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

const DEFAULTS = {
  // Visual phase config — small canvas, longer virtual timeline so
  // accumulation-style engines (like Bloom) have time to develop.
  visualWidth: 480,
  visualHeight: 270,
  visualFps: 24,
  visualDuration: 60,
  visualCycleSec: 30,
  seed: 12345,
  readyTimeoutMs: 30000,
  minPeakMean: 1.5,
  maxPeakMean: 252,
  minPeakStd: 5,
  minMotion: 1.0,

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
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    luma[p] = l; sum += l;
  }
  const mean = sum / n;
  let varAcc = 0;
  for (let p = 0; p < n; p++) { const dv = luma[p] - mean; varAcc += dv * dv; }
  return { mean, std: Math.sqrt(varAcc / n), luma };
}

function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function buildEngineUrl(enginePath, { seed, width, height, fps, duration, cycleSec }) {
  const url = pathToFileURL(enginePath);
  const p = url.searchParams;
  p.set('seed', String(seed));
  p.set('width', String(width));
  p.set('height', String(height));
  p.set('fps', String(fps));
  p.set('duration', String(duration));
  p.set('cycleSec', String(cycleSec));
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
    fps: cfg.visualFps, duration: cfg.visualDuration, cycleSec: cfg.visualCycleSec,
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

    // Sample at later fractions so accumulation-style engines have time to bloom.
    const total = ready.api.total;
    const fractions = [0.15, 0.4, 0.7, 0.95];
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
    let motion = 0;
    for (let i = 1; i < samples.length; i++) {
      motion = Math.max(motion, meanAbsDiff(samples[i].luma, samples[i - 1].luma));
    }

    if (peakMean < cfg.minPeakMean) reasons.push(`image stays near-black (peak mean luma ${peakMean.toFixed(2)})`);
    if (peakMean > cfg.maxPeakMean) reasons.push(`image is blown out to white (peak mean luma ${peakMean.toFixed(2)})`);
    if (peakStd < cfg.minPeakStd) reasons.push(`image lacks spatial structure (peak std ${peakStd.toFixed(2)})`);
    if (motion < cfg.minMotion) reasons.push(`little/no motion between frames (max diff ${motion.toFixed(2)})`);

    return {
      ok: reasons.length === 0,
      reasons,
      stats: { peakMean, peakStd, motion, total },
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
    fps: cfg.speedFps, duration: cfg.speedDuration, cycleSec: cfg.visualCycleSec,
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
