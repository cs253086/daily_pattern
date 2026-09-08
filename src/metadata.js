// Templated metadata generation for the long video and the Short.
// No network calls — purely local string templating, plus one small persisted
// state file (state/title-rotation.json) so titles don't collide across days;
// see pickMood() below for why a pure seed-hash pick was not enough.

import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const MOODS = [
  'Hypnotic', 'Ambient', 'Mesmerizing', 'Calming', 'Dreamy',
  'Meditative', 'Soothing', 'Ethereal', 'Tranquil', 'Cosmic',
];

// What the video ACTUALLY SHOWS, per engine (2026-09-07). This used to be a
// flat 6-entry list picked from the seed hash, deliberately "engine-agnostic"
// -- which meant the title routinely described something the viewer never
// sees. Real, confirmed examples from production: 2026-08-31 rendered
// solids3d.html (floating lit 3D cubes and octahedra) and was published as
// "Meditative Kaleidoscope Patterns"; 2026-09-02 rendered the drifting-solids
// engine and was published as "Hypnotic Kaleidoscope Patterns". Neither video
// contains a kaleidoscope. User complaint, verbatim: "the title names are
// repeated. based on the video patterns, the title should be different."
//
// Descriptions are kept short (house rule: title = mood + subject, a few
// words) and searchable -- "Penrose Tiling" or "Prime Number Spiral" is both
// more accurate AND a better SEO term than a generic "Geometric Patterns",
// so this is a discovery win, not just a correctness fix. Engines not listed
// here (notably the auto-<date>-<slug> engines Gemini writes, which are new
// every day and whose slug comes from the source PHOTO's title, not from
// what the engine draws) fall back to a dimension-aware generic below.
const ENGINE_SUBJECTS = {
  arcrings: 'Rotating Arc Rings',
  automaton: 'Fractal Cell Growth',
  cascade: 'Cascading Blocks',
  chladni: 'Cymatic Wave Patterns',
  composer: 'Geometric Composition',
  dendrite: 'Fractal Branches',
  geodome: 'Geodesic Dome',
  geometric: 'Geometric Patterns',
  grid: 'Op-Art Grid',
  herringbone: 'Herringbone Weave',
  hilbertweave: 'Hilbert Curve Weave',
  kaleidoscope: 'Kaleidoscope Patterns',
  lattice3d: 'Spinning Cube Lattice',
  phyllotaxis: 'Golden Spiral Clusters',
  primespiral: 'Prime Number Spiral',
  quasicrystal: 'Penrose Tiling',
  solids3d: 'Floating 3D Solids',
  spaceframe: 'Octet Space Frame',
  spirograph: 'Spirograph Curves',
  starburst: 'Nested Starbursts',
  stripweave: 'Woven Strip Patterns',
  tessellation: 'Recursive Tessellation',
  torusrings3d: 'Glowing 3D Rings',
  voderberg: 'Voderberg Spiral',
  voronoimosaic: 'Voronoi Mosaic',
  widmanstatten: 'Crystal Lattice Bands',
  wireframe: 'Wireframe Polytopes',
  ziggurat: 'Art Deco Ziggurats',
};

// Fallback for engines with no entry above -- Gemini's daily auto-* engines.
// Their filename slug describes the SOURCE PHOTO ("scenic-view-of-gardens"),
// not the rendered visual, so it would produce actively wrong titles; the one
// thing genuinely known about them is whether they render real lit 3D (see
// isWebGLEngine() in src/index.js, which passes engineIs3D through).
const GENERIC_SUBJECT_3D = 'Lit 3D Geometry';
const GENERIC_SUBJECT_2D = 'Generative Geometry';

function subjectFor(engineName, engineIs3D) {
  const known = ENGINE_SUBJECTS[String(engineName || '').trim()];
  if (known) return known;
  return engineIs3D ? GENERIC_SUBJECT_3D : GENERIC_SUBJECT_2D;
}

const USE_CASES = [
  'for Focus & Study', 'for Sleep & Relaxation', 'for Deep Work',
  'for Meditation', 'to Unwind', 'for Calm & Concentration',
];

// Broad + LSI (related-term) tags so YouTube's matching has more to work
// with than the same handful of words repeated. Deliberately avoids any
// "music"/audio-implying terms — the videos are fully silent by design (no
// audio track at all), so claiming otherwise would mislead searchers.
const BASE_TAGS = [
  'generative art', 'screensaver', 'ambient', 'relaxing', 'study background',
  'sleep', 'meditation', 'abstract', 'visuals', 'satisfying', 'procedural art',
  'creative coding', 'background video', 'chill', 'focus', 'geometric art',
  'sacred geometry', 'kaleidoscope', 'hypnotic visuals', 'stress relief',
  'deep sleep', 'work from home', 'no talking', 'silent video', 'seamless loop',
  'trippy visuals', 'psychedelic art', 'desktop wallpaper', 'tv screensaver',
  'looping background', 'calming visuals',
];

