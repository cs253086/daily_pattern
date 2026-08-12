// Deterministic ambient "meditation" pad music, synthesized entirely in
// Node from the same per-day seed as the visual engine -- no Web Audio
// API, no browser, no external audio library, no network access. This
// channel auto-publishes daily with no human review step, so bundling or
// fetching "royalty-free" music would carry real, unmanaged copyright
// risk (licenses vary, misattribution is easy, and nobody is checking each
// upload). A procedurally generated, 100% original track has zero such
// risk and fits this project's existing self-contained/deterministic
// convention (same Mulberry32 PRNG used by every visual engine).
//
// Musical design: a handful of sustained sine-pair ("chorus") tones built
// from one consonant interval set (root + fifth-ish + third-ish + octave),
// each with its own slow pitch-drift and amplitude-breathing LFO chosen
// once from the seed -- continuous smooth functions of time, not discrete
// section/crossfade state, which keeps the per-sample math simple and
// avoids any risk of audible clicks at a section boundary. One interval
// slowly drifts between a major- and minor-third colour over many minutes
// so a full hour doesn't feel static. On top of that pad, a real MELODY
// (not just sparse random chimes): a generative pentatonic-scale walk two
// octaves above the pad root, mostly stepwise with occasional leaps and
// rests, played with a soft plucked/kalimba-ish timbre (see planMelody /
// the note synthesis below) -- pentatonic because no two scale degrees are
// ever dissonant with each other or with the pad, so any seeded walk
// through it reliably sounds like a plausible, pleasant tune rather than
// a random string of notes. Per-voice amplitudes are chosen conservatively
// so the theoretical peak never approaches clipping -- no normalization
// pass (and no need to hold the whole multi-hundred-million-sample track
// in memory) is required.

function mulberry32(seed) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = (rng, a, b) => a + rng() * (b - a);
const randInt = (rng, a, b) => Math.floor(rand(rng, a, b + 1));

// Consonant interval sets over the root (index 2 is the "colour" tone that
// slowly drifts between a nearby major/minor value -- see thirdLow/thirdHigh
// below). All stay within an octave-and-a-bit for a warm, low pad register.
const CHORDS = [
  [1, 1.5, 1.25, 2],     // root, fifth, major third, octave
  [1, 1.333, 1.25, 2],   // root, fourth, major third, octave
  [1, 1.5, 1.125, 2.25], // root, fifth, ninth colour, ninth-octave
];

function equalPowerPan(pan) {
  const angle = ((pan + 1) * Math.PI) / 4; // pan in [-1,1] -> [0, PI/2]
  return [Math.cos(angle), Math.sin(angle)];
}

