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
// deterministically from the date so a given day is reproducible. Mix of
// original directions and abstract reinterpretations of iconic
// Windows / macOS / XScreenSaver classics.
const THEME_HINTS = [
  // Original generative directions
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
  // Classic screensaver homages (abstract reinterpretations, no logos/text)
  'classic 3D Pipes growing and branching through space',
  'Windows Mystify-style bouncing polyline trails',
  'starfield warp simulation flying through space',
  'Lorenz / strange attractor traces being slowly drawn',
  'metaballs gently merging and splitting',
  'munching-squares-style evolving XOR pattern in glowing colors',
  'plasma field with rolling sinusoidal interference',
  'abstract Matrix-style cascading light columns (glyph-like shapes, NO actual letters)',
  'wireframe geometric tunnel flythrough',
  'kaleidoscope of recursive fractal subdivisions',
  'After Dark style geometric shapes bouncing and leaving rainbow trails',
  'demoscene-style feedback tunnel with chroma shifts',
  'particle flock / boids forming and dissolving constellations',
  'electric arc lightning branching across the screen and decaying',
  'flow field where thousands of fine lines follow noise currents',
  'rotating 3D wireframe polytope with edge glow (Stars/Polyhedra style)',
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
8. Visual rules: NO text/letters/numbers drawn on the canvas. Use additive blending ('lighter' or equivalent). Slow, hypnotic, smoothly looping/evolving motion suitable as an ambient background. Black background.

=== VISUAL RICHNESS (REQUIRED — this is what makes it watchable) ===
- The frame must look DENSE and LAYERED at any moment past the first few seconds. Multiple independent visual layers/agents on screen at once (typically 30–200 contributing elements depending on style), composed so the eye finds new detail when it focuses.
- Use a coherent multi-color PALETTE derived from the seed (3–6 related hues), not a single hue. Modulate hue/saturation/brightness over time so colors gently shift across the cycle.
- Vary scale: include both small fine detail AND large-scale structure in the same frame so there's foreground and background. Avoid a single dominant blob.
- Bloom but don't blow out: the brightest regions should be near-white (pleasingly luminous), but most of the canvas should still read as deep color against black. If the whole image goes solid white the run is wasted.
- Slow regeneration: every ~30–120 seconds, gracefully evolve to a new variation (new color emphasis, new motion family, new density). Either fade-and-rebuild or smoothly cross-fade — never a hard cut.
- Loopability: the motion should feel like it could play forever without becoming monotonous.

=== PERFORMANCE BUDGET (HARD — the engine WILL be rejected if too slow) ===
- Each advanceFrame() call must complete in well under 100ms at 1920x1080 on software-rendered headless Chromium (no GPU). A 1-hour video is 86,400 frames; the renderer has only ~3 hours of CI budget.
- AVOID per-frame operations that scan every pixel: NO getImageData/putImageData, NO full-canvas CanvasFilter passes (ctx.filter='blur(...)' over the whole canvas), NO per-pixel for-loops, NO offscreen full-canvas compositing per frame.
- Prefer cheap vector drawing: a few hundred strokes/fills per frame, additive blending for the bloom feel, accumulating onto the canvas across frames (don't clear it every frame — use a subtle dark-alpha rect fade like 'rgba(0,0,0,0.02)' for trails).
- If you use particles, cap at a few thousand TOTAL and update/draw them in a single pass with simple math (sin/cos, vector add). NOT a flock with O(n^2) interactions per frame.
- WebGL is allowed if it's faster, but software rendering means most simple Canvas2D approaches will be faster than overengineered WebGL.

=== CREATIVE DIRECTION FOR TODAY (${date}) ===
Seed: ${seed}. Lean into this aesthetic: ${themeHint}.
Make it genuinely distinct from a generic particle demo. Derive STRUCTURE, COLOR PALETTE, COUNTS, and MOTION RATES from the seeded PRNG so the seed produces real variety — two different seeds should look noticeably different, not just recolored.

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

// Retry transient errors (503 service unavailable, 500 internal, 429 rate
// limit, and network failures) with exponential backoff. 429s on the free
// tier are usually short bursts; 503 "high demand" recovers in seconds.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini({ apiKey, model, prompt, maxAttempts = 3 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 1.0,
      topP: 0.95,
      // 2.5-series engine HTML can run 8-15K tokens; raise the budget so we
      // don't truncate. Free-tier per-request caps are well above this.
      maxOutputTokens: 32768,
      // Gemini 2.5 models burn output tokens on internal "thinking" by
      // default, which often consumed enough budget to truncate the HTML.
      // Disable thinking so the full budget goes to actual generation.
      // (Harmlessly ignored by models that don't support thinking.)
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Network failure — retry.
      lastErr = new Error(`Gemini fetch failed: ${e.message}`);
      if (attempt < maxAttempts) {
        const wait = 2000 * Math.pow(3, attempt - 1);
        console.warn(`[generate] attempt ${attempt} network error; retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw lastErr;
    }

    if (RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
      const wait = 2000 * Math.pow(3, attempt - 1); // 2s, 6s, 18s
      console.warn(`[generate] attempt ${attempt} got ${res.status}; retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }
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
      console.warn(`[generate] Gemini finishReason=${cand.finishReason} (output may be incomplete)`);
    }
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.map((p) => p.text || '').join('');
    if (!text.trim()) throw new Error('Gemini returned empty text.');
    return text;
  }
  throw lastErr;
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
  console.log(`[generate] response: ${raw.length} chars -> HTML ${html.length} chars`);

  await mkdir(outDir, { recursive: true });

  if (!/<canvas/i.test(html) || !/advanceFrame/.test(html)) {
    // Save the raw output so we can see what Gemini actually produced (most
    // common cause: MAX_TOKENS truncation before the script block closes).
    const debugPath = path.join(outDir, `${date}.raw.txt`);
    await writeFile(debugPath, raw, 'utf8');
    throw new Error(`Generated HTML is missing required <canvas> or advanceFrame — rejecting before write. Raw saved to ${debugPath}`);
  }

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
