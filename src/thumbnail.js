// Custom YouTube thumbnail (2026-09-28, subscriber-growth work).
//
// Channel analytics (Aug 31 - Sep 27) showed 60.9K thumbnail impressions,
// 89% of them from YouTube recommending the videos, but only a 2.8%
// click-through rate -- the low end of the 2-10% range YouTube says half of
// all channels fall in. 64% of watch time is on TVs, where the thumbnail
// competes in a big grid. The old thumbnail was one frame grabbed at a fixed
// point with no text. This module:
//   1. scores several candidate frames from the headline scene and keeps the
//      most vivid one (colourful, high-contrast, well-filled, not blown out);
//   2. shifts the image right so a centred pattern clears the text area;
//   3. writes big, high-contrast text on a dark left-side scrim: the
//      pattern name, plus an optional yellow headline above it. The
//      "1 HOUR" headline was dropped on 2026-10-02 (owner request); the
//      title already carries the duration.
// Everything runs in headless Chromium's canvas (no ffmpeg filters -- see
// CLAUDE.md's reverted bloom attempt for why this project avoids complex
// ffmpeg filter graphs). Any failure is non-fatal: the caller keeps the
// plain frame render.js already wrote.

import { readFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer';

// Browser-side: score one image. Higher = more vivid and legible as a
// thumbnail. Measured on a 160x90 downscale.
function scoreInPage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = 160, h = 90;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let n = 0, lit = 0, white = 0, sumL = 0, sumL2 = 0, sumSat = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        n++; sumL += L; sumL2 += L * L;
        if (L > 0.973) white++;
        if (L > 0.12) {
          lit++;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          const l = (mx + mn) / 2;
          const s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
          sumSat += s;
        }
      }
      const mean = sumL / n;
      const std = Math.sqrt(Math.max(0, sumL2 / n - mean * mean));
      const coverage = lit / n;
      const sat = lit ? sumSat / lit : 0;
      const whiteFrac = white / n;
      // Colourful x contrasty, with a penalty for mostly-empty frames and
      // for blown-out white.
      const fill = Math.min(1, coverage / 0.3);
      const score = sat * std * (0.35 + 0.65 * fill) * (whiteFrac > 0.05 ? 0.3 : 1);
      resolve({ score, sat, std, coverage, whiteFrac });
    };
    img.onerror = () => resolve({ score: -1 });
    img.src = dataUrl;
  });
}

// Browser-side: draw the chosen frame plus text, return a JPEG data URL.
function drawInPage({ dataUrl, W, H, headline, subline }) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      // Shift the frame right so a centred pattern sits clear of the text --
      // but only when the frame's own left edge is already mostly dark.
      // A full-bleed pattern (Voronoi, Doyle spiral) shifted right shows a
      // hard black band where the image starts, even under the scrim.
      const probe = document.createElement('canvas');
      probe.width = 160; probe.height = 90;
      const pctx = probe.getContext('2d');
      pctx.drawImage(img, 0, 0, 160, 90);
      const strip = pctx.getImageData(0, 0, 26, 90).data;
      let litLeft = 0;
      for (let i = 0; i < strip.length; i += 4) {
        const L = (0.2126 * strip[i] + 0.7152 * strip[i + 1] + 0.0722 * strip[i + 2]) / 255;
        if (L > 0.12) litLeft++;
      }
      const shift = litLeft / (strip.length / 4) < 0.15 ? Math.round(W * 0.16) : 0;
      ctx.drawImage(img, shift, 0, W, H);
      // Dark scrim behind the text, fading out towards the pattern.
      const grad = ctx.createLinearGradient(0, 0, W * 0.62, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0.88)');
      grad.addColorStop(0.55, 'rgba(0,0,0,0.6)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      const family = "'Liberation Sans', 'DejaVu Sans', Arial, sans-serif";
      const x = Math.round(W * 0.05);
      const maxW = W * 0.5;

      // Pattern name: wrap into at most 3 lines, shrinking the font if needed.
      const words = String(subline || '').toUpperCase().split(/\s+/).filter(Boolean);
      // With no headline the name is the only text, so it starts bigger.
      let subSize = Math.round(H * (headline ? 0.105 : 0.14));
      let lines = [];
      for (; subSize >= H * 0.06; subSize -= 4) {
        ctx.font = `bold ${subSize}px ${family}`;
        lines = [];
        let cur = '';
        for (const wd of words) {
          const t = cur ? `${cur} ${wd}` : wd;
          if (ctx.measureText(t).width <= maxW || !cur) cur = t;
          else { lines.push(cur); cur = wd; }
        }
        if (cur) lines.push(cur);
        if (lines.length <= 3 && lines.every((l) => ctx.measureText(l).width <= maxW)) break;
      }

      const headSize = headline ? Math.round(H * 0.2) : 0;
      const gap = headline ? Math.round(H * 0.03) : 0;
      const lineH = Math.round(subSize * 1.12);
      const blockH = headSize + gap + lines.length * lineH;
      let y = Math.round((H - blockH) / 2) + headSize;

      ctx.lineJoin = 'round';
      ctx.textBaseline = 'alphabetic';
      ctx.strokeStyle = '#000';
      if (headline) {
        ctx.font = `bold ${headSize}px ${family}`;
        ctx.lineWidth = Math.round(headSize * 0.1);
        ctx.strokeText(headline, x, y);
        ctx.fillStyle = '#FFE14D';
        ctx.fillText(headline, x, y);
      }

      y += gap;
      ctx.font = `bold ${subSize}px ${family}`;
      ctx.lineWidth = Math.round(subSize * 0.14);
      for (const l of lines) {
        y += lineH;
        ctx.strokeText(l, x, y);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(l, x, y);
      }
      resolve(c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => reject(new Error('thumbnail frame failed to load'));
    img.src = dataUrl;
  });
}

const toDataUrl = (file) => `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;

// candidates: paths to JPEG frames (all from the headline scene).
// Returns { picked, scores } or throws; caller treats failure as non-fatal.
export async function composeThumbnail({ candidates, outPath, headline, subline, width = 1280, height = 720 }) {
  if (!candidates || candidates.length === 0) throw new Error('no thumbnail candidates');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    const scores = [];
    for (const file of candidates) {
      const s = await page.evaluate(scoreInPage, toDataUrl(file));
      scores.push({ file, ...s });
    }
    const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
    const jpeg = await page.evaluate(drawInPage, {
      dataUrl: toDataUrl(best.file), W: width, H: height, headline, subline,
    });
    const buf = Buffer.from(jpeg.slice(jpeg.indexOf(',') + 1), 'base64');
    if (buf.length > 2 * 1024 * 1024) throw new Error(`thumbnail too large (${buf.length} bytes, YouTube max 2MB)`);
    writeFileSync(outPath, buf);
    return { picked: best.file, scores };
  } finally {
    await browser.close();
  }
}