// Major pentatonic scale degrees (semitones from the scale root). No two
// degrees ever form a dissonant interval, which is exactly why a random
// walk through this scale reliably sounds musical without needing real
// composition logic.
const PENTATONIC = [0, 2, 4, 7, 9];
function scaleFreq(scaleRootHz, degree) {
  const octave = Math.floor(degree / PENTATONIC.length);
  const idx = ((degree % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length;
  const semitones = PENTATONIC[idx] + octave * 12;
  return scaleRootHz * 2 ** (semitones / 12);
}

// A slow, sparse, mostly-stepwise melodic walk -- deliberately unhurried
// (a note every ~2-6s) to match a "meditation calm" mood, with occasional
// rests for phrasing and rare bigger leaps so it doesn't feel mechanical.
// Never repeats exactly over a full hour since it's a continuous random
// walk, not a looped motif.
function planMelody(rng, rootHz, duration) {
  const scaleRootHz = rootHz * 4; // ~2 octaves above the pad -- sits clearly above it
  const notes = [];
  let degree = randInt(rng, 0, 4);
  let t = rand(rng, 4, 10);
  while (t < duration - 4) {
    const roll = rng();
    let step;
    if (roll < 0.5) step = rng() < 0.5 ? -1 : 1; // stepwise motion (most common)
    else if (roll < 0.72) step = 0; // repeated note
    else if (roll < 0.92) step = (rng() < 0.5 ? -1 : 1) * 2; // small leap
    else step = (rng() < 0.5 ? -1 : 1) * randInt(rng, 3, 5); // rare bigger leap
    degree = Math.max(-3, Math.min(11, degree + step));

    if (rng() >= 0.15) { // occasional rest, for breathing room between phrases
      notes.push({
        at: t,
        freq: scaleFreq(scaleRootHz, degree),
        amp: rand(rng, 0.1, 0.17),
        decay: rand(rng, 1.3, 2.8),
        pan: rand(rng, -0.45, 0.45),
      });
    }
    t += rand(rng, 2.2, 5.8);
  }
  return notes;
}

// Builds the deterministic per-tone/per-bell parameters for one track.
// Pure function of seed -- no I/O, easy to unit-test/inspect independent
// of the (much larger) sample-generation loop below.
export function planTrack({ seed, duration }) {
  const rng = mulberry32(Number(seed) || 1);
  const rootHz = rand(rng, 62, 104); // low, calm register (~B1-G2)
  const chord = CHORDS[randInt(rng, 0, CHORDS.length - 1)];

  const tones = chord.map((ratio, idx) => ({
    ratio,
    // Slow pitch drift (chorus/organic movement), tiny -- +/-0.4%.
    driftRate: rand(rng, 0.003, 0.009),
    driftPhase: rand(rng, 0, Math.PI * 2),
    driftDepth: rand(rng, 0.002, 0.004),
    // Slight permanent detune between the two summed sines per tone.
    detune: rand(rng, 0.0008, 0.0022) * (rng() < 0.5 ? -1 : 1),
    // Amplitude "breathing" LFO.
    lfoRate: rand(rng, 0.03, 0.08),
    lfoPhase: rand(rng, 0, Math.PI * 2),
    lfoDepth: rand(rng, 0.2, 0.35),
    baseAmp: idx === 3 ? rand(rng, 0.09, 0.14) : rand(rng, 0.16, 0.24),
    pan: (idx % 2 === 0 ? -1 : 1) * rand(rng, 0.15, 0.4),
  }));

  // The "colour" tone (index 2) slowly drifts between a major-third-ish and
  // a slightly-lower minor-third-ish ratio over many minutes, giving the
  // whole piece a gentle harmonic motion without any discrete state.
  const colourLow = tones[2].ratio * (1 - rand(rng, 0.03, 0.045));
  const colourHigh = tones[2].ratio;
  const colourRate = 1 / rand(rng, 480, 900); // one full cycle every 8-15 min

  const melody = planMelody(rng, rootHz, duration);

  return {
    rootHz, tones, colourLow, colourHigh, colourRate, melody,
  };
}

// Generates the track in ~1-second Int16 stereo PCM chunks, calling
// onChunk(buffer) for each -- callers pipe these straight into ffmpeg
// (raw PCM input) rather than buffering the whole multi-hundred-million-
// sample track in memory. Mirrors render.js's existing pattern of
// streaming video frames into ffmpeg via stdin.
export async function synthesizeAmbient({
  seed, duration, sampleRate = 44100, onChunk,
}) {
  const plan = planTrack({ seed, duration });
  const { tones, melody, colourLow, colourHigh, colourRate } = plan;
  const totalSamples = Math.round(duration * sampleRate);
  const CHUNK = sampleRate;
  const fadeSamples = Math.round(3 * sampleRate);
  const twoPi = Math.PI * 2;

  let notePtr = 0;
  const activeNotes = [];

  for (let start = 0; start < totalSamples; start += CHUNK) {
    const n = Math.min(CHUNK, totalSamples - start);
    const out = new Int16Array(n * 2);

    for (let i = 0; i < n; i++) {
      const sampleIdx = start + i;
      const t = sampleIdx / sampleRate;

      // Colour-tone ratio: smooth continuous crossfade between the two
      // interval values via a sine (never a hard switch).
      const colourMix = 0.5 + 0.5 * Math.sin(twoPi * colourRate * t);
      const colourRatio = colourLow + (colourHigh - colourLow) * colourMix;

      let l = 0;
      let r = 0;
      for (let ti = 0; ti < tones.length; ti++) {
        const tone = tones[ti];
        const ratio = ti === 2 ? colourRatio : tone.ratio;
        const drift = 1 + tone.driftDepth * Math.sin(twoPi * tone.driftRate * t + tone.driftPhase);
        const freq = plan.rootHz * ratio * drift;
        const amp = tone.baseAmp * (1 - tone.lfoDepth + tone.lfoDepth
          * (0.5 + 0.5 * Math.sin(twoPi * tone.lfoRate * t + tone.lfoPhase)));
        // Two slightly-detuned sines summed per tone for a warm chorus feel.
        const s = (Math.sin(twoPi * freq * (1 + tone.detune) * t)
          + Math.sin(twoPi * freq * (1 - tone.detune) * t)) * 0.5 * amp;
        const [pl, pr] = equalPowerPan(tone.pan);
        l += s * pl;
        r += s * pr;
      }

      // Activate any melody notes whose onset has arrived, and remove ones
      // that have fully decayed. Sparse (every few seconds) so only one or
      // two are ever active at once -- no need to scan the whole melody
      // per sample.
      while (notePtr < melody.length && melody[notePtr].at <= t) {
        activeNotes.push({ ...melody[notePtr], startT: t });
        notePtr++;
      }
      for (let ni = activeNotes.length - 1; ni >= 0; ni--) {
        const note = activeNotes[ni];
        const age = t - note.startT;
        if (age > note.decay * 5) { activeNotes.splice(ni, 1); continue; }
        const attack = Math.min(1, age / 0.015);
        const env = attack * Math.exp(-age / note.decay);
        // Fundamental + two quiet overtones for a warm plucked/kalimba
        // timbre -- distinct from the pad's pure chorus-sine tones, so the
        // melody reads as its own voice on top rather than blending in.
        const s = (Math.sin(twoPi * note.freq * t)
          + Math.sin(twoPi * note.freq * 2 * t) * 0.32
          + Math.sin(twoPi * note.freq * 3 * t) * 0.12) * note.amp * env;
        const [pl, pr] = equalPowerPan(note.pan);
        l += s * pl;
        r += s * pr;
      }

      // Fade in/out at the very start/end of the whole track.
      let fadeGain = 1;
      if (sampleIdx < fadeSamples) fadeGain = sampleIdx / fadeSamples;
      else if (sampleIdx > totalSamples - fadeSamples) fadeGain = (totalSamples - sampleIdx) / fadeSamples;

      l *= fadeGain; r *= fadeGain;
      out[i * 2] = Math.max(-32767, Math.min(32767, Math.round(l * 32767)));
      out[i * 2 + 1] = Math.max(-32767, Math.min(32767, Math.round(r * 32767)));
    }

    await onChunk(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  }
}