// Small deterministic hash so we can pick template variants from a seed.
function hashSeed(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function pick(arr, n) {
  // Robust to negative `n` (JS `>>` is signed, so hashes with the high bit set
  // can give negative indices). Use unsigned modulo into the array length.
  const i = Math.abs(n | 0) % arr.length;
  return arr[i];
}

function formatDate(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Recently-published titles, so a title can't repeat while it's still fresh
// in a subscriber's feed (2026-09-07). The old scheme picked mood and subject
// from independent slices of the seed hash, with no memory of what shipped
// before -- exactly the same "a date-hash pick can coincidentally collide"
// bug class already fixed twice in this project (curatedOr()'s engine
// rotation, and the since-removed theme-hint rotation; see CLAUDE.md).
// Measured before changing anything, by running the OLD buildMetadata across
// 45 consecutive real dates: only 29 distinct titles, with "Mesmerizing
// Kaleidoscope Patterns" and "Ambient Geometric Patterns" each shipping 3
// times and twelve more titles shipping twice. That is a hash-collision
// problem, not bad luck: 10 moods x 6 subjects = 60 combinations sampled
// with replacement collides constantly (birthday paradox).
//
// Same persistence convention as state/engine-rotation.json and
// state/image-source-rotation.json: the workflow's "Persist rotation state"
// step does `git add state/`, so this file is picked up automatically with
// no workflow change, and that step is already skipped on dry_run so test
// invocations can't consume real titles.
const TITLE_STATE_PATH = path.join(repoRoot, 'state', 'title-rotation.json');
const RECENT_TITLE_MEMORY = 40;

function readRecentTitles() {
  try {
    const data = JSON.parse(readFileSync(TITLE_STATE_PATH, 'utf8'));
    return Array.isArray(data.recent) ? data.recent.filter((t) => typeof t === 'string') : [];
  } catch {
    return []; // missing/corrupt -- behave like a fresh checkout, no constraint
  }
}

function writeRecentTitles(recent) {
  try {
    mkdirSync(path.dirname(TITLE_STATE_PATH), { recursive: true });
    writeFileSync(
      TITLE_STATE_PATH,
      `${JSON.stringify({ recent: recent.slice(0, RECENT_TITLE_MEMORY), updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (e) {
    console.warn(`[metadata] could not persist title rotation state: ${e.message}`);
  }
}

// Choose the mood that makes a title nobody has seen recently. The subject is
// now pinned to whatever engine actually rendered (see ENGINE_SUBJECTS), so
// mood is the free axis: pick, from the moods that would NOT reproduce a
// recent title, the one the seed hash selects. Falls back to a plain
// seed-hash pick over all moods if every combination for this subject is
// already in recent memory (only reachable if one engine ships more than
// MOODS.length times inside the memory window -- the archetype-aware engine
// rotation makes that very unlikely, but the fallback keeps this total
// rather than throwing).
function pickMood(subject, seedHash, recent) {
  const fresh = MOODS.filter((m) => !recent.includes(`${m} ${subject}`));
  const from = fresh.length > 0 ? fresh : MOODS;
  return pick(from, seedHash);
}

// Build metadata for both outputs.
//   info: { seed, date?, durationSec?, engineName?, palette? }
export function buildMetadata(info = {}) {
  const seed = info.seed ?? '0';
  const date = info.date ?? formatDate();
  const h = hashSeed(seed);

  // Subject describes what actually rendered; mood is chosen to avoid
  // repeating a recently-published title (see ENGINE_SUBJECTS / pickMood).
  // `persistTitle: false` lets a caller preview a title without consuming it
  // from the recent-memory window (used by the verification scripts).
  const subject = subjectFor(info.engineName, info.engineIs3D);
  const recent = readRecentTitles();
  const mood = pickMood(subject, h, recent);
  const useCase = pick(USE_CASES, h >>> 6);
  if (info.persistTitle !== false) {
    writeRecentTitles([`${mood} ${subject}`, ...recent.filter((t) => t !== `${mood} ${subject}`)]);
  }

  // Describe the actual render length for the description (kept out of the
  // title, which is intentionally just a few words: mood + subject).
  const durLabel = durationLabel(info.durationSec);
  const longTitle = clampTitle(`${mood} ${subject}`);

  // Optional credit when the day's colours were drawn from an image (e.g. NASA
  // APOD). info.imageCredit = { source, title, imageUrl }.
  const ic = info.imageCredit;
  const creditLine = ic && ic.title
    ? `Today's colour palette is inspired by ${ic.source}: "${ic.title}".`
    : undefined;

  // Description structure follows current YouTube SEO guidance: a hook in the
  // first ~150 chars (shown in search results / above the "Show more" fold,
  // so it needs the value proposition + primary keywords up front, not just
  // a mood label), then a longer keyword-rich body (200-500 words performs
  // best), a subscribe CTA (genuinely relevant for a daily-upload channel),
  // then hashtags last. Deliberately says nothing about HOW the video was
  // made (no "generated"/"automated"/"AI"/"seed"/"engine" language, no raw
  // debug fields) — viewers care what it's like to watch, not the pipeline
  // behind it; that's implementation detail, not marketing copy.
  const hasAudio = !!info.hasAudio;
  const audioHookFragment = hasAudio ? ' with calming ambient music' : ', silent & looping';
  const hook = `${mood} ${subject} — ${durLabel.phrase} of vivid, ever-shifting geometric visuals${audioHookFragment}, perfect ${useCase.toLowerCase()}, deep sleep, or focus.`;

  // "every few minutes" is literally true now: src/render.js re-seeds the
  // engine into a fresh composition each scene (~4 min) with a crossfade
  // between them, so this is an accurate description, not marketing spin.
  const visualParagraph = 'Watch bold, saturated colour and crisp geometry keep transforming across the full runtime — every few minutes the pattern dissolves into a fresh arrangement of the same design, so it never settles into a loop. Expect kaleidoscopic symmetry, sharp-edged polygons, and a palette that drifts and deepens the longer you watch. No two days look quite the same, so there\'s always something new if you check back tomorrow.';

  const audioParagraph = hasAudio
    ? 'This video features a soft ambient soundtrack that plays quietly in the background alongside the visuals. Works great as animated wallpaper, a TV or desktop screensaver, or company while you work, study, code, read, journal, do yoga, or wind down before sleep.'
    : 'This video is completely silent — no music, no talking, no sound effects — so you can pair it with your own playlist, a podcast, white noise, or just enjoy it on mute. Works great as animated wallpaper, a TV or desktop screensaver, or an ambient backdrop while working, studying, coding, reading, journaling, meditating, doing yoga, or winding down before sleep.';

  // Music credit is a courtesy, not a legal requirement (only CC0-licensed
  // tracks are used — see src/stockMusic.js), same spirit as the image
  // credit above.
  const mc = info.musicCredit;
  const musicCreditLine = hasAudio && mc && mc.title
    ? `Music: "${mc.title}" by ${mc.username} (freesound.org, CC0 license).`
    : undefined;

  const description = [
    hook,
    '',
    visualParagraph,
    '',
    audioParagraph,
    creditLine ? '' : undefined,
    creditLine,
    musicCreditLine ? '' : undefined,
    musicCreditLine,
    '',
    `New ${mood.toLowerCase()} ${subject.toLowerCase()} every day — subscribe so you never miss tomorrow's.`,
    '',
    '#generativeart #screensaver #ambient #relaxing #hypnotic',
  ].filter((line) => line !== undefined).join('\n');

  const tags = buildTags([mood, subject, 'generative screensaver', durLabel.tag]);

  // YouTube Shorts: keep the title short, lead the description with the same
  // hook style (short-form viewers decide in the first line too), include
  // #Shorts (required for reliable Shorts-shelf placement).
  const shortTitle = clampTitle(`${mood} ${subject} #Shorts`);
  const shortDescription = [
    `A 30-second taste of today's ${subject.toLowerCase()}${hasAudio ? ', with a calming ambient soundtrack' : ''} — crisp, hypnotic, and endlessly satisfying to watch.`,
    `New pattern every day. Full ${durLabel.phrase} version is on the channel — subscribe for tomorrow's.`,
    '',
    '#Shorts #generativeart #satisfying #ambient #hypnotic',
  ].join('\n');

  const shortTags = buildTags(['shorts', mood, subject, 'generative screensaver', durLabel.tag]);

  return {
    date,
    seed,
    long: {
      title: longTitle,
      description,
      tags,
      categoryId: '24', // Entertainment
    },
    short: {
      title: shortTitle,
      description: shortDescription,
      tags: shortTags,
      categoryId: '24',
    },
  };
}

// Human-readable length labels derived from the render duration (seconds).
//   { title: "14 Minute", phrase: "14-minute", tag: "14 minutes" }
function durationLabel(durationSec) {
  const s = Number(durationSec);
  if (!Number.isFinite(s) || s <= 0) {
    return { title: '1 Hour', phrase: 'one-hour', tag: '1 hour' };
  }
  if (s % 3600 === 0) {
    const h = s / 3600;
    const word = h === 1 ? 'One Hour' : `${h} Hour`;
    return { title: word, phrase: h === 1 ? 'one-hour' : `${h}-hour`, tag: `${h} hour` };
  }
  const mins = Math.max(1, Math.round(s / 60));
  return { title: `${mins} Minute`, phrase: `${mins}-minute`, tag: `${mins} minutes` };
}

// YouTube titles must be <= 100 characters.
function clampTitle(t) {
  return t.length <= 100 ? t : t.slice(0, 99).trimEnd() + '…';
}

function dedupe(arr) {
  return [...new Set(arr)];
}

// YouTube's real tags-field limit is ~500 characters total (comma-separated),
// not a fixed item count. Build from priority extras first, then fill from
// BASE_TAGS, stopping before the budget is exceeded.
function buildTags(priorityExtras, charBudget = 480) {
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const raw of [...priorityExtras, ...BASE_TAGS]) {
    const t = String(raw).toLowerCase();
    if (seen.has(t)) continue;
    const added = t.length + (out.length > 0 ? 2 : 0); // ", " separator
    if (total + added > charBudget) continue;
    seen.add(t);
    out.push(t);
    total += added;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(buildMetadata({ seed: process.argv[2] || '20260528' }), null, 2));
}
