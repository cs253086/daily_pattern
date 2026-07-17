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

const BASE_TAGS = [
  'generative art', 'screensaver', 'ambient', 'relaxing', 'study music background',
  'sleep', 'meditation', 'abstract', 'visuals', 'satisfying', 'procedural art',
  'creative coding', 'background video', 'chill', 'focus',
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

  const description = [
    `${mood.toLowerCase()} ${subject.toLowerCase()} ${useCase.toLowerCase()} — a ${durLabel.phrase} generative screensaver, freshly rendered on ${date}.`,
    '',
    'Every day a new pattern is generated and rendered automatically. Same seed, same video — fully deterministic generative art.',
    creditLine ? '' : undefined,
    creditLine,
    '',
    'Perfect as a background for studying, working, relaxing, meditating, or falling asleep.',
    '',
    `Seed: ${seed}`,
    info.engineName ? `Engine: ${info.engineName}` : '',
    '',
    '#generativeart #screensaver #ambient #relaxing #studywithme',
  ].filter((line) => line !== undefined).join('\n');

  const tags = dedupe([
    ...BASE_TAGS,
    mood.toLowerCase(),
    subject.toLowerCase(),
    'generative screensaver',
    durLabel.tag,
  ]).slice(0, 30);

  // YouTube Shorts: keep it short, lead with the hook, include #Shorts.
  const shortTitle = clampTitle(`${mood} ${subject} #Shorts`);
  const shortDescription = [
    `A 30-second cut of today's ${subject.toLowerCase()}.`,
    `New generative art every day — full ${durLabel.phrase} version on the channel.`,
    '',
    `Seed: ${seed}`,
    '#Shorts #generativeart #satisfying #ambient #relaxing',
  ].join('\n');

  const shortTags = dedupe(['shorts', ...tags]).slice(0, 30);

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

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(buildMetadata({ seed: process.argv[2] || '20260528' }), null, 2));
}
