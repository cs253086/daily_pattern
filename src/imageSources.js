// Multi-source "image of the day" (2026-08-29). Until now the only image
// input was NASA's Astronomy Picture of the Day (src/palette.js) -- one
// photo a day, always space imagery. User request: "can you search some
// websites that have tons of beautiful different images that can be
// excellent themes of the patterns?" -- followed by picking "rotate across
// all CC0 sources" when offered a choice of how many providers to add.
//
// Three more providers are wired in here, all researched and chosen for the
// SAME safety bar this project already applied to music sourcing: strictly
// CC0 / zero-attribution-required licensing, because nothing reviews a
// video before it publishes, and getting an attribution requirement subtly
// wrong at scale (the reason CC-BY was rejected for music, and the reason
// Unsplash was ranked out of this round -- its API Terms mandate crediting
// the photographer on every use) is real, ongoing legal-compliance risk in
// an unattended pipeline, not a one-time cost.
//
//   - Pixabay: CC0 Content License, no attribution required. Verified
//     response shape (hits[].tags/webformatURL/largeImageURL/user) via a
//     real documentation example found through web search this session.
//   - The Met Open Access: CC0 for isPublicDomain objects, no API key at
//     all (fully open REST). Field names (isPublicDomain, primaryImage,
//     artistDisplayName, etc.) are a long-stable, extremely widely-
//     documented public API; could not fetch a byte-exact example live in
//     this dev sandbox (metmuseum.github.io is blocked here, same policy
//     as every other external host used in this project), so the object
//     endpoint is called defensively -- see fetchMetImage below.
//   - Smithsonian Open Access: CC0, but this session's own research
//     surfaced real uncertainty about whether the search API's default
//     response reliably includes a usable image URL (one secondary source
//     claimed it sometimes doesn't). Rather than skip it or guess blindly,
//     it's implemented the same way this project already handles every
//     unverified integration (see the Freesound/NASA "could not exercise
//     end-to-end" precedent in CLAUDE.md): try several response paths,
//     fail closed (return null, non-fatal) if none pan out, and log a
//     breadcrumb so the next real run's job log is diagnosable instead of
//     silently empty every day.
//
// All four providers (NASA APOD + these three) return the exact same shape
// -- {imageUrl, title, explanation, source} -- and get run through the
// SAME pixel-extraction pipeline (extractImageData in src/palette.js), so
// nothing downstream (generate.js's imageThemeHint, index.js's recolor
// logic, metadata.js's credit line) needs to know or care which provider
// supplied a given day's image.
//
// Rotation: which provider gets tried first each day is a persisted
// round-robin (state/image-source-rotation.json), same convention as
// state/engine-rotation.json -- guarantees no provider repeats until all
// four have had a turn, rather than a date-hash pick that can coincidentally
// cluster. If the chosen provider fails (missing API key, network error,
// no usable image in its response), the remaining three are tried in
// rotation order before giving up for the day -- so a single unconfigured
// or down provider can't silently zero out image-derived inspiration on
// its scheduled days. The persisted cursor still advances to today's
// ORIGINALLY chosen provider regardless of which one ultimately succeeded,
// so tomorrow's rotation stays fair.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractImageData, fetchWithTimeout, fetchApod } from './palette.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// --- NASA APOD (existing provider, re-exposed here in the same raw
// {imageUrl, title, explanation, source} shape the other three return, so
// the shared loop below extracts its palette exactly once like every other
// provider instead of double-extracting via dailyImagePalette()).
async function fetchApodProvider({ date }) {
  const apod = await fetchApod({ date, apiKey: process.env.NASA_API_KEY });
  if (!apod) return null;
  return { imageUrl: apod.imageUrl, title: apod.title, explanation: apod.explanation, source: 'NASA APOD' };
}

// --- Pixabay -----------------------------------------------------------
// A rotating pool of SEARCH TERMS, not creative content -- unlike the old
// theme-hint list this project removed, these only steer which corner of
// Pixabay's huge catalogue gets queried; the actual day's image (and its
// derived colour/mood/description) is still genuinely different content
// every day, the same reasoning already applied to Freesound's music query
// pool.
const PIXABAY_QUERIES = [
  'abstract background', 'geometric pattern', 'nature texture', 'crystal formation',
  'aurora borealis', 'desert dunes', 'ocean waves', 'forest canopy', 'mountain range',
  'stained glass', 'marble texture', 'ice formation', 'city lights night', 'flowers macro',
  'coral reef', 'waterfall', 'clouds sky', 'sand ripples', 'autumn leaves', 'northern lights',
];

