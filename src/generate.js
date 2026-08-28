// Phase 2: ask the Gemini API to write today's generative-art engine as a
// single self-contained HTML file that conforms to the engine contract. The
// result is written to engines/auto/YYYY-MM-DD.html and returned. Validation
// (src/validate.js) and Bloom fallback are handled by the orchestrator.
//
// Uses the Gemini REST API via global fetch (Node 20+); no extra dependency.
//   env: GEMINI_API_KEY (required), GEMINI_MODEL (default gemini-2.0-flash)

import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Aesthetic nudges so each day leans toward a different look. Picked
// deterministically from the date so a given day is reproducible. The channel
// aims for a GEOMETRIC aesthetic — crisp shapes, straight edges, symmetry,
// lattices, tessellations — so the list is geometry-forward (a few organic
// options remain for variety).
// Split into a 2D bucket and a genuine-3D bucket (real WebGL, lit solid
// geometry with a depth buffer -- see the "3D / WEBGL" prompt section
// below) rather than one flat list, so theme selection can be weighted
// toward 3D (see nextThemeHint below) the same way src/index.js's
// curatedOr() weights the curated-engine fallback pool -- user request
// 2026-08-19, "generate more 3d patterns than 2d patterns". Note
// "rotating 3D wireframe polytope" stays in the 2D bucket even though it
// says "3D" in its text: it's a flat projection of edges onto a Canvas2D
// canvas (like wireframe.html), not real per-pixel lit depth, so it
// doesn't get the same weighting boost as the genuinely-3D WebGL hints.
const THEME_HINTS_2D = [
  // Geometric core (crisp edges, defined shapes, symmetry)
  'concentric rotating regular polygons nesting into a hypnotic vortex',
  'recursive geometric tessellation of triangles and hexagons slowly rotating',
  'sacred-geometry lattice: overlapping circles and polygons (flower-of-life style)',
  'wireframe geometric tunnel flythrough with crisp glowing edges',
  'rotating 3D wireframe polytope with luminous edges (Stars/Polyhedra style)',
  'op-art grid of squares that rotate and scale in waves',
  'isometric cube lattice shifting and rippling',
  'Truchet tiles forming maze-like geometric paths',
  'nested rotating star polygons (pentagrams / octagrams) with neon edges',
  'radial mandala built from straight-line geometry and mirrored wedges',
  'concentric polygon rings pulsing with phase offsets',
  'Penrose-style aperiodic tiling slowly recolouring',
  'spirograph / hypotrocloid line-art in clean glowing strokes',
  'grid of rotating triangles forming moiré interference',
  'geometric kaleidoscope of mirrored straight-edged shards',
  'orbiting polygons tracing crisp geometric spirograph paths',
  // A few organic options for variety
  'blooming fractal petals opening and closing',
  'flowing plasma fields with soft additive glow',
  'metaballs gently merging and splitting',
  'flow field where thousands of fine lines follow noise currents',
];
// Genuine 3D (lit solid geometry with real depth, not a flat projection).
const THEME_HINTS_3D = [
  'lit 3D polyhedra orbiting each other with real depth and per-face shading',
  'extruded 3D isometric lattice of glowing faceted blocks',
  'rotating 3D lit torus-and-ring structures with directional lighting',
  'field of small lit 3D solids drifting through real perspective depth',
  'a dense grid/lattice of small lit 3D cubes at fixed positions, each spinning independently, camera slowly turning like a turntable',
  'lit 3D crystalline cluster of faceted gems refracting a slowly rotating light',
];

