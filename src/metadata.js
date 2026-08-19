// Templated metadata generation for the long video and the Short.
// Deterministic: the same seed produces the same title/description so a run is
// reproducible. No network calls — purely local string templating.

const MOODS = [
  'Hypnotic', 'Ambient', 'Mesmerizing', 'Calming', 'Dreamy',
  'Meditative', 'Soothing', 'Ethereal', 'Tranquil', 'Cosmic',
];

// Kept engine-agnostic (titles are picked from the seed hash independently of
// which engine actually renders), but biased toward the channel's geometric
// house style now that the curated pool is geometric-first.
const SUBJECTS = [
  'Geometric Patterns', 'Sacred Geometry', 'Generative Geometry',
  'Op-Art Motion', 'Kaleidoscope Patterns', 'Living Geometry',
];

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

// Build metadata for both outputs.
//   info: { seed, date?, durationSec?, engineName?, palette? }
export function buildMetadata(info = {}) {
  const seed = info.seed ?? '0';
  const date = info.date ?? formatDate();
  const h = hashSeed(seed);

  const mood = pick(MOODS, h);
  const subject = pick(SUBJECTS, h >>> 3);
  const useCase = pick(USE_CASES, h >>> 6);

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

  const visualParagraph = 'Watch bold, saturated colour and crisp rotating geometry slowly shift and evolve across the full runtime — expect kaleidoscopic symmetry, sharp-edged polygons, and a palette that drifts and deepens the longer you watch. No two days look quite the same, so there\'s always something new if you check back tomorrow.';

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
