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

## 3D / WebGL engines are supported infrastructure, not just one engine

User request: "Add infrastructures to generate 3D pattern videos as well."
Everything up to this point was Canvas2D, including `wireframe.html`, which
fakes a 3D look by projecting polyhedron edges onto a flat canvas by hand —
not real per-pixel lighting or depth. `engines/manual/solids3d.html` is the
first CURATED engine using raw WebGL: real shaders, a depth buffer, and
per-face Lambertian lighting on solid (not wireframe) geometry. This is
also now a supported PATH for Gemini generation, not just a one-off hand-
written engine — `src/generate.js`'s prompt has a "3D / WEBGL" section and
`THEME_HINTS` includes explicit lit-3D theme entries — so this compounds
into the daily variety the same way the rest of the pool does.

Building this surfaced real infrastructure gotchas worth knowing before
touching WebGL in this codebase again:

- **`preserveDrawingBuffer: true` is mandatory.** The capture pipeline
  (`render.js`/`validate.js`) reads the canvas back via `drawImage`/
  `toDataURL` on a separate tick after `advanceFrame()`, not synchronously
  within the same draw call. Without `preserveDrawingBuffer: true` on
  context creation, that readback can see an already-cleared buffer and the
  whole video comes out black.
- **Headless software WebGL (swiftshader) intermittently fires a spurious
  `webglcontextlost` shortly after context creation.** Confirmed via
  repeated trials in this sandbox: roughly half of otherwise-identical
  launches lose context within ~100ms of creation, for a completely trivial
  single `gl.clear()` — not caused by shader/geometry complexity. Critically,
  **2000-frame stress tests never showed a loss after the first couple of
  frames** — it's a startup-only risk, not a continuous one, which makes it
  tractable: `solids3d.html`'s fix is to listen for `webglcontextlost`
  (call `preventDefault()` on the event, required for the context to become
  restorable) and `webglcontextrestored` (re-run ALL WebGL setup — shaders,
  program, buffers — from scratch), then hold `window.READY` back for ~300ms
  plus a short poll for recovery before declaring ready, instead of
  signalling ready immediately after context creation. Verified: 6/6 runs
  identical after the fix, vs. ~40% silently blank before it. Any future
  WebGL engine (curated or in the Gemini prompt) needs this same pattern —
  it's now documented in `generate.js`'s prompt too.
- **A fourth source of whiteout-heuristic false positives, specific to real
  3D with depth occlusion**: unlike the flat/additive engines, opaque
  depth-tested solids can occlude each other, so how much total lit area is
  *visible* (not accumulated — gl.clear() to opaque black every frame makes
  true cross-frame accumulation structurally impossible) genuinely swings
  with the 3D arrangement at each instant. Randomising things like orbit
  radius, object scale, or orbit phase (which can make objects randomly
  cluster and occlude each other, or spread out and reveal more total lit
  area) is enough to swing sampled brightness far more than the 2D engines
  ever do, occasionally reading as a fake trend to the regression check over
  a short sampled window. Mitigated (not eliminated) by fixing orbit
  radius/scale/phase and only randomising rotation rates and colors, plus
  raising the ambient light floor to reduce per-face lighting-angle
  variance — improved the pass rate substantially (most seeds now pass with
  large margins) but a small residual failure rate remains as an honest,
  inherent property of dynamic 3D occlusion, not a bug. This is fine in
  practice: curated engines never run through `validate.js` at runtime (see
  "Engine selection each run" below) — it's a design-time sanity check only.
- **Colors read pastel/washed by default with naive Lambertian shading.**
  Ambient + diffuse lighting multiplied onto an already fairly light HSL
  base color, plus an additive fresnel rim term, pushed lit faces toward
  near-white — directly against the "vivid, saturated, not pastel" house
  style. Fixed by lowering the base palette lightness, toning down the rim
  contribution, and adding a soft clamp on final fragment color
  (`min(base + rim, vec3(0.86))`) so no face can wash out to full white.

## Engine selection each run (`src/index.js`)

1. If `GEMINI_API_KEY` is set: ask Gemini for a new engine, validate it
   (`src/validate.js` — visual quality gate + render-speed budget), one
   repair attempt on failure.