// Growing theme pool (2026-08-28). THEME_HINTS_2D/3D above are a small,
// fixed, hand-written seed list -- 20 and 6 entries respectively -- which
// necessarily starts repeating after 20-26 uses regardless of how good the
// round-robin is. Real user complaint: "the theme hint should be found on
// web/somewhere else... a new theme," correctly pointing out that cycling a
// fixed list is not meaningfully different from the exact "same pattern
// over and over" problem already fixed on the curated-engine-pool side.
//
// Fix: grow the candidate list from state/creative-research-log.json --
// the SAME log the daily creative-research routine already writes to after
// searching something genuinely random on the web, extracting a structural
// idea from it, and novelty-gating the result (see CLAUDE.md's
// "Quasicrystal" and "Strip-weave" sections). Reusing those already-proven,
// already-web-sourced idea descriptions as Gemini theme hints was the
// obvious next step: it grows this pool at the same rate the curated pool
// grows, with zero new infrastructure, and -- critically -- it can't be
// done by having *this* file call WebSearch itself, because generate.js
// runs as a plain Node script inside the GitHub Actions job (a REST call to
// the Gemini API), not an agentic Claude session; only the separate
// research routine actually has web-search access.
//
// Only SHIPPED entries are pulled in (not skipped/abandoned ones) --
// skipped means the idea failed verification or the novelty gate, and
// feeding Gemini a known-bad or known-duplicate idea would be pointless at
// best. Each entry is classified 2D vs 3D by content-sniffing its actual
// engine file for a WebGL context (same isWebGLEngine() convention as
// curatedOr() in src/index.js), not by guessing from the idea text.
//
// Growth is append-only and read fresh on every call, so a numeric cursor
// into this list stays valid as the log grows (new entries only ever
// extend the tail) -- no need for curatedOr()'s name-based-cursor
// workaround, since nothing here ever reorders.
const RESEARCH_LOG_PATH = path.join(repoRoot, 'state', 'creative-research-log.json');
function growingThemeHints(dimension) {
  const base = dimension === '3D' ? THEME_HINTS_3D : THEME_HINTS_2D;
  const extra = [];
  try {
    const log = JSON.parse(readFileSync(RESEARCH_LOG_PATH, 'utf8'));
    for (const entry of log) {
      if (entry.outcome !== 'shipped' || !entry.idea || !entry.engineName) continue;
      let is3D = false;
      try {
        const html = readFileSync(path.join(repoRoot, 'engines', 'manual', `${entry.engineName}.html`), 'utf8');
        is3D = /getContext\(\s*['"]webgl2?['"]/.test(html);
      } catch { continue; } // engine file gone/renamed -- skip rather than guess
      if ((dimension === '3D') === is3D) extra.push(entry.idea);
    }
  } catch { /* no log yet (fresh checkout, or routine hasn't shipped anything) -- base list alone is fine */ }
  return [...base, ...extra];
}

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// Persisted rotation cursors for THEME_HINTS_2D / THEME_HINTS_3D, mirroring
// curatedOr()'s fix in src/index.js for the exact same bug class: a
// date-hash pick (hashStr(date) % list.length) can coincidentally repeat or
// cluster similar themes on nearby dates, and doesn't know or care what
// theme was used yesterday. A real complaint: consecutive days picked
// "concentric rotating regular polygons... vortex" and "recursive geometric
// tessellation of triangles and hexagons... rotating" -- different hints,
// but conceptually close, and with no memory of recent history there's
// nothing steering it toward the *unused* parts of the list first. A true
// round-robin guarantees every hint is used once before any repeats,
// maximising day-to-day variety the same way the curated-engine fix does.
//
// Two independent cursors (one per bucket), 2026-08-19: same dimension-
// weighting change as curatedOr(), so a Gemini success is also more likely
// to land on a 3D theme than a 2D one, not just the curated fallback path.
//
// DESIRED_THEME_P_3D is a target capped by bucket size, mirroring
// curatedOr()'s effectiveP3D() fix (2026-08-22) -- see CLAUDE.md for the
// real incident that made this necessary on the curated-engine side. Not
// currently binding here (THEME_HINTS_3D has 6 entries; 0.20*6=1.2 > 0.65),
// but applying the same self-correcting formula prevents this class of bug
// here too if the 3D theme list is ever pared down.
const THEME_STATE_PATH = path.join(repoRoot, 'state', 'theme-rotation.json');
const DESIRED_THEME_P_3D = 0.65;
const MAX_SINGLE_THEME_FREQ = 0.20;
function effectiveThemeP3D(n3D) {
  return Math.min(DESIRED_THEME_P_3D, MAX_SINGLE_THEME_FREQ * n3D);
}

function readThemeIndices() {
  try {
    const data = JSON.parse(readFileSync(THEME_STATE_PATH, 'utf8'));
    // Old schema (single flat `nextIndex` against the pre-split list): no
    // clean way to map a flat index onto the new two-list split, so just
    // bootstrap both cursors fresh from the date-hash below, same
    // graceful-degradation pattern used for missing/corrupt state
    // elsewhere in this project.
    if (Number.isInteger(data.next2D) || Number.isInteger(data.next3D)) {
      return {
        next2D: Number.isInteger(data.next2D) ? data.next2D : null,
        next3D: Number.isInteger(data.next3D) ? data.next3D : null,
      };
    }
  } catch { /* missing or corrupt state file -- caller bootstraps instead */ }
  return { next2D: null, next3D: null };
}

function writeThemeIndices(next) {
  try {
    mkdirSync(path.dirname(THEME_STATE_PATH), { recursive: true });
    writeFileSync(
      THEME_STATE_PATH,
      `${JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (e) {
    console.warn(`[generate] could not persist theme rotation state: ${e.message}`);
  }
}

// Pick the next theme in round-robin order and advance the persisted
// cursor for whichever bucket (2D/3D) this pick came from. Which bucket is
// chosen from is a deterministic 65/35-weighted pick from seed+date (not
// true randomness -- keeps this project's "same seed -> same everything"
// reproducibility convention). Bootstraps from the date-hash if a bucket's
// cursor is missing/corrupt (fresh checkout safety net, same pattern as
// curatedOr()).
function nextThemeHint(date, seed) {
  const { next2D, next3D } = readThemeIndices();
  const hints3D = growingThemeHints('3D');
  const hints2D = growingThemeHints('2D');
  const p3D = effectiveThemeP3D(hints3D.length);
  const want3D = (hashStr(`${seed ?? date}:theme-dim`) % 100) < p3D * 100;
  const list = want3D ? hints3D : hints2D;
  let idx = want3D ? next3D : next2D;
  if (idx === null || idx >= list.length) {
    idx = hashStr(String(date)) % list.length;
  }
  writeThemeIndices({
    next2D: want3D ? next2D : (idx + 1) % list.length,
    next3D: want3D ? (idx + 1) % list.length : next3D,
  });
  return list[idx];
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
- VIVID AND CLEAR is the top priority. Colors must read as punchy and saturated (HSL saturation roughly 70-95%), never pale, muddy, or pastel-washed. Shapes must be bold and legible at a glance — prefer FEWER, BIGGER, CLEARER elements over many small/thin/cluttered ones. A viewer should be able to tell what's on screen instantly, not squint at a fine haze.
- The frame must look DENSE and LAYERED at any moment past the first few seconds, but density must not come at the cost of clarity — layer a few clearly-readable big shapes/structures, not hundreds of tiny indistinct ones.
- Use a coherent multi-color PALETTE derived from the seed (3–6 related hues spread at least 40-60 degrees apart in hue so they read as genuinely different colors, not shades of one hue), not a single hue. Modulate hue/saturation/brightness over time so colors gently shift across the cycle.
- Vary scale: include both small fine detail AND large-scale structure in the same frame so there's foreground and background. Avoid a single dominant blob.
- Bloom but don't blow out AND don't wash out dim: the brightest regions (where many strokes overlap, e.g. a shared center) should be near-white, but most of the canvas should read as deep, SATURATED color against black — not white haze, and not pale/dim either. If the whole image goes solid white OR everything looks grey/washed-out, the run is wasted. If your engine ACCUMULATES light across frames (fades instead of clearing each frame), be extra careful: many overlapping semi-transparent strokes of DIFFERENT hues will sum toward white over time even if each one alone looks fine — keep per-stroke alpha low-to-moderate (~0.10-0.15).
- MANDATORY HARD RESET, no exceptions: this video runs for a FULL HOUR (86,400 frames), not a quick preview. If your engine accumulates light across frames (anything other than a full opaque clear every frame), it MUST fully clear or fade to solid black at least once every cycleSec seconds (or once every ~90 seconds if you don't use the cycleSec param) — a real full-opacity fillRect (alpha 1.0) or equivalent, not just a slow partial fade. A slow partial fade alone is NOT sufficient: even a "fine-looking" per-frame fade can still accumulate net brightness for thousands of consecutive frames and wash out to solid white well before the hour is up if there is no guaranteed full reset. This is a common, easy-to-miss bug: an engine that looks perfect in a 30-second mental preview can still slowly rise in brightness for the ENTIRE render with no reset and end up solid white by the middle of the hour. Structure your code so a reset is unconditionally guaranteed on a frame-count timer, not something that merely tends to happen.
- PREFERRED TECHNIQUE, avoid whiteout at the source: the safest and house-favorite approach is to fully clear the canvas to black every single frame and redraw the whole scene fresh, the same way the curated geometric and grid engines work — glow/bloom can still be faked within a single frame by drawing each shape twice (a bright thin core stroke plus a soft wide low-alpha stroke), which reads as luminous without ever accumulating anything across frames, so there is no whiteout risk at all. Only use frame-to-frame light accumulation (fading instead of clearing) if trails are essential to the concept, and if you do: never let any single element sit at nearly the same screen position for more than a couple of seconds — keep every point, particle, or stroke actively moving to a fresh position each frame instead of repeatedly stamping light onto the same pixels, on top of (not instead of) the mandatory hard reset above.
- LOCAL blowout within a single frame is a real, different failure mode from the cross-frame accumulation bug above -- it can happen even on a perfectly-clearing engine with no reset problem at all. If several additively-blended shapes (or a shape's own fill plus a stroke of the same or a similar bright color) overlap densely in the same small screen region, that region can clip to solid white in a SINGLE frame, while the rest of the canvas (with sparser coverage) still looks fine and keeps the frame-wide average brightness looking moderate. A real engine did exactly this: isometric cubes whose faces (and a stroke matching each face's own fill colour, doubling the contribution at their shared area) were dense enough to blow individual cube shapes out to solid white from the very first frame, while empty background between the sparse cubes kept the average brightness looking acceptable. Avoid stacking more than 2 overlapping additive layers of similar brightness at the same spot: don't stroke a shape with the same colour as its own fill under additive blending (pick a distinctly dimmer or complementary stroke colour, or skip the stroke), and keep the DENSITY of nearby overlapping shapes moderate rather than letting many of them cluster in the same small region.
- Loopability: the motion should feel like it could play forever without becoming monotonous.
- LIVELY PACE, not glacial: motion must be clearly visible within a few seconds of watching, not something a viewer has to stare at for 20-30+ seconds to notice. Concretely: any rotation should complete a full revolution in roughly 4-15 seconds (rad/s roughly 0.4-1.5), not 30-100+ seconds; any oscillating/pulsing parameter should complete a cycle in a similar few-second range. NEVER draw a motion-rate parameter from a range that includes ~0 or is very small (for example rand(-0.3, 0.3) rad/s) — that lets an individual element sit nearly still for the whole video, which reads as boring AND (on an accumulating engine) can cause localized whiteout. Always give motion parameters a guaranteed minimum magnitude with a random sign instead of a symmetric range around zero: pick a random sign, then add a random magnitude drawn from a range with a nonzero floor (something like 0.4 to 1.5). The goal is hypnotic and dynamic, not slow and static — err toward faster/livelier rather than slower/subtler.

=== PERFORMANCE BUDGET (HARD — the engine WILL be rejected if too slow) ===
- Each advanceFrame() call must complete in well under 100ms at 1920x1080 on software-rendered headless Chromium (no GPU). A 1-hour video is 86,400 frames; the renderer has only ~3 hours of CI budget.
- AVOID per-frame operations that scan every pixel: NO getImageData/putImageData, NO full-canvas CanvasFilter passes (ctx.filter='blur(...)' over the whole canvas), NO per-pixel for-loops, NO offscreen full-canvas compositing per frame.
- Prefer cheap vector drawing: a few hundred strokes/fills per frame, additive blending for the bloom feel, accumulating onto the canvas across frames (don't clear it every frame — use a subtle dark-alpha rect fade like 'rgba(0,0,0,0.02)' for trails).
- If you use particles, cap at a few thousand TOTAL and update/draw them in a single pass with simple math (sin/cos, vector add). NOT a flock with O(n^2) interactions per frame.
- WebGL is allowed if it's faster, but software rendering means most simple Canvas2D approaches will be faster than overengineered WebGL.

=== 3D / WEBGL (OPTIONAL, encouraged sometimes for variety) ===
Raw WebGL for genuine lit 3D geometry is fully supported by this renderer and is a good choice for some fraction of days: real per-pixel lighting and a depth buffer read as a meaningfully different, more three-dimensional look than a flat Canvas2D scene, which is valuable for day-to-day variety. You must write raw WebGL yourself (creating your own shaders, program, buffers, and a small hand-written 4x4 matrix helper) since no external 3D library can be loaded -- no network access is allowed, so nothing like three.js is available. If today's theme suggests real 3D structure (solids, lattices, depth, orbiting shapes), prefer WebGL; otherwise Canvas2D is fine as usual.
If you do use WebGL, three renderer-specific requirements are CRITICAL:
1. Create the context requesting preserveDrawingBuffer as true. Without this the headless capture pipeline reads back an already-cleared blank buffer and the whole video will be black.
2. Headless software WebGL in this environment has been observed to occasionally fire a spurious context-lost event within the first fraction of a second after the context is created, even for completely correct code -- roughly half the time, and never observed to recur later once past the first couple of frames. Handle this at startup, before setting window.READY to true: listen for the context-lost event and call preventDefault on it (required for the context to become restorable), listen for the context-restored event and re-create every GL resource from scratch when it fires, and wait a short delay (a few hundred milliseconds is enough) after creating the context before declaring READY, so a possible early loss has time to fire and be recovered rather than silently rendering on a dead context.
3. Clear both the color buffer and the depth buffer to opaque black at the start of every single frame, and enable depth testing for correct occlusion between shapes. This clear is a hardware buffer reset, not a compositing fade, so it is structurally immune to the whiteout/accumulation problem described above -- always prefer it over any fade-based approach for a 3D engine.
One more thing worth knowing: a real per-pixel lighting model naturally makes the same scene look brighter or dimmer depending on which faces point toward the camera and light, and how much objects overlap and occlude each other. If you randomise things like orbit radius, object scale, or object count every time the scene resets, that alone can swing the average frame brightness enough to look like a fake trend to the automated brightness check, even though nothing is actually accumulating. Keep values that affect how much of the frame is covered (object scale, orbit radius, camera distance) fixed or only mildly varied instead; randomise rotation rates, orbit speed, phase offsets, and colors -- those add plenty of variety without swinging overall coverage. Keep total geometry modest (well under a thousand triangles) for the performance budget above.

=== CREATIVE DIRECTION FOR TODAY (${date}) ===
Seed: ${seed}. Lean into this aesthetic: ${themeHint}.
HOUSE STYLE: favour a GEOMETRIC look — crisp straight edges, defined shapes, polygons, lattices, tessellations, and radial/mirror symmetry — over soft organic blobs. Luminous glowing EDGES on black, not fuzzy clouds. (If the theme above is organic, still keep clean structure and symmetry.) Above all: VIVID AND CLEAR, always — saturated colors, bold legible shapes. This is a standing channel requirement, not optional flavor.
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
  // A repair call MUST reuse the same themeHint as the original attempt
  // (the caller passes it explicitly -- see chooseEngine() in src/index.js)
  // rather than picking a new one here, or a repair would silently switch
  // creative direction mid-repair. Only a fresh (non-repair) call without an
  // explicit themeHint advances the rotation.
  const themeHint = opts.themeHint || nextThemeHint(date, seed);

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
