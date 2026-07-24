# daily_pattern — project guidance

Automated pipeline: renders a daily generative-art video (1 hour) + a 30s
Short, uploads both to the "Pattern Flow" YouTube channel. Runs via GitHub
Actions cron (`.github/workflows/daily.yml`) calling `src/index.js`.

## Standing visual requirements (apply to ALL engines — curated and AI-generated)

These are durable house-style rules, not one-off tweaks. Any new engine
(`engines/manual/*.html`) or change to `src/generate.js`'s prompt must honor
them:

1. **Vivid and clear.** Colors must read as punchy and saturated, not
   pale/washed/pastel. Shapes must be bold and legible at a glance — bigger,
   fewer, clearer elements beat many small/thin ones. Before shipping a new
   or changed engine, render a frame and *look at it* — don't just pass the
   quality gate and assume it looks good.
2. **Geometric house style.** Crisp straight edges, defined shapes, polygons,
   lattices, radial/mirror symmetry — not soft organic blobs/fuzzy clouds.
   (See `src/generate.js`'s `HOUSE STYLE` prompt line and `THEME_HINTS`.)
3. **Additive glow, but watch for whiteout.** Engines that *accumulate*
   light across frames (fade instead of clearing each frame — e.g.
   `kaleidoscope.html`) are prone to washing out to solid white when many
   overlapping strokes/hues sum together, especially if you add continuous
   hue drift. Engines that *clear and redraw* each frame (e.g. `geometric.html`,
   `grid.html`) don't have this problem and can safely use unbounded hue
   drift for dynamic color.
   - **Test the FULL cycle length, not an arbitrary early fraction.** A real
     production bug shipped because testing stopped at ~30-37s of a 70s
     (`cycleSec`) kaleidoscope cycle and looked fine — but by ~50-70s it had
     washed to a solid white disc. Always render at fractions of the
     *actual* `cycleFrames = cycleSec * fps` (e.g. 25/50/75/95/105%), not a
     fixed frame count guessed to be "probably enough."
   - **Near-zero motion is the classic root cause on an accumulating
     engine**, not just "fade too slow." If any per-element motion
     parameter (angular drift, radial frequency, speed, etc.) is drawn from
     a range that includes ~0 (e.g. `rand(-0.5, 0.5)`), that element can
     sit nearly still for a whole cycle, re-stamping the *same* small
     region every frame until it alone saturates to white — even while the
     rest of the canvas looks fine. Fix at the source: give every motion
     parameter a guaranteed minimum magnitude (e.g.
     `(rng()<0.5?-1:1) * rand(0.18, 0.5)` instead of `rand(-0.5, 0.5)`), not
     just a faster fade — a stronger fade masks the symptom but a stuck
     element will still out-accumulate any reasonable decay rate.
   - **This bug class isn't limited to hand-written engines.** A
     Gemini-generated engine ("metaballs gently merging and splitting")
     passed `validate.js` and still washed out to solid white partway
     through a real 1-hour render. Root cause: `validate.js`'s visual-phase
     test only simulated 60 virtual seconds (vs. the real 3600s render)
     *and* forced a short `cycleSec=30` override that doesn't match
     production (production never sets `cycleSec` — it lets each engine use
     its own default, or have no reset at all). An engine with no reset
     mechanism looked fine in that short, artificially-cycled test window
     and then accumulated unbounded for the full hour. Fixed in `validate.js`:
     stopped forcing `cycleSec` in validation so it tests the exact config
     production will use, and extended the visual-phase test window to 300
     virtual seconds with 8 samples spread across it. `generate.js`'s prompt
     also states a hard, numeric requirement (full reset at least every
     `cycleSec` — or ~90s if `cycleSec` isn't used — via a real opaque
     clear, not just a fade) so new Gemini engines are less likely to omit a
     reset in the first place. Moral: a validator that tests a *different,
     shorter/easier* configuration than what ships is worse than no
     validator — always validate the literal parameters production will use.
   - **A "never dips" check is not enough — PARTIAL resets slip through
     too.** Third occurrence of this bug class: a Gemini engine (theme
     "flowing plasma fields with soft additive glow") passed the fixed
     validator above (including its first "never observed a reset" rule:
     reject if mean brightness rises monotonically with *zero* dip anywhere
     across the sampled window) and still was visibly, mostly white by
     ~56 of 60 minutes into the real render (user-reported screenshot).
     Root cause: that rule only fired when there was *no dip at all*. An
     engine whose fade/clear is present but too weak relative to its
     accumulation rate dips brightness a little at each partial reset —
     enough to break the strict "never dips" condition — while still
     climbing on net every single cycle, so it passes a short test window
     that happens to catch a couple of those small dips and still washes
     out over the full, ~12x-longer hour. A pass/fail rule built only
     around "did it ever dip" cannot distinguish a full, honest reset from
     a partial one — it needed to look at the *trend*, not just presence-of
     -a-dip. Fixed in `validate.js`: replaced the no-dip rule with a
     least-squares linear regression fit through the sampled
     mean-brightness-vs-time curve; the fitted slope is extrapolated across
     a full `productionDurationSec` (3600s) and rejected if the *projected*
     rise exceeds `maxProjectedRise` (50 luma levels) — this catches net
     upward drift regardless of how many small local dips occurred along
     the way. Verified against a synthetic fixture engine that fades weakly
     and does a partial (not full) clear every 20s: correctly rejected
     (projected ~52 luma rise) where the old no-dip rule would have passed
     it. Also re-verified all three curated engines (`geometric`, `grid`,
     `kaleidoscope`) still pass comfortably under the new check.
4. **Titles are a few words** (mood + subject, e.g. "Calming Geometric
   Patterns") — not long tagged strings. Duration/use-case context belongs in
   the description, not the title (see `src/metadata.js`).
5. **Lively pace, not glacial.** A real complaint: motion was technically
   present but too slow to read as exciting (e.g. a full rotation taking
   30-100+ seconds is imperceptible moment-to-moment). Any rotation/
   oscillation/pulse rate should complete a cycle in roughly 4-15 seconds
   (rad/s roughly 0.4-1.5), and — same principle as the whiteout fix above —
   every motion-rate parameter needs a guaranteed minimum magnitude with a
   random sign (never a plain symmetric range like `rand(-0.3, 0.3)`, which
   can park an element near-motionless). When a "make it more exciting/
   dynamic" request comes in, the concrete fix is: audit every per-element
   rotation/oscillation-rate constant across the curated engines, and shorten
   `cycleSec` defaults for more frequent full-pattern regeneration. After
   changing kaleidoscope's motion rates, re-verified the whiteout fix still
   held at the (new) full cycle length — don't assume changing speed
   parameters is safe without re-running the full-cycle test from item 3.
   - **Prompt wording alone doesn't guarantee compliance — enforce it in
     `validate.js` too.** The prompt already told Gemini engines pace must
     be lively (see `generate.js`'s "LIVELY PACE" section), yet a real
     Gemini-generated engine still shipped with motion too slow to read as
     exciting (same run as the partial-reset whiteout above — item 3's last
     bullet). `validate.js`'s old `motion` metric only compared samples tens
     of seconds apart, so slow-but-technically-moving engines passed. Added
     a dedicated short-interval check: sample two frames ~1.5s apart
     mid-render and require the pixel change to be at least
     `minFastMotionStdFrac` (12%) of that frame's own `peakStd` (adapts to
     each engine's contrast instead of a fixed magic pixel value). Verified
     against a synthetic fixture that clears/redraws cleanly every frame
     (zero whiteout risk) but rotates once per 240s: correctly rejected for
     motion even though its brightness trend is perfectly flat.

## Editing engine/prompt template literals — a gotcha to know about

`src/generate.js`'s `buildPrompt`/`buildRepairPrompt` are giant backtick
template literals. A literal backtick typed into the prose (e.g. writing
`` `code` `` for emphasis) silently terminates the template literal at that
point — `node --check` will NOT catch this, because the remainder often
happens to re-parse as syntactically valid JS (the "leftover" text after the
stray backtick can become a bare expression statement, and a second stray
backtick opens a new template literal that swallows the rest of the file).
This shipped **twice** in one session — both times `node --check` passed
while the actual prompt was truncated/broken at runtime (a `ReferenceError`
the second time, since the "leftover" text happened to look like a function
call). **Always verify by actually calling `buildPrompt(...)` /
`buildRepairPrompt(...)` and checking the real output** (length, that it
contains expected section headers, that it ends where expected) — a passing
`node --check` is not sufficient proof the prompt text is intact. When writing
prose inside these template literals, avoid literal backticks entirely;
describe code in plain words instead of backtick-quoting it.

## Engine contract (all engines, curated + AI-generated)

URL params: `seed, palette, colors, width, height, fps, duration, speed,
density, cycleSec`. Exposes `window.READY / TOTAL_FRAMES / currentFrame /
advanceFrame() / advanceFrames(n)`. Deterministic (Mulberry32), no
`requestAnimationFrame`. `colors` (format `h,s,l;h,s,l;...`) overrides the
built-in palette — used for the image-of-the-day recoloring (`src/palette.js`).

## Engine selection each run (`src/index.js`)

1. If `GEMINI_API_KEY` is set: ask Gemini for a new engine, validate it
   (`src/validate.js` — visual quality gate + render-speed budget), one
   repair attempt on failure.
2. Otherwise (or if Gemini fails both attempts): pick the next curated
   engine in true round-robin order — `engines/manual/*.html`. Currently:
   `geometric`, `grid`, `kaleidoscope`. `engines/bloom.html` exists only as a
   last-resort emergency fallback if the manual pool is ever empty — it's
   organic, not the house style, and excluded from normal rotation.
3. For curated (non-Gemini) engines, `src/palette.js` recolors from that
   day's NASA APOD image when reachable (non-fatal if not).

### Curated fallback rotation is stateful, not date-hashed

A real complaint: two videos three days apart (2026-07-21 and 2026-07-24)
looked visually too similar. Both had fallen back to the curated pool
(Gemini failed both days, for unrelated reasons), and the old selection
logic picked `pool[seed % pool.length]` where `seed` is the `YYYYMMDD`
date string — a digit-sum hash. With only 3 curated engines, two dates
whose digit sums happen to agree mod 3 pick the *same* engine, entirely by
coincidence, regardless of how many Gemini-generated (visually distinct)
days fell in between. Fixed: `curatedOr()` now reads/writes a persisted
cursor in `state/engine-rotation.json` (`nextIndex`) and advances it by 1
(wrapping) every time a curated fallback actually happens, so the pool is
a true round-robin — `geometric → grid → kaleidoscope → geometric → …` —
and can never repeat an engine until the whole pool has cycled, no matter
the date or how sparse the fallbacks are. The state file is committed back
to the repo by a workflow step (`.github/workflows/daily.yml`, "Persist
engine rotation state", `git commit` + `git push origin HEAD:<ref>`),
which is why `permissions: contents: write` is required at the workflow
level (previously `contents: read` was enough, since nothing wrote back to
the repo). If `state/engine-rotation.json` is ever missing or corrupt,
`curatedOr()` bootstraps from the old date-hash as a one-time fallback,
so a fresh checkout doesn't crash.

## Known constraints / gotchas

- **YouTube channel verification is required** for the 1-hour long video to
  publish (unverified channels reject uploads >15 min: "Processing
  abandoned: Video is too long"). Verified as of mid-July 2026.
- **Render budget**: ~86,400 frames for a 1-hour/24fps video, ~55-80 min
  wall time on the Actions runner. `src/validate.js`'s speed gate rejects
  engines projected to blow the CI budget.
- Private repo Actions minutes are capped (2,000/month free tier) — an
  abandoned (rejected) 1-hour render still burns ~1-2h of CI time, so a
  verification regression is costly, not just annoying.
- This dev sandbox's network egress **blocks `api.nasa.gov`** — the
  image-of-the-day palette fetch can't be tested live here, only via the
  Actions runner (which has open internet). Test the rest of the
  `palette.js` pipeline (extraction, `colors` override) with a local image
  and `file://` URLs instead.
- `GEMINI_MODEL` defaults may lose free-tier quota over time (this has
  happened before — see `scripts/probe-gemini.js` to find a working model if
  Gemini starts failing every run).
- Git commits here will always show "Unverified" on GitHub (missing GPG
  signature) — this is expected in this environment and not worth chasing;
  don't rewrite deployed history to fix it.

## Testing engines locally (no ffmpeg render needed for a quick look)

Use Puppeteer directly to grab a mid-cycle frame as PNG instead of a full
video render — much faster for visual iteration:

```js
// grab.mjs — render N frames of an engine and save a PNG
import puppeteer from 'puppeteer';
import { pathToFileURL } from 'node:url';
const url = pathToFileURL(process.argv[2]);
const p = url.searchParams;
p.set('seed', process.argv[5] || '20260710');
p.set('width', '1280'); p.set('height', '720'); p.set('fps', '24');
p.set('duration', '3600'); p.set('cycleSec', '50');
if (process.argv[6]) p.set('colors', process.argv[6]);
const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const pg = await b.newPage();
await pg.setViewport({ width: 1280, height: 720 });
await pg.goto(url.href, { waitUntil: 'load', timeout: 30000 });
await pg.waitForFunction('window.READY === true', { timeout: 30000 });
await pg.evaluate((n) => window.advanceFrames(n), parseInt(process.argv[3]));
const d = await pg.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
const fs = await import('node:fs');
fs.writeFileSync(process.argv[4], Buffer.from(d.slice(d.indexOf(',') + 1), 'base64'));
await b.close();
// usage: node grab.mjs engines/manual/geometric.html 700 /tmp/out.png 20260710 "10,90,60;200,90,60"
```

Then use `node src/validate.js engines/manual/<name>.html` for the quality
gate (visual + speed), and view the PNG to actually judge vividness/clarity
before committing — the gate alone doesn't catch "dim" or "washed out."