2. Otherwise (or if Gemini fails both attempts): pick the next curated
   engine in true round-robin order — `engines/manual/*.html`. Hand-written
   core: `geometric`, `grid`, `kaleidoscope`, `starburst`, `wireframe`,
   `tessellation`, `solids3d` (the last one is real WebGL — see "3D / WebGL
   engines" above). Plus any `auto-YYYY-MM-DD-<theme-slug>.html` files — see
   "The curated pool grows daily" below. `engines/bloom.html` exists only as
   a last-resort emergency fallback if the manual pool is ever empty — it's
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
days fell in between. Fixed: `curatedOr()` reads/writes a persisted cursor
in `state/engine-rotation.json` every time a curated fallback actually
happens, so the pool is a true round-robin and can never repeat an engine
until the whole pool has cycled, no matter the date or how sparse the
fallbacks are.

**The cursor stores the last-used engine's NAME, not a numeric index** —
this was a deliberate second fix, not the original design. The pool now
grows over time (see below), and `curatedPool()` lists `engines/manual/`
sorted alphabetically; inserting a new file can shift every OTHER engine's
position in that sort order (e.g. adding `auto-2026-08-05-....html` sorts
before `geometric`, shifting it from index 0 to 1, `kaleidoscope` from 2 to
3, etc.). A persisted numeric index would silently point at a different
engine the moment the pool's shape changed, breaking the round-robin
guarantee with no error. Storing the name and looking up its current
position each run sidesteps this: "next after whatever we last used" is
always computed against the pool as it exists right now, so growth or
reordering can't cause a skip or a silent repeat. Verified locally: added a
file that sorts before every existing engine and confirmed round-robin
still visits all 7 with no repeat before wrapping.

The state file is committed back to the repo by a workflow step
(`.github/workflows/daily.yml`, "Persist rotation state and promoted
engines", `git commit` + `git push origin HEAD:<ref>`), which is why
`permissions: contents: write` is required at the workflow level
(previously `contents: read` was enough, since nothing wrote back to the
repo). If `state/engine-rotation.json` is ever missing/corrupt, or names an
engine no longer in the pool, `curatedOr()` bootstraps from the old
date-hash as a one-time fallback, so a fresh checkout doesn't crash.

### The curated pool grows daily (`promoteToCuratedPool()` in `src/index.js`)

User request: "generate one every day so it increases the possibility" —
more engines × Gemini themes × palettes × seeds compounds the space of
possible outputs (not literally a factorial, but the underlying instinct —
more independent factors multiply together — is right). Every day Gemini
produces an engine that passes the SAME quality gate used to approve it for
that day's actual published video, it is also copied into
`engines/manual/` as `auto-<date>-<slugified-theme>.html`, so it becomes a
permanent, hand-off-required-free addition to the curated fallback pool —
available on any future day Gemini fails or is disabled, forever after.
No extra quality bar beyond "good enough to publish today" — that's
already `validate.js`'s full visual + speed gate. Skipped on dry runs
(`--no-upload`/`DRY_RUN=1`) so test invocations don't leave permanent
files behind; escape hatch via `--no-promote` / `PROMOTE_ENGINES=0` if this
ever needs to be paused (e.g. if the pool is growing faster than desired,
or a bad engine slips through and needs investigating before more get
added). Runs even if the render/upload step later fails for unrelated
reasons (network, Actions-minutes cap) — an infra failure downstream
doesn't reflect on an engine that already passed the quality gate.

**A real bad engine got promoted, because the quality gate had a genuine
blind spot.** On 2026-08-09 a Gemini "isometric cube lattice" engine
passed validation and was published AND auto-promoted into the permanent
curated pool — then a user reported the video as "too white." Rendered
the actual promoted file (now a normal committed file, no artifact-
download workaround needed) at full 3600s duration: individual cube
shapes were clipped to solid white from essentially the first frame (not
a slow drift — confirmed by sampling from t=36s onward, already ~140/255
average). Root cause was NOT a missing reset (this engine's hard-reset
logic was actually correct, verified by reading it) — it was **local,
within-a-single-frame overexposure**: several additively-blended cube
faces, plus a stroke drawn in the same colour as its own fill (doubling
the contribution at the shared area), were dense enough to clip individual
cube shapes to solid white every single frame. `validate.js`'s
`maxPeakMean` check (252) missed it because black background between the
sparse cubes diluted the FRAME-WIDE average to ~140-157 — comfortably
under threshold — even though the shapes themselves were locally maxed
out. `peakStd` also stayed high (black background + white blobs still
reads as "structured"), and there was no accumulation trend to catch
either. This is a distinct failure mode from every prior whiteout
incident above: those were all about brightness *drifting* over time;
this one is bad from frame 1 and just wasn't being measured correctly.
Fixed in `validate.js`: added `peakNearWhiteFrac`, the fraction of sampled
pixels that are near-max brightness (luma > 248) at any one sample,
independent of the frame-wide average — rejects if it exceeds
`maxNearWhiteFrac` (12%). Verified against the actual bad engine (80.3%
of pixels near-white — an easy catch) and all 7 curated engines (all under
1%, comfortable margin). Removed the bad engine from `engines/manual/`.
Also added prompt guidance in `generate.js` against the two concrete
things that caused it: don't stroke a shape with the same bright colour as
its own additive fill, and don't let many overlapping shapes cluster
densely in one small region. Lesson: the promotion pipeline is only as
good as the gate it depends on — when a promoted engine turns out bad,
the fix belongs in `validate.js` (so it can't happen again for ANY
engine, hand-written or generated), not just in removing that one file.

### Even a fully clear-and-redraw engine can trip the whiteout heuristic

Third source of a "brightness trend" false alarm, distinct from the two
whiteout incidents above (which were about engines that genuinely
accumulate light across frames without a strong-enough reset).
`starburst.html` clears to solid black at the start of every single frame
— it is structurally impossible for it to accumulate anything across
frames — yet failed `validate.js`'s regression-based whiteout check at
seed=1 (projected ~58 luma rise, threshold 50). Root cause: its `config()`
randomised the nested star count 3–5 every ~40s cycle, and more stars means
more additive overlap area, i.e. a real (not accumulating) brightness
difference between cycles. With ~7 cycles inside the 300s test window, an
unlucky seed can make that legitimate cycle-to-cycle variance look like a
monotonic trend to a regression fit — the same statistical shape as a real
accumulation bug, from a completely different, harmless cause. Fixed at the
source (not by loosening the validator): fixed the star count at a
constant 4 instead of randomising it, removing the variance rather than
tolerating it. Verified across 8+ seeds afterward, all passing with a
healthy margin (worst case +10 vs. the -58...+58 swing before). Lesson: a
statistical "does the trend look like a whiteout" check can false-positive
on any engine whose *legitimate* per-cycle randomisation swings overall
canvas brightness a lot, not just on engines with a real reset bug — when
one fails, check whether the engine can even physically accumulate before
assuming the check found a real bug.

### Gemini's recent success rate is the real lever for daily variety — and it's currently poor

A user complaint on 2026-08-06 ("I've seen this kind of pattern a few
times recently") traced back to: `curatedOr()`'s round-robin IS working
correctly (verified: `geometric → grid → kaleidoscope`, in order, across
the three fallback days after the pool grew to 6 -- see git history of
`state/engine-rotation.json`), but Gemini failed validation on **5 of the
last 6 daily runs** (2026-08-02 through 08-06), so almost every recent
video has come from the still-small curated pool, and a viewer will
naturally perceive a repeat within a 3-6 day window even though the
rotation never coincidentally repeats. `promoteToCuratedPool()` hasn't
fired even once since it shipped, for the same reason -- it only runs on a
Gemini *success*, and there hasn't been one.

More strikingly, all 5 recent failures show the **exact same degenerate
validator signature** regardless of theme: `peak mean luma 255.00, peak
std 0.00, motion 0.00` -- a canvas that reads as perfectly uniform solid
white with ZERO spatial variance for the entire test window, not a gradual
whiteout drift. Five structurally unrelated themes ("flow field of fine
lines," "concentric rotating polygons," "recursive tessellation,"
"sacred-geometry lattice," "wireframe tunnel flythrough") independently
producing the identical failure signature is a strong signal of something
systemic (a model-quality dip, or a subtle prompt issue), not five
coincidentally-different code bugs. Response times/lengths look normal
(12-16KB HTML each) -- not a truncated/empty-response case.

**Could not root-cause the actual generated code**: `engines/auto/*.html`
is git-ignored (ephemeral per run) and only preserved as a GitHub Actions
artifact, whose download URL points at Azure blob storage
(`productionresultssa*.blob.core.windows.net`) -- this dev sandbox's
egress policy blocks that host (confirmed via the agent-proxy status
endpoint: `connect_rejected`, "gateway answered 403 to CONNECT"). Do not
keep retrying that download; it's a policy block, not a transient
failure. `GEMINI_API_KEY` is also not set in this sandbox, so the failing
prompt can't be reproduced live here either.

**Fixed instead**: added `logEngineSnippet()` in `src/index.js`, called on
every validation failure (first attempt and repair). It logs the first 500
chars of the generated `<script>` body plus a scan for a few suspicious
tokens (`white`, `#fff`, `rgba(255,255,255`, `getContext('webgl'`)
directly into the job log -- readable via `get_job_logs` alone, no
artifact download needed. Next time this failure signature recurs, the
actual generated code (or at least its opening section and any obviously
suspicious tokens) will be visible without hitting the network-blocked
artifact path. If the snippet points at a specific bug pattern, fix
`generate.js`'s prompt at the source, the same way the other whiteout
incidents were fixed once the actual code was visible.

### Standing requirement: every video should look new, not just non-repeating

User-stated durable rule (not a one-off fix): each day's video should read
as genuinely new/creative, not merely "not an exact repeat of yesterday."
Two mechanisms currently drive day-to-day variety, and BOTH had the same
underlying bug independently:

- Curated engine choice (`curatedOr()` in `src/index.js`) — fixed above via
  `state/engine-rotation.json`.
- Gemini's creative-direction theme (`THEME_HINTS` in `src/generate.js`) —
  had the *identical* `hashStr(date) % list.length` bug. A real complaint:
  two consecutive days picked "concentric rotating regular polygons...
  vortex" and "recursive geometric tessellation of triangles and
  hexagons... rotating" — different hints, but conceptually close, because
  nothing steered selection toward the unused part of the list. Fixed the
  same way: `nextThemeHint()` reads/writes a persisted cursor in
  `state/theme-rotation.json`, so all 20 hints get used once before any
  repeat. **Caught a real correctness bug while fixing this**: the one
  Gemini repair attempt (`chooseEngine()` in `src/index.js`) called
  `generateEngine()` a second time *without* passing through the first
  call's `themeHint`, so it silently re-derived one instead of reusing it.
  This was invisible under the old date-hash scheme (idempotent per date,
  so both calls happened to agree by construction) but would have been a
  real bug the moment theme selection became stateful — a repair call
  would advance the rotation AND switch creative direction mid-repair
  instead of just fixing the reported problems. Fixed by having
  `chooseEngine()` explicitly pass `themeHint: gen.themeHint` on the repair
  call. Lesson: when converting a date-hash pick to a stateful rotation
  elsewhere in this codebase, check every caller for an implicit
  idempotency assumption the date-hash was quietly providing.
- Both `state/*.json` cursors are committed by the same workflow step
  (`.github/workflows/daily.yml`, "Persist rotation state", which now does
  `git add state/` rather than naming one file, so any future state file
  under `state/` is covered automatically).
- Residual limit worth remembering: with only 3 curated engines and 20
  theme hints, round-robin guarantees no *coincidental* repeats, but if
  Gemini fails validation on most days in a row (it has, in bursts — see
  the render-cost / Actions-minutes gotcha below, and check whether
  `validate.js` has gotten stricter than Gemini can reliably satisfy if
  failures cluster), the pipeline leans hard on the 3-engine curated pool
  and *will* cycle back to the same curated engine every 3rd fallback day,
  which reads as repetitive even though it's not a bug in the rotation
  logic itself. If that pattern recurs, the next lever is expanding the
  curated pool (more hand-written `engines/manual/*.html` entries) rather
  than re-tuning the rotation, since the rotation is already working
  correctly at 3-wide.

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