async function fetchPixabayImage({ date, seed }) {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) { console.warn('[imageSources] PIXABAY_API_KEY not set; skipping Pixabay.'); return null; }
  const h = hashStr(`${seed ?? date}:pixabay`);
  const q = PIXABAY_QUERIES[h % PIXABAY_QUERIES.length];
  const url = `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(q)}`
    + '&image_type=photo&safesearch=true&min_width=1280&per_page=50';
  let res;
  try {
    res = await fetchWithTimeout(url, { ms: 10000 });
  } catch (e) {
    console.warn(`[imageSources] Pixabay fetch failed: ${e.message}`);
    return null;
  }
  if (!res.ok) { console.warn(`[imageSources] Pixabay ${res.status} ${res.statusText}`); return null; }
  const j = await res.json().catch(() => null);
  const hits = j && Array.isArray(j.hits) ? j.hits : [];
  if (hits.length === 0) return null;
  const hit = hits[h % hits.length];
  const imageUrl = hit.largeImageURL || hit.webformatURL;
  if (!imageUrl) return null;
  return {
    imageUrl,
    title: (hit.tags || 'Pixabay image').split(',').map((t) => t.trim()).filter(Boolean).join(', '),
    explanation: `A photo tagged "${hit.tags}", by ${hit.user} on Pixabay.`,
    source: 'Pixabay',
  };
}

// --- The Met Open Access ------------------------------------------------
const MET_QUERIES = [
  'landscape', 'flowers', 'geometric', 'textile', 'mosaic', 'ornament', 'pattern',
  'ceramic', 'tapestry', 'stained glass', 'architecture', 'garden', 'celestial',
  'wave', 'star pattern', 'lattice',
];

