// Visual fingerprinting: measure what a pattern actually LOOKS like, so the
// pipeline can tell whether a new engine reads as something it has already
// shipped -- a capability nothing here had before (2026-08-25).
//
// Why this exists: every anti-repeat mechanism in this project until now was
// blind to pixels. curatedOr() rotates by FILENAME, Gemini's theme is derived
// from that day's real NASA photo (imageThemeHint() in generate.js -- no
// fixed list to rotate at all, see CLAUDE.md), and validate.js scores each
// engine in ISOLATION against absolute thresholds (brightness/saturation/
// motion) -- it never
// compares engine A to engine B. So two structurally different files that both
// render a centred radial mandala (kaleidoscope / starburst / spirograph, a
// real case documented in CLAUDE.md's "Archetype clustering" section) satisfy
// every guarantee the system makes while looking the same to a viewer. The
// actual detector of repetition has been the user watching YouTube. This module
// replaces that with a measurement.
//
// Design constraints that shaped the descriptor:
//
//   * COLOUR-BLIND ON PURPOSE. Curated engines are recoloured daily from the
//     NASA APOD palette (src/palette.js), so the same engine looks different in
//     hue while being structurally identical -- and every repetition complaint
//     this project has received was about silhouette/composition, never colour.
//     Including hue would let a recolour mask a structural repeat, which is
//     exactly the failure we're trying to catch. Everything below is computed
//     from luminance only.
//
//   * COMPOSITION, NOT PIXELS. A plain perceptual hash (aHash/dHash/pHash)
//     compares pixel layout, so it reports "different" for the same mandala
//     rotated a few degrees or rendered at a different cycle phase. That is the
//     wrong invariance for this problem. These features instead measure
//     structural properties that survive rotation/phase: how rotationally
//     symmetric it is, where its mass sits radially, which way its edges run,
//     whether it repeats on a lattice.
//
//   * COMPARABLE ACROSS A CORPUS. Raw feature units are unrelated (a
//     correlation vs. an edge fraction), so distance is computed on z-scored
//     vectors using the corpus's own mean/std -- see zscoreMatrix(). Without
//     that, whichever feature happens to have the largest numeric range would
//     dominate every distance.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

// In-page: read the canvas back at a reduced size and return luminance only.
// Downscaling is done by drawImage (the browser's own filtering averages each
// region for free, same trick src/palette.js uses for its structure grid).
function readLuma(w, h) {
  const src = document.querySelector('canvas');
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = [];
  for (let i = 0; i < d.length; i += 4) {
    // Rec. 709 luma, 0-255.
    out.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
  }
  return out;
}

// Render one engine at one seed and grab luminance at several points in time.
// One page load serves all the frame samples (advanceFrames is cheap relative
// to launching a page), which keeps a full-corpus sweep tractable.
export async function captureLuma(enginePath, {
  seed = 1, width = 320, height = 180, fps = 24, duration = 3600,
  cycleSec = 44, frames = [200, 600, 1000], sampleW = 128, sampleH = 72,
} = {}) {
  const url = pathToFileURL(path.resolve(enginePath));
  const p = url.searchParams;
  p.set('seed', String(seed));
  p.set('width', String(width));
  p.set('height', String(height));
  p.set('fps', String(fps));
  p.set('duration', String(duration));
  p.set('cycleSec', String(cycleSec));

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(url.href, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.READY === true', { timeout: 30000 });
    const shots = [];
    let at = 0;
    for (const target of frames) {
      const step = target - at;
      if (step > 0) await page.evaluate((n) => window.advanceFrames(n), step);
      at = target;
      const luma = await page.evaluate(readLuma, sampleW, sampleH);
      shots.push({ frame: target, luma: Float32Array.from(luma) });
    }
    return { shots, w: sampleW, h: sampleH };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Feature extraction (luminance in, fixed-length vector out)
// ---------------------------------------------------------------------------

function bilinear(g, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return 0;
  const fx = x - x0, fy = y - y0;
  const a = g[y0 * w + x0], b = g[y0 * w + x1], c = g[y1 * w + x0], d = g[y1 * w + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 1e-9 ? num / den : 0;
}

// Resample into polar coordinates around the frame centre: P[r][theta].
// Rotational symmetry becomes a simple shift-correlation along theta here,
// which is why every symmetry feature below works off this map.
function polarMap(g, w, h, nR = 24, nT = 64) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const maxR = Math.min(cx, cy);
  const out = new Float32Array(nR * nT);
  for (let ri = 0; ri < nR; ri++) {
    const r = ((ri + 0.5) / nR) * maxR;
    for (let ti = 0; ti < nT; ti++) {
      const t = (ti / nT) * Math.PI * 2;
      out[ri * nT + ti] = bilinear(g, w, h, cx + r * Math.cos(t), cy + r * Math.sin(t));
    }
  }
  return out;
}

// k-fold rotational symmetry: correlate the polar map against itself shifted
// by a full 1/k turn. ~1.0 means rotating the image by 360/k degrees leaves it
// essentially unchanged, i.e. a k-armed mandala.
function rotationalSymmetry(polar, nR, nT, k) {
  const shift = Math.round(nT / k);
  if (shift <= 0 || shift >= nT) return 0;
  const a = new Float32Array(nR * nT), b = new Float32Array(nR * nT);
  for (let ri = 0; ri < nR; ri++) {
    for (let ti = 0; ti < nT; ti++) {
      a[ri * nT + ti] = polar[ri * nT + ti];
      b[ri * nT + ti] = polar[ri * nT + ((ti + shift) % nT)];
    }
  }
  return pearson(a, b);
}

function mirrorSymmetry(g, w, h, axis) {
  const a = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      a[y * w + x] = g[y * w + x];
      b[y * w + x] = axis === 'lr' ? g[y * w + (w - 1 - x)] : g[(h - 1 - y) * w + x];
    }
  }
  return pearson(a, b);
}

