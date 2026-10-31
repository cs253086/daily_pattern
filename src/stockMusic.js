// Daily background music from Jamendo (https://developer.jamendo.com), restricted
// to CC0 (public-domain-equivalent) tracks only, so no attribution is required.
// Freesound is deliberately not used anywhere in this pipeline.
//
// Design notes, mirroring src/palette.js's "image of the day" integration:
//   * Date+seed-deterministic pick, so the pipeline stays reproducible.
//   * FULLY OPTIONAL and non-fatal: a missing JAMENDO_CLIENT_ID, a network
//     error, or no CC0 track today returns null and the video ships silent.
//   * Field names come from the Jamendo v3 track objects; anything missing is
//     logged and skipped, so a wrong guess shows up in the job log.

import { writeFile } from 'node:fs/promises';


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

async function downloadPreview(url, destPath) {
  const res = await fetchWithTimeout(url, { ms: 30000 });
  if (!res.ok) throw new Error(`preview download ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return destPath;
}

// Jamendo (https://developer.jamendo.com/v3.0): real genre music. Only tracks
// whose licence URL is CC0 (publicdomain/zero) are used, so the no-attribution
// safety property is the same. Field names are from the Jamendo
// v3 track objects as documented; anything missing is logged and skipped.
const JAMENDO_TAGS = ['deephouse', 'chillout', 'relaxation', 'lounge', 'meditation', 'ambient'];

async function jamendoTrack({ clientId, date, seed, destPath }) {
  const h = hashStr(`${date}:${seed}:jamendo`);
  const tag = JAMENDO_TAGS[h % JAMENDO_TAGS.length];
  const params = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    limit: '50',
    tags: tag,
    order: 'popularity_week',
    offset: String((h % 3) * 50),
  });
  const res = await fetchWithTimeout(`https://api.jamendo.com/v3.0/tracks/?${params}`, { ms: 15000 });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`jamendo search ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const j = await res.json();
  const all = Array.isArray(j.results) ? j.results : [];
  const cc0 = all.filter((t) => typeof t.license_ccurl === 'string'
    && /creativecommons\.org\/publicdomain\/zero/.test(t.license_ccurl)
    && typeof t.audio === 'string' && t.audio.startsWith('http')
    && Number(t.duration) >= 90);
  console.log(`[music] jamendo tag="${tag}": ${all.length} tracks, ${cc0.length} CC0 with audio >= 90s.`);
  if (cc0.length === 0) return null;
  const pick = cc0[h % cc0.length];
  await downloadPreview(pick.audio, destPath);
  console.log(`[music] using "${pick.name}" by ${pick.artist_name} (${Math.round(pick.duration)}s, CC0, jamendo #${pick.id}, tag="${tag}")`);
  return {
    path: destPath,
    title: pick.name,
    username: pick.artist_name,
    url: pick.shareurl || `https://www.jamendo.com/track/${pick.id}`,
    durationSec: Number(pick.duration),
  };
}

// Public: fetch today's CC0 background track to destPath, or null. Never throws.
// Jamendo is the only source. No Freesound, ever.
export async function dailyStockTrack({ date, seed, destPath } = {}) {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) {
    console.warn('[music] JAMENDO_CLIENT_ID not set; skipping music.');
    return null;
  }
  try {
    const jt = await jamendoTrack({ clientId, date, seed, destPath });
    if (!jt) console.warn('[music] no usable CC0 Jamendo track today; this video is silent.');
    return jt;
  } catch (e) {
    console.warn(`[music] jamendo failed: ${e.message}; this video is silent.`);
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
