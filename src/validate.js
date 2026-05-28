// Phase 2 quality gate. Loads an engine headlessly at a small test resolution,
// confirms it honours the contract (READY / TOTAL_FRAMES / advanceFrame), then
// samples several frames and checks the image is:
//   * not stuck black, not blown out to white,
//   * spatially structured (not a flat fill),
//   * actually animating (frames differ over time).
// Returns { ok, reasons, stats } — never throws for engine problems; only
// throws on internal failures (e.g. browser launch).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const DEFAULTS = {
  width: 320,
  height: 180,
  fps: 12,
  duration: 24,
  seed: 12345,
  cycleSec: 8,
  readyTimeoutMs: 30000,
  // Thresholds on a 0..255 luma scale.
  minPeakMean: 1.5,   // at least one sample must be brighter than near-black
  maxPeakMean: 252,   // ... but not essentially solid white
  minPeakStd: 5,      // spatial structure (std-dev of luma) on the best frame
  minMotion: 1.0,     // mean abs luma diff between consecutive samples
};

// Computed in-page: draw the engine canvas downscaled and return luma stats +
// a small luma array (for temporal diffing across samples). Passed to
// page.evaluate as a real function so the selector arg is forwarded correctly.
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

export async function validateEngine(enginePath, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const reasons = [];

  if (!existsSync(enginePath)) {
    return { ok: false, reasons: [`engine file not found: ${enginePath}`], stats: null };
  }

  const url = pathToFileURL(enginePath);
  const p = url.searchParams;
  p.set('seed', String(cfg.seed));
  p.set('width', String(cfg.width));
  p.set('height', String(cfg.height));
  p.set('fps', String(cfg.fps));
  p.set('duration', String(cfg.duration));
  p.set('cycleSec', String(cfg.cycleSec));

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: cfg.width, height: cfg.height, deviceScaleFactor: 1 });

    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

    try {
      await page.goto(url.href, { waitUntil: 'load', timeout: cfg.readyTimeoutMs });
    } catch (e) {
      return done(browser, { ok: false, reasons: [`page failed to load: ${e.message}`], stats: null });
    }

    // Contract: READY must become true.
    try {
      await page.waitForFunction('window.READY === true', { timeout: cfg.readyTimeoutMs });
    } catch {
      reasons.push('window.READY never became true');
      if (pageErrors.length) reasons.push(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
      return done(browser, { ok: false, reasons, stats: null });
    }

    // Contract: required API present.
    const api = await page.evaluate(() => ({
      total: window.TOTAL_FRAMES,
      hasAdvance: typeof window.advanceFrame === 'function',
      hasAdvanceN: typeof window.advanceFrames === 'function',
      hasCanvas: !!document.querySelector('canvas'),
    }));
    if (!api.hasCanvas) reasons.push('no <canvas> element');
    if (!api.hasAdvance) reasons.push('window.advanceFrame is not a function');
    if (!Number.isFinite(api.total) || api.total <= 0) reasons.push(`invalid TOTAL_FRAMES: ${api.total}`);
    if (reasons.length) return done(browser, { ok: false, reasons, stats: null });

    const total = api.total;
    const sampleFractions = [0.08, 0.35, 0.6, 0.9];
    const targets = sampleFractions.map((f) => Math.max(1, Math.min(total, Math.round(total * f))));

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

    if (pageErrors.length) {
      reasons.push(`page errors during render: ${pageErrors.slice(0, 3).join(' | ')}`);
    }
    if (samples.length < 2) {
      reasons.push('not enough samples captured');
      return done(browser, { ok: false, reasons, stats: { samples: samples.map(strip) } });
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

    const stats = { peakMean, peakStd, motion, total, means, stds };
    return done(browser, { ok: reasons.length === 0, reasons, stats });
  } finally {
    if (browser.connected) await browser.close().catch(() => {});
  }
}

function strip(s) { return { mean: s.mean, std: s.std }; }
async function done(browser, result) {
  await browser.close().catch(() => {});
  return result;
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