// Where the ink sits as a function of distance from centre. Separates a
// centred blob (solids3d) from an edge-filled lattice (grid) from a uniform
// directional field (cascade) regardless of what shapes are used.
function radialProfile(polar, nR, nT, bins = 6) {
  const perR = new Float64Array(nR);
  for (let ri = 0; ri < nR; ri++) {
    let s = 0;
    for (let ti = 0; ti < nT; ti++) s += polar[ri * nT + ti];
    perR[ri] = s / nT;
  }
  const out = new Array(bins).fill(0);
  for (let ri = 0; ri < nR; ri++) out[Math.min(bins - 1, Math.floor((ri / nR) * bins))] += perR[ri];
  const total = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((v) => v / total);
}

// How unevenly mass is spread around the circle. ~0 for anything radially
// symmetric; high for a one-sided/directional composition.
function angularUnevenness(polar, nR, nT) {
  const perT = new Float64Array(nT);
  for (let ti = 0; ti < nT; ti++) {
    let s = 0;
    for (let ri = 0; ri < nR; ri++) s += polar[ri * nT + ti];
    perT[ti] = s / nR;
  }
  let m = 0;
  for (let i = 0; i < nT; i++) m += perT[i];
  m /= nT;
  if (m < 1e-9) return 0;
  let v = 0;
  for (let i = 0; i < nT; i++) v += (perT[i] - m) ** 2;
  return Math.sqrt(v / nT) / m;
}

// Sobel gradients -> orientation histogram (mod 180 degrees, magnitude
// weighted) + edge density. Catches directional flow: cascade's falling
// columns pile energy into one orientation band, a mandala spreads it evenly.
function gradientFeatures(g, w, h, bins = 8) {
  const hist = new Array(bins).fill(0);
  let edges = 0, total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
      const gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
      const mag = Math.hypot(gx, gy);
      total++;
      if (mag > 40) edges++;
      if (mag > 1e-6) {
        let ang = Math.atan2(gy, gx);
        if (ang < 0) ang += Math.PI;          // orientation, not direction
        if (ang >= Math.PI) ang -= Math.PI;
        hist[Math.min(bins - 1, Math.floor((ang / Math.PI) * bins))] += mag;
      }
    }
  }
  const s = hist.reduce((a, b) => a + b, 0) || 1;
  return { orient: hist.map((v) => v / s), edgeDensity: total ? edges / total : 0 };
}

// Strongest self-similarity at a non-trivial translation. A lattice/tiling
// repeats and scores high; a single centred figure does not.
function periodicity(g, w, h, axis) {
  const span = axis === 'x' ? w : h;
  const minLag = 4, maxLag = Math.floor(span / 3);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const a = [], b = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = axis === 'x' ? x + lag : x;
        const sy = axis === 'x' ? y : y + lag;
        if (sx >= w || sy >= h) continue;
        a.push(g[y * w + x]);
        b.push(g[sy * w + sx]);
      }
    }
    if (a.length > 16) best = Math.max(best, pearson(a, b));
  }
  return best;
}

// "Basic unit" analysis (2026-09-02). Every feature above describes overall
// COMPOSITION (symmetry, periodicity, coverage, edge orientation) -- none of
// them describe what the recurring visual UNIT actually is. Real user
// complaint, verbatim: "when I say a repeated pattern is basic unit making
// the pattern is the same... define what is repeated pattern correctly."
// Measured evidence this gap is real, not hypothetical: solids3d.html (a
// handful of orbiting lit 3D polyhedra) and the Gemini-promoted
// auto-2026-08-27-field-of-small-lit-3d-solids-drifting-th.html (a scattered
// field of the same kind of polyhedra) were NOT even nearest neighbours of
// each other under the composition-only features above (distance 0.894, not
// in the pool's top-8 closest pairs) -- despite a real user immediately,
// correctly identifying them as "this type of 3d cube pattern... many times
// before." Their orbit/scatter arrangement genuinely differs, which is what
// the composition features measure; their basic VISUAL UNIT -- a few
// separate, differently-sized, per-face-lit convex solids on black -- is
// identical, and nothing was measuring that.
//
// Connected-component analysis on the thresholded luminance frame gives a
// real, cheap proxy for "what is the repeated unit": how many separate lit
// shapes are on screen (blobCount), how uniform their sizes are
// (blobSizeCV -- low for many-identical-small-units like lattice3d.html's
// cube grid, high for a few irregularly-sized individual solids like
// solids3d.html/the Aug-27 engine), and whether one shape dominates
// (largestBlobFrac -- near 1.0 for a single continuous mesh like
// geodome.html, low for several separate scattered objects).
function connectedComponents(g, w, h, threshold = 12) {
  const seen = new Uint8Array(w * h);
  const sizes = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || g[start] <= threshold) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let size = 0;
    while (stack.length) {
      const i = stack.pop();
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && !seen[i - 1] && g[i - 1] > threshold) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !seen[i + 1] && g[i + 1] > threshold) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - w] && g[i - w] > threshold) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && !seen[i + w] && g[i + w] > threshold) { seen[i + w] = 1; stack.push(i + w); }
    }
    sizes.push(size);
  }
  return sizes;
}

