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

// Fetch APOD metadata for a date; return { imageUrl, title, explanation } or
// null. `explanation` (NASA's own free-text write-up of that day's photo)
// is what lets generate.js's imageThemeHint() derive a genuinely different
// creative theme every day straight from real web content, instead of
// round-robining a fixed hand-written list -- see generate.js for why.
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
  return { imageUrl, title: j.title || '', explanation: j.explanation || '' };
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

// In-page: draw the loaded <img> straight into a gw x gh canvas. The
// browser's own image-scaling (bilinear/box downsampling) does the
// per-region averaging for us for free -- each of the gw*gh output pixels
// approximates the average colour of that patch of the source image, no
// hand-written box-blur needed. Returns a flat row-major array of
// perceptual luminance (0-100) per cell, letting the day's actual photo
// content (not just its colour palette) drive engine layout -- see
// composer.html / the "lum" URL param.
function readLuminanceGrid(gw, gh) {
  const img = document.getElementById('src');
  const c = document.createElement('canvas');
  c.width = gw; c.height = gh;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, gw, gh);
  const data = ctx.getImageData(0, 0, gw, gh).data;
  const out = [];
  for (let i = 0; i < data.length; i += 4) {
    // Perceptual luma (Rec. 709), 0-100.
    const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255 * 100;
    out.push(Math.round(l));
  }
  return out;
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
  // Nudge toward luminous, punchy screensaver tones: keep hue, floor
  // saturation/lightness higher so real-world (often muted) photo colours
  // don't read as dim once recoloured onto the engines.
  return entries.map((e) => [
    Math.round(e.h),
    Math.round(Math.min(96, Math.max(72, e.s))),
    Math.round(Math.min(70, Math.max(54, e.l))),
  ]);
}

async function extractPalette(imageOrUrl, { count = 5, size = 96 } = {}) {
  const r = await extractImageData(imageOrUrl, { paletteCount: count, paletteSize: size, gridW: 0, gridH: 0 });
  return r ? r.colors : null;
}

// Load the image ONCE and extract both the colour palette and a low-res
// luminance grid from it in the same Puppeteer session -- avoids a second
// network fetch/decode for what would otherwise be two near-identical
// passes over the same image. Pass gridW/gridH = 0 to skip structure
// extraction (palette only).
async function extractImageData(imageOrUrl, {
  paletteCount = 5, paletteSize = 96, gridW = 8, gridH = 5,
} = {}) {
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
    const data = await page.evaluate(readPixels, paletteSize);
    const colors = quantise(data, paletteCount);
    if (colors.length < 2) return null;
    let structure = null;
    if (gridW > 0 && gridH > 0) {
      structure = await page.evaluate(readLuminanceGrid, gridW, gridH);
    }
    return { colors, structure, gridW, gridH };
  } catch (e) {
    console.warn(`[palette] extraction error: ${e.message}`);
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Turn an extracted palette + luminance grid into a few objective,
// human-readable mood descriptors -- used by generate.js's imageThemeHint()
// to describe today's real photo to Gemini in words, without listing any
// fixed catalogue of themes. Computed directly from data already extracted
// for the palette/structure (no extra image pass).
const HUE_FAMILIES = [
  [15, 'red'], [45, 'orange'], [65, 'gold/amber'], [80, 'yellow'], [160, 'green'],
  [195, 'teal/cyan'], [255, 'blue'], [290, 'violet'], [330, 'magenta/pink'], [360, 'red'],
];
function hueFamily(h) {
  const n = ((h % 360) + 360) % 360;
  for (const [max, name] of HUE_FAMILIES) if (n <= max) return name;
  return 'red';
}

export function describeImageMood(colors, structure) {
  const dom = colors && colors[0] ? hueFamily(colors[0][0]) : 'muted';
  const secondary = [...new Set((colors || []).slice(1, 3).map((c) => hueFamily(c[0])))]
    .filter((h) => h !== dom);
  const colorFamily = secondary.length ? `${dom} with hints of ${secondary.join(' and ')}` : dom;

  let brightness = 'evenly balanced light and dark';
  let contrast = 'moderate contrast';
  if (structure && structure.length) {
    const mean = structure.reduce((a, b) => a + b, 0) / structure.length;
    const variance = structure.reduce((a, b) => a + (b - mean) ** 2, 0) / structure.length;
    const sd = Math.sqrt(variance);
    brightness = mean < 30 ? 'mostly dark with bright highlights'
      : mean > 65 ? 'predominantly bright/light'
        : 'evenly balanced light and dark';
    contrast = sd > 25 ? 'strong, high-contrast light/dark structure' : 'soft, low-contrast tonal structure';
  }
  return { colorFamily, brightness, contrast };
}

// Encode a palette as a URL param the engines understand: "h,s,l;h,s,l;...".
export function encodeColors(pal) {
  return pal.map((c) => c.map((n) => Math.round(n)).join(',')).join(';');
}

// Encode a luminance grid as a URL param: "gw,gh:v1,v2,v3,..." (row-major,
// each v a 0-100 integer). Compact and easy for an engine to reshape.
export function encodeStructure(grid, gridW, gridH) {
  return `${gridW},${gridH}:${grid.join(',')}`;
}

// Public: get today's image palette (+ a luminance-grid "structure" for
// engines that want to derive layout from the image, not just colour), or
// null. Never throws.
export async function dailyImagePalette({ date = todayUTC(), apiKey = process.env.NASA_API_KEY } = {}) {
  try {
    const apod = await fetchApod({ date, apiKey });
    if (!apod) return null;
    const r = await extractImageData(apod.imageUrl, { paletteCount: 5, gridW: 8, gridH: 5 });
    if (!r) return null;
    console.log(`[palette] extracted ${r.colors.length} colours + ${r.gridW}x${r.gridH} structure grid from APOD "${apod.title}"`);
    return {
      colors: r.colors,
      structure: r.structure,
      gridW: r.gridW,
      gridH: r.gridH,
      title: apod.title,
      explanation: apod.explanation,
      imageUrl: apod.imageUrl,
      source: 'NASA APOD',
    };
  } catch (e) {
    console.warn(`[palette] dailyImagePalette failed: ${e.message}`);
    return null;
  }
}

// CLI: `node src/palette.js [imageUrlOrFile]` — extract & print a palette
// (+ structure grid). With no arg, tries today's APOD.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  const run = arg
    ? extractImageData(arg, { paletteCount: 5, gridW: 8, gridH: 5 }).then((r) => ({ ...r, source: arg }))
    : dailyImagePalette();
  run.then((r) => {
    if (!r || !r.colors) { console.log('no palette'); process.exit(1); }
    console.log(JSON.stringify(r, null, 2));
    console.log('colors param:', encodeColors(r.colors));
    if (r.structure) console.log('lum param:', encodeStructure(r.structure, r.gridW, r.gridH));
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
