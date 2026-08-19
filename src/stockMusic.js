// Daily background music sourced from Freesound.org, restricted to CC0
// (public-domain-equivalent) tracks only, so no attribution is ever legally
// required -- the safest license class for an unattended, no-human-review
// daily pipeline. This replaces the earlier procedurally-synthesized
// ambient track (src/audio.js, no longer used in production) per an
// explicit user request to use real license-free music instead of
// generating it ourselves.
//
// Design notes, mirroring src/palette.js's "image of the day" integration:
//   * Date+seed-deterministic pick (same day -> same query/page/index) so
//     the pipeline stays reproducible, same as everything else here.
//   * FULLY OPTIONAL and non-fatal: any failure (no API key, network
//     blocked, no CC0 results, download failure) returns null and the
//     caller just ships a silent video, exactly like before this feature
//     existed.
//   * Freesound's `/search/text/` endpoint + a `token` query param is
//     enough for search and for downloading the pre-rendered MP3
//     "preview" file -- no OAuth2 flow needed (OAuth2 is only required to
//     download the original, non-preview file, which this doesn't need).
//   * This can't be exercised end-to-end in this dev sandbox (freesound.org
//     is blocked by this session's network egress policy, confirmed via
//     the agent-proxy status endpoint) -- only the real GitHub Actions
//     runner has open internet to it. If the search/download shape below
//     turns out to be wrong, the failure will show up as a clearly logged
//     `[music] ... failed: <real error/response body>` line in the job
//     log (never a silent crash of the whole run), the same
//     diagnose-from-job-logs pattern already used for Gemini engine
//     failures (see logEngineSnippet in src/index.js) and for NASA APOD.

import { writeFile } from 'node:fs/promises';

const API_BASE = 'https://freesound.org/apiv2';

async function fetchWithTimeout(url, { ms = 15000, ...opts } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Small deterministic hash, same shape as src/metadata.js's hashSeed --
// same date+seed always picks the same query/page/track, keeping the
// pipeline reproducible.
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// A spread of ambient-leaning search terms so different days pull from
// different corners of the catalog rather than always the same query.
const QUERY_TERMS = [
  'ambient calm', 'ambient meditation', 'ambient pad', 'ambient drone',
  'calm background', 'peaceful ambient', 'relaxing ambient', 'soft ambient',
  'ambient loop', 'meditative pad',
];

// duration:[25 TO 480] keeps clips long enough that looping them for an
// hour doesn't repeat every few seconds, but not so long the preview
// download is slow. license restricts to CC0 only -- no attribution
// required. Solr-style filter syntax per Freesound API docs.
async function searchTracks({ apiKey, query, page }) {
  const params = new URLSearchParams({
    query,
    token: apiKey,
    filter: 'license:"Creative Commons 0" duration:[25 TO 480]',
    fields: 'id,name,previews,duration,license,username,url',
    sort: 'rating_desc',
    page_size: '50',
    page: String(page),
  });
  const reqUrl = `${API_BASE}/search/text/?${params}`;
  const res = await fetchWithTimeout(reqUrl, { ms: 15000, headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`freesound search ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }
  const j = await res.json();
  return Array.isArray(j.results) ? j.results : [];
}

async function downloadPreview(url, destPath) {
  const res = await fetchWithTimeout(url, { ms: 30000 });
  if (!res.ok) throw new Error(`preview download ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return destPath;
}

// Public: fetch today's CC0 background track to destPath, or null. Never throws.
export async function dailyStockTrack({ date, seed, apiKey = process.env.FREESOUND_API_KEY, destPath } = {}) {
  if (!apiKey) {
    console.warn('[music] FREESOUND_API_KEY not set; skipping stock music.');
    return null;
  }
  try {
    const h = hashStr(`${date}:${seed}`);
    const query = QUERY_TERMS[h % QUERY_TERMS.length];
    const page = (h % 3) + 1; // spread picks across a few result pages too
    const results = await searchTracks({ apiKey, query, page });
    if (results.length === 0) {
      console.warn(`[music] no CC0 results for query="${query}" page=${page}.`);
      return null;
    }
    const pick = results[h % results.length];
    const previewUrl = pick.previews && (pick.previews['preview-hq-mp3'] || pick.previews['preview-lq-mp3']);
    if (!previewUrl) {
      console.warn(`[music] chosen track #${pick.id} has no preview URL.`);
      return null;
    }
    await downloadPreview(previewUrl, destPath);
    console.log(`[music] using "${pick.name}" by ${pick.username} (${Math.round(pick.duration)}s, CC0, freesound #${pick.id}, query="${query}")`);
    return {
      path: destPath,
      title: pick.name,
      username: pick.username,
      freesoundUrl: pick.url,
      durationSec: pick.duration,
    };
  } catch (e) {
    console.warn(`[music] dailyStockTrack failed: ${e.message}`);
    return null;
  }
}

// CLI: `node src/stockMusic.js [outPath]` -- fetch & print today's pick.
if (import.meta.url === `file://${process.argv[1]}`) {
  const destPath = process.argv[2] || './stock-track.mp3';
  const date = new Date().toISOString().slice(0, 10);
  dailyStockTrack({ date, seed: date, destPath }).then((r) => {
    if (!r) { console.log('no track'); process.exit(1); }
    console.log(JSON.stringify(r, null, 2));
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
