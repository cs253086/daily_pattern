// Phase 2: ask the Gemini API to write today's generative-art engine as a
// single self-contained HTML file that conforms to the engine contract. The
// result is written to engines/auto/YYYY-MM-DD.html and returned. Validation
// (src/validate.js) and Bloom fallback are handled by the orchestrator.
//
// Uses the Gemini REST API via global fetch (Node 20+); no extra dependency.
//   env: GEMINI_API_KEY (required), GEMINI_MODEL (default gemini-2.0-flash)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Aesthetic nudges so each day leans toward a different look. Picked
// deterministically from the date so a given day is reproducible.
const THEME_HINTS = [
  'flowing plasma fields with soft additive glow',
  'interweaving Lissajous ribbons',
  'orbiting light particles leaving trails',
  'recursive geometric tessellation that slowly rotates',
  'fluid noise contour lines drifting',
  'spirograph lacework building up over time',
  'wave-interference ripple patterns',
  'blooming fractal petals opening and closing',
  'drifting aurora bands',
  'rotating mandala with radial symmetry',
  'electric filament arcs branching',
  'concentric pulsing rings with phase offsets',
];

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Wrap the base prompt with the previous (failed) attempt and the validator's
// reasons so Gemini can produce a corrected file in one more shot.
export function buildRepairPrompt({ seed, date, themeHint, previousHtml, reasons }) {
  const base = buildPrompt({ seed, date, themeHint });
  const trimmed = previousHtml.length > 18000
    ? previousHtml.slice(0, 9000) + '\n\n<!-- ...truncated... -->\n\n' + previousHtml.slice(-6000)
    : previousHtml;
  return base + `

=== REPAIR CONTEXT ===
Your previous attempt FAILED the quality gate for these reasons:
${reasons.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}

Below is your previous attempt verbatim. Produce a new COMPLETE HTML file that fixes the listed problems while still satisfying every requirement above. Output only the corrected file.

--- PREVIOUS ATTEMPT BEGIN ---
${trimmed}
--- PREVIOUS ATTEMPT END ---`;
}

export function buildPrompt({ seed, date, themeHint }) {
  return `You are generating ONE self-contained HTML file: a generative-art "screensaver" engine.
It will be rendered HEADLESSLY, frame by frame, into a long ambient video. There is no human watching it run live.

Output ONLY the raw HTML document. Start with <!DOCTYPE html>. No markdown, no code fences, no commentary.

=== HARD CONTRACT (the renderer depends on these EXACTLY; breaking any one makes the file useless) ===
1. Exactly one <canvas> element. Set canvas.width/height from the "width"/"height" URL params. Do NOT use window.innerWidth/innerHeight or devicePixelRatio.
2. Read these URL query params (with sensible defaults): seed (int), palette (optional), width (int, def 1920), height (int, def 1080), fps (int, def 24), duration (seconds, def 3600), speed (float, def 1), density (float, def 1), cycleSec (float, optional).
3. Seeded PRNG: implement Mulberry32 seeded from "seed". ALL randomness MUST come from it. Do NOT call Math.random() anywhere. Same seed => byte-identical video.
4. Do NOT use requestAnimationFrame, setInterval, or setTimeout to drive animation. The animation clock is controlled externally.
5. Expose on window:
   - READY: boolean, set to true only after initialization is complete.
   - TOTAL_FRAMES: integer === Math.round(duration * fps).
   - currentFrame: integer, starts at 0.
   - advanceFrame(): advances the simulation by exactly dt = 1/fps seconds, draws exactly one frame to the canvas, and increments currentFrame by 1.
   - advanceFrames(n): calls advanceFrame() n times.
6. Time-based motion: all motion must be expressed per-second and multiplied by dt = 1/fps per frame, so playback looks identically paced at any fps.
7. Self-contained: pure JavaScript + Canvas2D (or WebGL). NO external resources, NO network/fetch, NO imports, NO fonts, NO images.
8. Visual rules: NO text/letters/numbers drawn on the canvas. Use additive blending ('lighter' or equivalent). Slow, hypnotic, smoothly looping/evolving motion suitable as an ambient background. Rich but NOT a white-out — avoid the whole canvas saturating to solid white; keep deep blacks and luminous structure. Black background.

=== CREATIVE DIRECTION FOR TODAY (${date}) ===
Seed: ${seed}. Lean into this aesthetic: ${themeHint}.
Make it genuinely distinct from a generic particle demo. Derive structure, color, and counts from the seeded PRNG so the seed produces real variety.

Remember: output the complete HTML file only, beginning with <!DOCTYPE html>.`;
}

// Strip accidental markdown fences / leading prose; keep from <!DOCTYPE or <html.
function extractHtml(text) {
  let t = text.trim();
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const lower = t.toLowerCase();
  const i = lower.indexOf('<!doctype');
  const j = i === -1 ? lower.indexOf('<html') : i;
  if (j > 0) t = t.slice(j);
  return t.trim();
}

async function callGemini({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 1.0,
      topP: 0.95,
      maxOutputTokens: 8192,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status} ${res.statusText}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    throw new Error(`Gemini returned no candidates: ${JSON.stringify(data).slice(0, 500)}`);
  }
  if (cand.finishReason && cand.finishReason !== 'STOP') {
    // MAX_TOKENS / SAFETY etc. — the HTML is likely truncated/blocked.
    console.warn(`[generate] Gemini finishReason=${cand.finishReason} (output may be incomplete)`);
  }
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.map((p) => p.text || '').join('');
  if (!text.trim()) throw new Error('Gemini returned empty text.');
  return text;
}

// Generate today's engine. Returns { path, model, themeHint } or throws.
export async function generateEngine(opts = {}) {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');

  const model = opts.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const date = opts.date || todayUTC();
  const seed = opts.seed ?? date.replace(/-/g, '');
  const outDir = opts.outDir || path.join(repoRoot, 'engines', 'auto');
  const themeHint = opts.themeHint || THEME_HINTS[hashStr(String(date)) % THEME_HINTS.length];

  const prompt = opts.repair
    ? buildRepairPrompt({ seed, date, themeHint, previousHtml: opts.repair.previousHtml, reasons: opts.repair.reasons })
    : buildPrompt({ seed, date, themeHint });
  console.log(`[generate] model=${model} date=${date} theme="${themeHint}"${opts.repair ? ' (repair)' : ''}`);

  const raw = await callGemini({ apiKey, model, prompt });
  const html = extractHtml(raw);

  if (!/<canvas/i.test(html) || !/advanceFrame/.test(html)) {
    throw new Error('Generated HTML is missing required <canvas> or advanceFrame — rejecting before write.');
  }

  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${date}.html`);
  await writeFile(outPath, html, 'utf8');
  console.log(`[generate] wrote ${outPath} (${html.length} bytes)`);

  return { path: outPath, model, themeHint, date, seed: String(seed) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateEngine()
    .then((r) => console.log('[generate] ok:', JSON.stringify(r)))
    .catch((e) => { console.error('[generate] FAILED:', e.message); process.exit(1); });
}
