// Optional "image of the day" palette: fetch a date-deterministic, public-domain
// image (NASA Astronomy Picture of the Day) and extract a small colour palette
// from it, so a day's engine can be recoloured to match "today's image".
//
// Design notes:
//   * Date-deterministic (APOD = one image per date) so the pipeline stays
//     reproducible: same date -> same image -> same palette -> same video.
//   * Public-domain source, credited in metadata — avoids using arbitrary
//     copyrighted web images on a public channel.
//   * FULLY OPTIONAL and non-fatal: any failure (no API key, APOD is a video
//     that day, network blocked, extraction empty) returns null and the caller
//     just uses the engine's built-in seed-derived palette.
//
// Extraction reuses the Puppeteer/Chromium we already depend on: load the image
// into a page, draw it small, read pixels, quantise by hue/lightness buckets.

import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

function todayUTC() { return new Date().toISOString().slice(0, 10); }

// fetch with a hard timeout so an unattended cron can't hang on a slow/dead
// image host. Aborts and rejects after `ms`.
async function fetchWithTimeout(url, { ms = 10000, ...opts } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Load image bytes (from a data:/file:/http(s) URL or local path) in Node and
// return a data: URL. Doing the fetch in Node — not in the page — sidesteps
// CORS / canvas-tainting entirely, so getImageData works on any source.
async function toDataUrl(src) {
  if (src.startsWith('data:')) return src;
  const mimeFor = (s) => (/\.png$/i.test(s) ? 'image/png' : /\.(gif)$/i.test(s) ? 'image/gif' : /\.(webp)$/i.test(s) ? 'image/webp' : 'image/jpeg');
  if (src.startsWith('file://') || src.startsWith('/') || src.startsWith('./')) {
    const p = src.startsWith('file://') ? new URL(src).pathname : src;
    const buf = await readFile(p);
    return `data:${mimeFor(p)};base64,${buf.toString('base64')}`;
  }
  const res = await fetchWithTimeout(src, { ms: 15000 });
  if (!res.ok) throw new Error(`image fetch ${res.status}`);
  const ct = res.headers.get('content-type') || mimeFor(src);
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${ct};base64,${buf.toString('base64')}`;
}

// Fetch APOD metadata for a date; return { imageUrl, title } or null.
async function fetchApod({ date, apiKey }) {
  const key = apiKey || 'DEMO_KEY';
  const url = `https://api.nasa.gov/planetary/apod?api_key=${encodeURIComponent(key)}&date=${date}`;
  let res;
  try {
    res = await fetchWithTimeout(url, { ms: 10000, headers: { accept: 'application/json' } });
  } catch (e) {
    console.warn(`[palette] APOD fetch failed: ${e.message}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`[palette] APOD ${res.status} ${res.statusText}`);
    return null;
  }
  const j = await res.json().catch(() => null);
  if (!j) return null;
  if (j.media_type !== 'image') {
    console.warn(`[palette] APOD for ${date} is not an image (media_type=${j.media_type}); skipping.`);
    return null;
  }
  // Prefer the standard-res url over hdurl (smaller download, plenty for palette).
  const imageUrl = j.url || j.hdurl;
  if (!imageUrl) return null;
  return { imageUrl, title: j.title || '' };
}

// In-page: draw the loaded <img> into a small canvas and return raw RGBA bytes.
function readPixels(size) {
  const img = document.getElementById('src');
  const c = document.createElement('canvas');
  const w = size, h = Math.max(1, Math.round(size * (img.naturalHeight / img.naturalWidth)) || size);
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return Array.from(ctx.getImageData(0, 0, w, h).data);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

// Quantise pixels into a palette of vivid, distinct HSL triples.
function quantise(data, count) {
  // Bucket by hue (24 bins) among reasonably colourful, mid-lightness pixels.
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (l < 12 || l > 92) continue;      // skip near-black / near-white
    if (s < 18) continue;                // skip greys
    const bin = Math.floor(h / 15);      // 24 hue bins
    const cur = bins.get(bin) || { n: 0, h: 0, s: 0, l: 0 };
    cur.n++; cur.h += h; cur.s += s; cur.l += l;
    bins.set(bin, cur);
  }
  let entries = [...bins.values()].map((b) => ({
    n: b.n, h: b.h / b.n, s: b.s / b.n, l: b.l / b.n,
  }));
  if (entries.length === 0) return [];
  entries.sort((a, b) => b.n - a.n);
  entries = entries.slice(0, count);
  // Nudge toward luminous screensaver tones: keep hue, floor saturation/lightness.
  return entries.map((e) => [
    Math.round(e.h),
    Math.round(Math.min(95, Math.max(60, e.s))),
    Math.round(Math.min(66, Math.max(50, e.l))),
  ]);
}

async function extractPalette(imageOrUrl, { count = 5, size = 96 } = {}) {
  let dataUrl;
  try {
    dataUrl = await toDataUrl(imageOrUrl);
  } catch (e) {
    console.warn(`[palette] could not load image bytes: ${e.message}`);
    return null;
  }
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<body style="margin:0;background:#000"><img id="src"></body>');
    const ok = await page.evaluate((url) => new Promise((resolve) => {
      const img = document.getElementById('src');
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
      if (img.complete && img.naturalWidth) resolve(true);
    }), dataUrl);
    if (!ok) { console.warn('[palette] image failed to decode'); return null; }
    const data = await page.evaluate(readPixels, size);
    const pal = quantise(data, count);
    return pal.length >= 2 ? pal : null;
  } catch (e) {
    console.warn(`[palette] extraction error: ${e.message}`);
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Encode a palette as a URL param the engines understand: "h,s,l;h,s,l;...".
export function encodeColors(pal) {
  return pal.map((c) => c.map((n) => Math.round(n)).join(',')).join(';');
}

// Public: get today's image palette, or null. Never throws.
export async function dailyImagePalette({ date = todayUTC(), apiKey = process.env.NASA_API_KEY } = {}) {
  try {
    const apod = await fetchApod({ date, apiKey });
    if (!apod) return null;
    const colors = await extractPalette(apod.imageUrl, { count: 5 });
    if (!colors) return null;
    console.log(`[palette] extracted ${colors.length} colours from APOD "${apod.title}"`);
    return { colors, title: apod.title, imageUrl: apod.imageUrl, source: 'NASA APOD' };
  } catch (e) {
    console.warn(`[palette] dailyImagePalette failed: ${e.message}`);
    return null;
  }
}

// CLI: `node src/palette.js [imageUrlOrFile]` — extract & print a palette.
// With no arg, tries today's APOD.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  const run = arg
    ? extractPalette(arg, { count: 5 }).then((c) => ({ colors: c, source: arg }))
    : dailyImagePalette();
  run.then((r) => {
    if (!r || !r.colors) { console.log('no palette'); process.exit(1); }
    console.log(JSON.stringify(r, null, 2));
    console.log('colors param:', encodeColors(r.colors));
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