async function fetchMetImage({ date, seed }) {
  const h = hashStr(`${seed ?? date}:met`);
  const q = MET_QUERIES[h % MET_QUERIES.length];
  const searchUrl = `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${encodeURIComponent(q)}`;
  let res;
  try {
    res = await fetchWithTimeout(searchUrl, { ms: 10000 });
  } catch (e) {
    console.warn(`[imageSources] Met search failed: ${e.message}`);
    return null;
  }
  if (!res.ok) { console.warn(`[imageSources] Met search ${res.status} ${res.statusText}`); return null; }
  const j = await res.json().catch(() => null);
  const ids = j && Array.isArray(j.objectIDs) ? j.objectIDs : [];
  if (ids.length === 0) return null;

  // hasImages=true does not itself guarantee isPublicDomain -- try a
  // handful of deterministic candidates (spread across the result list,
  // not just the first) before giving up for the day, same defensive
  // pattern as the Smithsonian provider below.
  for (let attempt = 0; attempt < 6; attempt++) {
    const id = ids[(h + attempt * 7919) % ids.length];
    let objRes;
    try {
      objRes = await fetchWithTimeout(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`, { ms: 10000 });
    } catch { continue; }
    if (!objRes.ok) continue;
    const obj = await objRes.json().catch(() => null);
    if (!obj || !obj.isPublicDomain) continue;
    const imageUrl = obj.primaryImage || obj.primaryImageSmall;
    if (!imageUrl) continue;
    const bits = [obj.title, obj.artistDisplayName, obj.culture, obj.period, obj.objectDate, obj.medium]
      .filter((v) => v && String(v).trim());
    return {
      imageUrl,
      title: obj.title || 'The Met Museum artwork',
      explanation: bits.join(', '),
      source: 'The Met Open Access',
    };
  }
  console.warn('[imageSources] Met: no public-domain image found among sampled candidates today.');
  return null;
}

// --- Smithsonian Open Access ---------------------------------------------
// See the file-level comment above: this response shape could not be
// verified against real docs in this sandbox, so it's deliberately
// defensive -- multiple candidate field paths, fails closed to null rather
// than throwing, and logs a breadcrumb if nothing usable is found so a
// wrong guess is diagnosable from a production job log rather than a
// silent no-op forever.
const SMITHSONIAN_QUERIES = [
  'landscape painting', 'geometric pattern', 'textile design', 'mosaic', 'ceramic vessel',
  'sculpture', 'architecture', 'celestial', 'flowers', 'ornament', 'crystal', 'shell pattern',
];

async function fetchSmithsonianImage({ date, seed }) {
  const apiKey = process.env.SMITHSONIAN_API_KEY;
  if (!apiKey) { console.warn('[imageSources] SMITHSONIAN_API_KEY not set; skipping Smithsonian.'); return null; }
  const h = hashStr(`${seed ?? date}:smithsonian`);
  const q = SMITHSONIAN_QUERIES[h % SMITHSONIAN_QUERIES.length];
  const url = `https://api.si.edu/openaccess/api/v1.0/search?q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(apiKey)}&rows=20`;
  let res;
  try {
    res = await fetchWithTimeout(url, { ms: 10000 });
  } catch (e) {
    console.warn(`[imageSources] Smithsonian fetch failed: ${e.message}`);
    return null;
  }
  if (!res.ok) { console.warn(`[imageSources] Smithsonian ${res.status} ${res.statusText}`); return null; }
  const j = await res.json().catch(() => null);
  const rows = j && j.response && Array.isArray(j.response.rows) ? j.response.rows : [];
  if (rows.length === 0) return null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const row = rows[(h + attempt * 7919) % rows.length];
    const media = row?.content?.descriptiveNonRepeating?.online_media?.media;
    const hit = Array.isArray(media) ? media.find((m) => m && (m.content || m.thumbnail)) : null;
    const imageUrl = hit?.content || hit?.thumbnail;
    if (!imageUrl) continue;
    const title = row?.title || row?.content?.descriptiveNonRepeating?.title?.content || 'Smithsonian item';
    const notes = row?.content?.freetext?.notes;
    const explanation = Array.isArray(notes) && notes[0]?.content ? notes[0].content : '';
    return { imageUrl, title, explanation, source: 'Smithsonian Open Access' };
  }
  console.warn('[imageSources] Smithsonian: no usable image URL in any sampled candidate today '
    + '(response schema may differ from what this provider expects -- unverified live in dev sandbox).');
  return null;
}

// --- Rotation across all four providers ----------------------------------
const PROVIDERS = [
  { key: 'apod', label: 'NASA APOD', fetch: fetchApodProvider },
  { key: 'pixabay', label: 'Pixabay', fetch: fetchPixabayImage },
  { key: 'met', label: 'The Met Open Access', fetch: fetchMetImage },
  { key: 'smithsonian', label: 'Smithsonian Open Access', fetch: fetchSmithsonianImage },
];

const ROTATION_STATE_PATH = path.join(repoRoot, 'state', 'image-source-rotation.json');

function readRotation() {
  try {
    const data = JSON.parse(readFileSync(ROTATION_STATE_PATH, 'utf8'));
    return { last: typeof data.last === 'string' ? data.last : null };
  } catch {
    return { last: null };
  }
}

function writeRotation(next) {
  try {
    mkdirSync(path.dirname(ROTATION_STATE_PATH), { recursive: true });
    writeFileSync(
      ROTATION_STATE_PATH,
      `${JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (e) {
    console.warn(`[imageSources] could not persist image-source rotation state: ${e.message}`);
  }
}

// Pick today's provider order: the next one in round-robin order after
// whatever was last used, then the rest in rotation order as a fallback
// chain. Bootstraps from a date-hash if the state file is missing/corrupt
// (fresh checkout safety net, same pattern as curatedOr() in src/index.js).
// The cursor is advanced and persisted to TODAY'S chosen provider
// regardless of whether it (or a fallback) ends up succeeding, so
// tomorrow's rotation stays fair even on a day one provider is down.
function rotationOrder(date, seed) {
  const { last } = readRotation();
  const lastIdx = PROVIDERS.findIndex((p) => p.key === last);
  const idx = lastIdx === -1
    ? hashStr(String(date)) % PROVIDERS.length
    : (lastIdx + 1) % PROVIDERS.length;
  writeRotation({ last: PROVIDERS[idx].key });
  const ordered = [];
  for (let i = 0; i < PROVIDERS.length; i++) ordered.push(PROVIDERS[(idx + i) % PROVIDERS.length]);
  return ordered;
}

// Public: fetch today's image from whichever provider is up (trying the
// rest of the rotation in order if the first choice fails/is unconfigured),
// extract its palette + luminance structure, and return the SAME shape
// dailyImagePalette() used to return on its own -- {colors, structure,
// gridW, gridH, title, explanation, imageUrl, source}. Never throws.
export async function dailyImage({ date = new Date().toISOString().slice(0, 10), seed } = {}) {
  const order = rotationOrder(date, seed);
  for (const provider of order) {
    try {
      const raw = await provider.fetch({ date, seed });
      if (!raw || !raw.imageUrl) continue;
      const extracted = await extractImageData(raw.imageUrl, { paletteCount: 5, gridW: 8, gridH: 5 });
      if (!extracted || !extracted.colors || extracted.colors.length < 2) continue;
      console.log(`[imageSources] using ${provider.label}: "${raw.title}"`);
      return {
        colors: extracted.colors,
        structure: extracted.structure,
        gridW: extracted.gridW,
        gridH: extracted.gridH,
        title: raw.title,
        explanation: raw.explanation,
        imageUrl: raw.imageUrl,
        source: raw.source,
      };
    } catch (e) {
      console.warn(`[imageSources] ${provider.label} failed: ${e.message}`);
    }
  }
  console.warn('[imageSources] no image available today from any source.');
  return null;
}

// CLI: `node src/imageSources.js` -- fetch & print today's image from
// whichever provider the rotation picks.
if (import.meta.url === `file://${process.argv[1]}`) {
  dailyImage().then((r) => {
    if (!r) { console.log('no image'); process.exit(1); }
    console.log(JSON.stringify(r, null, 2));
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