function blobFeatures(g, w, h) {
  // Drop single-pixel components -- noise at this downsampled resolution,
  // not a real distinct shape.
  const sizes = connectedComponents(g, w, h).filter((s) => s >= 2);
  if (sizes.length === 0) return { blobCount: 0, blobSizeCV: 0, largestBlobFrac: 0 };
  const total = sizes.reduce((a, b) => a + b, 0);
  const mean = total / sizes.length;
  const variance = sizes.reduce((a, s) => a + (s - mean) ** 2, 0) / sizes.length;
  return {
    blobCount: sizes.length,
    blobSizeCV: mean > 0 ? Math.sqrt(variance) / mean : 0,
    largestBlobFrac: total > 0 ? Math.max(...sizes) / total : 0,
  };
}

export const FEATURE_NAMES = [
  'rotSym2', 'rotSym3', 'rotSym4', 'rotSym5', 'rotSym6', 'rotSym8',
  'mirrorLR', 'mirrorUD',
  'radial0', 'radial1', 'radial2', 'radial3', 'radial4', 'radial5',
  'angularUneven',
  'orient0', 'orient1', 'orient2', 'orient3', 'orient4', 'orient5', 'orient6', 'orient7',
  'periodX', 'periodY',
  'edgeDensity', 'coverage',
  'blobCount', 'blobSizeCV', 'largestBlobFrac',
];

// One frame -> one fixed-length descriptor.
export function frameFeatures(g, w, h) {
  const nR = 24, nT = 64;
  const polar = polarMap(g, w, h, nR, nT);
  const radial = radialProfile(polar, nR, nT, 6);
  const grad = gradientFeatures(g, w, h, 8);
  let lit = 0;
  for (let i = 0; i < g.length; i++) if (g[i] > 12) lit++;
  const blob = blobFeatures(g, w, h);
  return [
    ...[2, 3, 4, 5, 6, 8].map((k) => rotationalSymmetry(polar, nR, nT, k)),
    mirrorSymmetry(g, w, h, 'lr'),
    mirrorSymmetry(g, w, h, 'ud'),
    ...radial,
    angularUnevenness(polar, nR, nT),
    ...grad.orient,
    periodicity(g, w, h, 'x'),
    periodicity(g, w, h, 'y'),
    grad.edgeDensity,
    lit / g.length,
    blob.blobCount, blob.blobSizeCV, blob.largestBlobFrac,
  ];
}

// Average descriptors across frames/seeds so the fingerprint describes the
// ENGINE (its stable composition) rather than one arbitrary instant of it.
export async function fingerprintEngine(enginePath, { seeds = [1, 7], frames = [200, 600, 1000] } = {}) {
  const acc = [];
  for (const seed of seeds) {
    const { shots, w, h } = await captureLuma(enginePath, { seed, frames });
    for (const s of shots) acc.push(frameFeatures(s.luma, w, h));
  }
  const n = acc.length, d = acc[0].length;
  const mean = new Array(d).fill(0);
  for (const v of acc) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  return mean;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

// Put every feature on the same footing using the corpus's own spread, so no
// single raw unit dominates distance. Constant features collapse to 0.
export function zscoreMatrix(vectors) {
  const n = vectors.length, d = vectors[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  for (const v of vectors) for (let i = 0; i < d; i++) std[i] += ((v[i] - mean[i]) ** 2) / n;
  for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i]);
  return {
    z: vectors.map((v) => v.map((x, i) => (std[i] > 1e-9 ? (x - mean[i]) / std[i] : 0))),
    mean, std,
  };
}

// Normalised Euclidean distance in z-space. 0 = identical composition.
export function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
}

// Greedy single-link clustering: engines within `threshold` of each other are
// the same perceptual archetype. Used to count how many genuinely distinct
// patterns a pool can actually show a viewer.
export function cluster(names, zvecs, threshold) {
  const parent = names.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (distance(zvecs[i], zvecs[j]) < threshold) union(i, j);
    }
  }
  const groups = new Map();
  names.forEach((n, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n);
  });
  return [...groups.values()];
}
