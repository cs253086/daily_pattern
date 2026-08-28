# daily_pattern — project guidance

Automated pipeline: renders a daily generative-art video (1 hour) + a 30s
Short, both with procedurally generated ambient music (see "Ambient music"
below), uploads both to the "Pattern Flow" YouTube channel. Runs via GitHub
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
   - **This was prompt-only guidance with no numeric enforcement, and a real
     curated engine violated it.** `validate.js` checked brightness/
     structure/motion/local-whiteout but had zero awareness of colour
     saturation — an engine could pass every check while reading as grey/
     pastel. Investigating a user complaint ("colors should be vivid")
     surfaced that `kaleidoscope.html`'s `ice` palette (and the identical
     copy in all 6 other curated engines, having been copy-pasted across
     them) used HSL saturation 56-76% / lightness 72-78%, well outside the
     70-95%-saturation / ~58-66%-lightness range every other palette in the
     same table uses — a real, already-shipping pastel-washout bug that had
     gone unnoticed because nothing measured it. Confirmed visually
     (rendered `kaleidoscope` at `seed=5`, which selects `ice`): a washed
     lavender-grey mandala, not vivid at all. Fixed the `ice` palette in
     all 7 curated engines to the same saturation/lightness range as every
     other palette (kept the same cool hue spread, 185-270°, so it's still
     recognisably "icy," just not desaturated). Also added a `validate.js`
     check (`avgSat`, mean HSL saturation of non-background/non-blown-out
     pixels across the sampled window, `minAvgSat: 22`) so this class of
     bug — in curated engines *or* Gemini output — can't silently ship
     again. Verified: a synthetic pastel fixture (18% saturation) is
     correctly rejected; all 7 curated engines pass with a wide margin
     (29-67 vs. the 22 threshold); the fixed `kaleidoscope`/`ice` combo
     went from 16.0 to 35.5.
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
6. **Video descriptions never reveal that the pipeline is automated.**
   User request 2026-08-15: no "generated automatically," "fully automated
   pipeline," "AI-and-code generated," or raw `Seed:`/`Engine:` debug
   fields in the public-facing description — viewers care what the video
   is like to watch, not the production process behind it. `metadata.js`'s
   description now describes the visuals and (accurately, based on
   `hasAudio`) the audio, with no mention of how either was made. Genre
   terms like "generative art"/"procedural art" are kept (established art-
   genre vocabulary real human artists use too, not an automation
   confession, and good for discovery) — the one tag that crossed the line
   (`ai generated art`) was removed. If ambient music (currently off by
   default, see "Ambient music" below) gets re-enabled, the description
   automatically switches from the "completely silent" paragraph to one
   describing the soundtrack — don't let these two drift out of sync if
   editing either.

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

## Ambient music (`src/stockMusic.js`)

**ON by default** (`cfg.music` defaults to `true` in `resolveConfig()`,
`src/render.js`) as of 2026-08-17 — user request ("insert license free
music in each video"). Disable with `--music=0` / `MUSIC=0`, or set the
repo variable `vars.MUSIC=0` (wired into `.github/workflows/daily.yml` the
same way as `IMAGE_PALETTE`) if it ever needs to be turned off again
without a code change.

### Source: real CC0 tracks fetched from Freesound.org, not synthesized

**Superseded design, 2026-08-19** — user request: "don't make music
yourself. get a license free music somewhere." The original design (see
git history / the deleted `src/audio.js`) procedurally synthesized ambient
pad tones + a pentatonic melody from scratch each day, specifically to
avoid the unmanaged copyright risk of externally-sourced "royalty-free"
tracks in this unattended, no-human-review pipeline (licenses vary,
misattribution is easy). That reasoning was sound for *some* external
source, but the user explicitly wants real fetched music, not something
generated in-house — so the design changed to fetch real tracks while
preserving the same safety property a different way: **restrict the
source to CC0-licensed tracks only**. CC0 (public-domain-equivalent)
requires zero attribution and carries no license-compliance risk to get
wrong unattended, unlike CC-BY (needs correct attribution in every video,
an easy thing to get subtly wrong at scale) or CC-BY-NC (unusable on a
monetizable channel). This is the same underlying principle as before —
minimize unmanaged legal exposure in a pipeline nobody reviews before it
publishes — just satisfied by filtering rather than by generating.

**Provider choice was investigated, not assumed.** Pixabay was the first
candidate (recommended for its true no-attribution-required Content
License), but its documented public REST API
(`https://pixabay.com/api/docs/`) covers Images and Videos only — no
music/audio search endpoint could be confirmed to exist via web search,
and `pixabay.com` itself is blocked by this dev sandbox's network egress
policy (confirmed via the agent-proxy status endpoint), so the docs page
couldn't be loaded directly to verify either way. Rather than build
against a guessed endpoint that might not exist and would then silently
do nothing forever, this was flagged to the user, who chose
**Freesound.org** instead — a long-established, well-documented public
API (`https://freesound.org/apiv2/`) I have much higher confidence
actually exists as described.

**Design (`src/stockMusic.js`, mirrors `src/palette.js`'s NASA-APOD
integration closely):**
- `dailyStockTrack({ date, seed, apiKey, destPath })` — date+seed-
  deterministic (same day always picks the same query/results-page/track
  index), matching this project's "same seed → same everything"
  reproducibility convention.
- Calls Freesound's `/search/text/` endpoint with
  `filter=license:"Creative Commons 0" duration:[25 TO 480]` (CC0 only;
  25–480s so an hour-long loop doesn't repeat every few seconds) and a
  rotating pool of ambient-leaning query terms, then downloads the
  chosen result's pre-rendered MP3 "preview" file (no OAuth2 needed —
  a simple `token` query param is sufficient for search + preview
  download; OAuth2 is only required for the original non-preview file,
  which isn't needed here).
- **Fully optional and non-fatal**, same contract as `palette.js`: no API
  key, a network error, zero CC0 results, or a download failure all
  return `null` rather than throwing — the caller just ships a silent
  video, exactly like before this feature existed. Verified locally: with
  `FREESOUND_API_KEY` unset, logs a warning and returns `null` without
  crashing; with a dummy key (freesound.org is also blocked in this
  sandbox, same as pixabay.com/NASA/YouTube), the real HTTP failure is
  caught and logged with the actual response body, still returning `null`
  cleanly rather than throwing.
- **Requires a `FREESOUND_API_KEY` secret** (free — register at
  `https://freesound.org/apiv2/apply/`) to actually do anything; wired
  into `.github/workflows/daily.yml` next to the other API-key secrets.
  Without it, the pipeline behaves exactly as if music were disabled
  (silent videos, no error) — this is a soft dependency, not a hard one.
- **This integration could not be exercised end-to-end against the real
  API in this dev sandbox** (`freesound.org` is blocked, same situation as
  `api.nasa.gov`/`youtube.com`/`pixabay.com` — confirmed via the
  agent-proxy status endpoint, not assumed) — only the GitHub Actions
  runner has open internet to it. If the exact search/response shape
  above turns out to be subtly wrong, `dailyStockTrack`'s catch-all logs
  the real error (including the response body on a non-2xx search
  result), so the next run's job log will show the actual problem instead
  of a silent no-op — the same diagnose-from-job-logs pattern already
  established for Gemini engine failures (`logEngineSnippet` in
  `src/index.js`) and for the NASA integration.

**Pipeline wiring**: `src/index.js` fetches the day's track *before*
calling `render()` (same position as the NASA palette fetch), passing the
local downloaded file path through as `renderCli.musicTrackPath`.
`src/render.js` itself does no network fetching — it just takes whatever
local file path it's given (or none) and, if present, loops it with
ffmpeg's `-stream_loop -1` while stream-copying the already-rendered
video, trimming to the video's exact length with `-shortest`. Verified
locally with a real ffmpeg build (installed in this sandbox specifically
to test this) and a synthetic 3-second test track: an 8-second render
correctly produced an 8.0-second output with both video and AAC audio
streams (via `ffprobe`), confirming the loop-to-length behavior works,
and a render with no track path given correctly fell back to a valid
silent video (`hasAudio: false`).

A short courtesy credit line — `Music: "<title>" by <username>
(freesound.org, CC0 license).` — is added to the video description when a
track was used (`src/metadata.js`'s `musicCreditLine`, same pattern as the
NASA image credit line). Not legally required for CC0 content, but good
practice, and it costs nothing to include.

**Non-fatal by design end-to-end**: muxing is still wrapped in a
try/catch in `render()` exactly as before — any failure renames the
video-only temp file to the final `long.mp4` path and the render
continues normally (silent) rather than losing the whole day's render.
`render()`'s return value still includes `hasAudio` so callers can log or
react to which path was taken, and `metadata.js` only shows audio-related
copy (the audio paragraph, the music credit line) when `hasAudio` is
actually true.

## Engine selection each run (`src/index.js`)

1. If `GEMINI_API_KEY` is set: ask Gemini for a new engine, validate it
   (`src/validate.js` — visual quality gate + render-speed budget), one
   repair attempt on failure.
2. Otherwise (or if Gemini fails both attempts): pick the next curated
   engine — **dimension-weighted round-robin**, see below — from
   `engines/manual/*.html`. Hand-written core: `geometric`, `grid`,
   `kaleidoscope`, `starburst`, `wireframe`, `tessellation`, `solids3d`
   (real WebGL — see "3D / WebGL engines" above), `lattice3d` (second real
   WebGL engine — a dense fixed-position 3D grid of independently-spinning
   cubes on a single-axis turntable, deliberately a different 3D
   composition from solids3d's sparse orbiting solids), `torusrings3d`
   (third real WebGL engine — lit tori/rings with a rounded silhouette,
   sharing no geometry with solids3d's faceted solids or lattice3d's cube
   grid; added specifically to widen the 3D bucket after a real
   over-concentration incident, see "A real regression from the fix
   above" below), `spirograph`
   (glowing hypotrochoid/epitrochoid curves — a smooth continuous-curve
   texture, distinct from every polygon/tile/ring/lit-solid engine above),
   `arcrings` (bold segmented rotating "radar" rings, distinct from
   `geometric`'s full polygons and `kaleidoscope`'s mirrored stamps),
   `cascade` (directional top-to-bottom falling-block cascade with NO centre
   or radial symmetry at all — see "Archetype clustering" below for why this
   one exists). Plus any `auto-YYYY-MM-DD-<theme-slug>.html` files — see
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

### Curated fallback (and Gemini theme selection) is dimension-weighted toward 3D

User request 2026-08-19: "generate more 3d patterns than 2d patterns."
Before this, `curatedOr()`'s round-robin treated the whole pool as one flat
list — with only `solids3d` as real 3D out of ~12 engines, a flat
round-robin structurally could never give 3D more than its ~1/12 share no
matter how "fair" the rotation was.

Fixed by splitting the curated pool into two independent buckets and
round-robin cursors: a **3D bucket** (real WebGL engines, detected by
content-sniffing each file for `getContext('webgl'`/`getContext('webgl2'`
— not a hardcoded name list, so future hand-written OR Gemini-promoted 3D
engines are picked up automatically) and a **2D bucket** (everything
else). Each fallback day, which bucket to draw from is a deterministic
65/35-weighted pick hashed from the seed (`hashStr(`${seed}:dim`) % 100 <
65`) — not true randomness, to preserve this project's "same seed → same
everything" reproducibility convention — then a normal round-robin picks
the next unused engine *within* that bucket, so neither bucket can repeat
an engine before it fully cycles. Falls back to whichever bucket is
non-empty if the other is (e.g. before any 3D engine existed).

Building this exposed a real gap: only one 3D engine (`solids3d`) existed,
so weighting 65% of days toward "the 3D bucket" would have meant 65% of
days literally repeating the same single file — not real 3D *variety*,
just more frequent repetition of one thing. Added `lattice3d.html` (a
second, compositionally distinct real-WebGL engine — a dense fixed-grid
lattice of independently-spinning cubes on a single-axis turntable, vs.
solids3d's sparse orbiting solids) specifically so the 3D bucket has real
alternation to offer, not just a de-facto single choice. Iterated on its
camera/spacing before shipping: an initial version at tight spacing and a
close camera read as an indistinct clustered blob (visually
indistinguishable from solids3d's own composition, defeating the point);
widening the spacing, pulling the camera back, and switching from a
two-axis tumble to a single-axis turntable (a tumble on both axes
foreshortens a grid into an overlapping mess at some rotation angles,
losing the "ordered lattice" read) fixed this — verified by actually
rendering frames and looking at them, not just passing `validate.js`,
per the standing "look at it" visual-requirements rule. `validate.js`
passes across 5 tested seeds with a healthy margin (avgSat 51.6–57.6 vs.
the 22 minimum; motion, near-white, and whiteout-projection checks all
comfortably clear).

The exact same weighting change was applied to Gemini's theme selection
(`nextThemeHint()` in `src/generate.js`), not just the curated fallback:
`THEME_HINTS` was split into `THEME_HINTS_2D` and `THEME_HINTS_3D` (note:
"rotating 3D wireframe polytope" stays in the 2D bucket despite the "3D"
in its text — it's a flat Canvas2D edge projection like `wireframe.html`,
not real lit depth, so it doesn't get the weighting boost), each with its
own persisted round-robin cursor in `state/theme-rotation.json`
(`next2D`/`next3D` replacing the old flat `nextIndex`), picked via the
same 65/35 seed-hashed bucket choice. So a Gemini success is now also more
likely to land on a genuinely-3D theme than a 2D one, keeping both paths
consistent with the user's request regardless of which one actually
produces that day's video.

Both `state/*.json` files gracefully migrate from their pre-weighting
schema (a single `lastEngine` / `nextIndex`) rather than discarding it: on
first run after this change, whichever bucket the old cursor's engine/
theme actually belongs to gets seeded from it (preserving the
no-immediate-repeat guarantee for that bucket), and the other bucket just
bootstraps fresh from the date-hash, same graceful-degradation pattern
already used for missing/corrupt state elsewhere in this project.

Verified end-to-end (not just the weighting math in isolation) by
temporarily exporting `curatedOr()`/`nextThemeHint()`, backing up the real
`state/*.json` files, running each function ~40 times with varying seeds
against production code, and restoring the backups afterward: curated
fallback picked the 3D bucket 70% of the time (N=40, consistent with the
65% target), theme selection picked 3D exactly 65% of the time (N=40),
neither bucket ever immediately repeated an engine/theme within its own
sequence, and the old-schema migration was confirmed live (a real
`lastEngine: "tessellation"` file correctly seeded `last2D` and the very
next pick was `wireframe`, the correct next-in-order 2D engine after
tessellation).

### A real regression from the fix above: fixed weighting against a tiny bucket over-concentrated one engine

User complaint 2026-08-22 (with a screenshot of `solids3d.html`'s cube/
octahedron composition): "shame. same pattern over and over again... do
the deep research how you can avoid the same pattern repeated." Traced to
the exact 65/35 dimension-weighting shipped the day before: at the time,
the 3D bucket held only 2 engines (`solids3d`, `lattice3d`). Splitting a
fixed 65% weight two ways gave `solids3d` alone roughly a **32.5% chance
on every single curated-fallback day** — a WORSE single-engine repeat
rate than the flat, unweighted ~13-engine round-robin this project ran
*before* dimension-weighting existed at all (~7-8% per engine). Confirmed
against the actual video in question: that day's real job log showed
Gemini failing with a genuine runtime error (`Cannot read properties of
null (reading '1')` in the generated engine), falling back to curated,
and `curatedOr()` picking `solids3d` from the 3D bucket exactly as the
math predicted.

**Root cause, in one sentence: a fixed percentage weight applied against
a bucket too small to support it concentrates exposure on whichever few
engines happen to be in that bucket** — "more 3D than 2D" and "no engine
should repeat too often" are two different goals, and satisfying the
first blindly can actively work against the second. Fixed two ways, not
just patched for this one instance:

1. **Made the weighting self-correcting** (`effectiveP3D()` in
   `src/index.js`, `effectiveThemeP3D()` in `src/generate.js`): the 65%
   target is now a ceiling, capped by `Math.min(desiredP3D,
   maxSingleEngineFreq * bucketSize)` with `maxSingleEngineFreq = 0.20` —
   no single engine's expected pick frequency can exceed ~20% regardless
   of how small its bucket is, and the full 65% target only unlocks once
   the bucket has enough members to support it (4+, since 0.65/4 ≈ 16%).
   This self-adjusts as the pool grows (via `promoteToCuratedPool()` or
   the daily creative-research routine, see below) without needing a
   human to notice and manually re-tune a percentage again — the exact
   kind of systemic fix asked for, rather than another one-off patch.
   Verified: `effectiveP3D(2) = 0.40` (was blindly 0.65), `effectiveP3D(4)
   = 0.65` (cap no longer binds once the bucket is big enough).
2. **Grew the 3D bucket immediately** rather than waiting on the slow
   trickle from the daily research routine: added `torusrings3d.html`, a
   third real-WebGL curated engine — lit tori (rings), a rounded
   silhouette sharing no geometry with `solids3d`'s faceted
   cubes/octahedra or `lattice3d`'s cube grid. With 3 engines in the
   bucket, `effectiveP3D(3) = 0.60`, giving each engine ~20% instead of
   the previous 32.5%.

**Building `torusrings3d.html` surfaced three more real bugs, each found
only by actually rendering frames (or running `validate.js` across
multiple seeds) and looking at the result, not by reasoning about the
code in the abstract:**
- *Unbounded 2-axis tilt + a whole-scene turntable periodically presented
  a ring completely edge-on* — a thin pill/rod, not recognisable as a
  ring at all. Root cause: a torus's silhouette genuinely degenerates to
  a line at 90 degrees of tilt, and an *unbounded* rotation (whether on
  the ring's own axes or a shared world turntable compounding with them)
  necessarily sweeps through every possible angle over time, including
  that one. Fixed by dropping the whole-scene turntable entirely and
  bounding each ring's own tilt to a fixed base angle plus a small
  oscillation, so the worst-case combined tilt (base ≤ 0.55 rad + wobble)
  never approaches the 90-degree edge-on point.
- *That fix then failed `validate.js`'s fast-motion check* — rotating a
  torus around its own hole axis is silhouette-invariant (rotationally
  symmetric by construction), so with only a small tilt-wobble on top
  there was almost no frame-to-frame pixel change for a motion detector
  to see, even though the ring was technically spinning. Fixed by making
  the bounded tilt-wobble itself the primary, larger source of visible
  motion (amplitude and rate raised substantially) rather than relying on
  the silhouette-invariant spin.
- *Even with a bigger wobble, 2 of 6 tested seeds still failed* — each
  ring's wobble is a sine wave, which has near-zero angular velocity at
  its own peaks/troughs, and with fully-random per-ring phases some seeds
  happened to sample the validator's 1.5s test window at a moment where
  all 3 rings were coincidentally near their slow points simultaneously.
  Fixed by explicitly staggering the 3 rings' wobble phases ~120 degrees
  apart (plus small jitter) instead of leaving them fully random,
  guaranteeing at least one ring is always near peak angular velocity
  regardless of when the sample lands. Verified: all 6 previously-tested
  seeds pass afterward (avgSat 49.8-55.4, well above the 22 minimum;
  fastMotion 5.26-7.94, all above their per-frame floors; projectedRise
  well under 50; zero near-white pixels; 19.7-24.1min projected full-hour
  render time).

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

**Update, 2026-08-13**: the diagnostic above worked for the first time (a
user complaint about a repeated `grid.html` video led to checking recent
history, which turned up real failure logs with real snippets) but the
first-500-chars capture turned out to be nearly useless in practice: that
range is *always* the boilerplate URL-param/canvas-setup header, never the
actual draw loop, for essentially every engine Gemini writes (they all
front-load the same kind of setup code). Two checked failures both showed
the same combined signature: "shapes are locally blown out to solid white"
*together with* "motion is too slow... only 0.00-0.01 luma diff" -- which
in combination point at the canvas rendering something bad once and then
effectively *freezing* (a static frame is simultaneously blown-out and
zero-motion by definition), a genuinely different bug shape from every
prior whiteout incident (all of which were about brightness *drifting*,
never a frozen frame). Still couldn't pin down the exact cause -- the
first 500 chars are never the relevant code, and `GEMINI_API_KEY` isn't
set in this sandbox to reproduce live. Fixed `logEngineSnippet()` to also
locate and print ~1400 chars of context around the REAL `advanceFrame`
assignment (distinguished from an earlier placeholder like `window.
advanceFrame = null;`, seen verbatim in a real failed engine, by matching
an actual `advanceFrame = function`/`advanceFrame = (` pattern and taking
the *last* such match) -- verified against a synthetic fixture reproducing
that exact null-placeholder-then-real-assignment shape: correctly skips
the placeholder and captures the real render loop. Next occurrence should
finally be diagnosable enough to fix `generate.js`'s prompt with real
evidence instead of guessing.

**In the meantime, mitigated the symptom directly**: since a finite
curated pool mathematically must repeat within (pool size + 1) fallback
days no matter how good the round-robin is, and Gemini's success rate
alone can't be fixed without live reproduction, added two more hand-written
curated engines (`spirograph`, `arcrings` -- see "Engine selection each
run" above) purely to extend that runway now rather than wait on a Gemini
root-cause. `spirograph` hit the SAME whiteout-regression false positive as
`starburst` and `solids3d` before it (randomising curve count and the R/r
loop-density ratio swings total stroke overlap/coverage a lot between
cycles, read as a fake trend by the regression fit) -- fixed the same way,
by fixing those two parameters and only randomising shape details that
don't swing overall coverage (loop size `d`, epicycloid/hypocycloid choice,
rotation, colour). This is now a well-established pattern across four
engines: when a *legitimately* clear-and-redraw engine fails the whiteout
check, look for a randomised parameter that changes how much of the frame
is covered/overlapping, not an actual accumulation bug.

### Archetype clustering: engine-identity rotation isn't the whole story

A 2026-08-14 complaint ("another similar pattern") traced to `curatedOr()`
correctly cycling to `kaleidoscope.html` -- verified: this was the exact
next engine after `grid` in the (now 10-wide, alphabetically-sorted) pool,
the first fallback to actually run against that expanded pool. The
rotation logic was not broken. But investigating *why* it still read as
"the same pattern" surfaced a real, different problem: `kaleidoscope`,
`starburst`, and `spirograph` -- three separate files, never violating the
round-robin's no-immediate-repeat guarantee -- all render the same basic
*archetype*: centred, radially-symmetric, mandala-like. A viewer doesn't
parse "mirrored stamps" vs. "star polygons" vs. "hypotrochoid curves" as
different constructions; they see "circular symmetric pattern, again."
Engine-identity round-robin is already mathematically optimal for what it
guarantees (no repeat of the same file until the whole pool cycles) --
it has no concept of two *different* files looking similar, and 30% of
the pool sharing one silhouette is enough to read as repetitive even with
perfect rotation.

Fixed by adding `cascade.html`: deliberately NO centre and NO radial
symmetry -- a directional top-to-bottom field of falling/rotating blocks,
phase-staggered by column for a diagonal sweep, with hue tied to
horizontal position (not radius) for a left-to-right colour gradient
instead of a radial one. This is a distinct pattern from every other
engine in the pool along an axis (centred-symmetric vs. directional-
flowing) that plain engine-identity tracking can't see. If more
"everything feels similar" complaints recur even with correct rotation,
audit the pool for *archetype* balance (centred/radial vs. grid/tiled vs.
directional/flowing vs. lit-3D), not just engine count -- a bigger pool
of engines that all share one composition doesn't actually fix perceived
repetitiveness.

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

## Composable multi-factor engine + image-derived structure (`composer.html`)

User request 2026-08-19: "we could [have] unlimited creative patterns if
we have many factors and mix them together randomly everyday," plus a
follow-up idea, "you can also generate a pattern based on images." Every
lever up to this point (more engine files, dimension-weighted rotation,
archetype diversity) still ultimately picks ONE discrete file from a
finite pool each day — more files helps, but it's addition, not
multiplication, and the pool was already showing signs of feeling
repetitive well before it could grow large enough to feel truly
"unlimited." `composer.html` addresses this a structurally different way:
one engine whose composition is built from **independent randomized
factors that combine multiplicatively**, plus a **second, independent axis
of variety driven by that day's actual NASA APOD photo content**, not just
its colour palette.

**Factors** (`LAYOUT` x `SHAPE`, 4 x 3 = 12 combinations from one file):
- `LAYOUT`: `radial` (one ring of large elements around centre),
  `grid` (regular lattice), `directional` (falling/drifting columns),
  `rings` (multiple concentric rings) — deliberately spanning the same
  centred/grid/directional archetype axis documented in "Archetype
  clustering" above, so this one engine alone covers ground that used to
  require several separate files.
- `SHAPE`: `polygon`, `star`, `wedge` (arc segment) — what each element
  in the layout actually looks like.

**Why LAYOUT/SHAPE are picked ONCE per video (from the seed), not
re-picked every `cycleSec` reconfigure**: this is the fourth occurrence of
the whiteout-regression false-positive bug class documented earlier for
`starburst`/`spirograph`/`solids3d` — randomising *any* parameter that
changes how much of the frame is covered/overlapping between reconfigure
cycles reads as a fake brightness trend to `validate.js`'s regression
check, even on a structurally clear-and-redraw engine. Different LAYOUTs
have very different total ink coverage, so re-picking LAYOUT every cycle
would be the same bug at a larger scale. Fixing both per video (like every
other seed-derived choice in this codebase, e.g. palette selection) avoids
this entirely while still giving 12 distinct compositions across days;
`config()` still re-randomises non-coverage-affecting per-cycle details
(colours, rotation/orbit rates, per-element phase) exactly like every
other curated engine.

**Two more failure modes found only by actually rendering frames and
looking at them** (per the standing "look at it" visual-requirements
rule — a first version passed `validate.js` cleanly while looking broken):
- *Independent per-element orbit rates scatter a ring apart over time.*
  `radial`/`rings` elements started evenly spaced around a circle, but
  each was initially given its OWN random orbit rate — geometrically still
  a perfect circle at any instant (confirmed by dumping actual computed
  positions via a temporary debug hook), but visually the elements drift
  in and out of alignment and the "ring" reads as scattered points once
  rendered. Fixed by giving each ring ONE shared orbit rate for all its
  elements (a rigid group, like `arcrings.html`'s rings-rotate-as-one-unit
  design) — the ring still visibly rotates, but never loses its shape.
- *Geometrically correct isn't the same as perceptually legible.* Even
  with rigid rotation, an initial `rings` layout with only 4-6 elements
  per ring (verified via the same debug dump to genuinely be an even
  circle) still didn't read as "concentric rings" to the eye — human
  perception needs enough points along a circle to connect them into a
  ring shape without relying on motion. Fixed by roughly doubling density
  per ring (9-13 elements) and widening the radius gaps between rings.
  The `directional` layout had an analogous problem (too few, too-sparse
  elements per column to read as a coherent falling stream) — fixed by
  increasing elements-per-column and, more effectively, giving every
  element in a column the SAME shared colour (not just the same shared
  fall rate), which reinforces the "these belong to one stream" read even
  where the vertical gaps are still fairly wide.

**Image-derived structure, not just colour** (`src/palette.js`): until
now, the daily NASA APOD image only contributed a 5-colour palette
(`dailyImagePalette`/`encodeColors`, used by `colors=h,s,l;...`). Extended
`extractImageData()` to also sample a low-res (8x5) luminance grid from
the SAME already-loaded image in the same Puppeteer session (no second
fetch/decode) — the browser's own image-scaling does the per-region
averaging for free: drawing the full image into a tiny gw x gh canvas and
reading those pixels back approximates the average brightness of each
region. Encoded as a new `lum=gw,gh:v1,v2,...` URL param
(`encodeStructure()`), wired through `src/index.js` (fetched alongside the
palette, harmless no-op for every engine except `composer.html`) and
`src/render.js`/`resolveConfig()` exactly like `colors`. `composer.html`
samples this grid at each element's layout-relative `(u,v)` position (e.g.
literal grid-cell coordinates for the `grid` layout, angle/radius for
`radial`/`rings`) to modulate per-element size (0.82-1.18x) and hue shift
(±20°) — bounded ranges chosen so the image's actual content visibly
shapes the composition without being able to break vividness or
structural readability. Falls back to a structured-but-random per-element
value when no `lum` param is present (no image today, or an engine other
than `composer.html`), so the code path — and its visual character —
doesn't depend on whether that day's image fetch happened to succeed.
Verified locally with a synthetic left-dark/right-bright test grid (since
`api.nasa.gov` is blocked from this dev sandbox, same as every other
external integration here): the rendered grid layout showed a clear
cool-to-warm hue gradient left-to-right with a visible size difference,
confirming the modulation works end-to-end.

Verified: `validate.js` passes across all 12 LAYOUT x SHAPE combinations
(found via a small offline classifier script that replicates the engine's
own `rng()` sequence to locate a seed for each combo) with healthy margins
— avgSat 44-56 (vs. the 22 minimum), projectedRise well under the 50
threshold, zero near-white pixels, and a ~10.6min projected full-hour
render time (well within the CI budget). Being a plain Canvas2D engine
(`getContext('2d')`, no WebGL), it's automatically classified into the 2D
bucket by the dimension-weighted rotation above — no extra wiring needed.

## Cellular automaton engine (`automaton.html`) — 2026-08-25

Daily creative-research routine. Surveyed the existing curated pool first:
every engine falls into one of a small number of composition archetypes
(centred radial mandala, grid/tile, directional flow, lit-3D, or
`composer.html`'s multi-factor combination of those same archetypes) built
from continuous parametric motion (rotation, orbit, wave) on top of a fixed
structural rule. None of them are a discrete-time GENERATIVE process in the
mathematical sense — nothing grows/evolves step by step from a simple local
rule. Researched cellular automata, Voronoi/Delaunay diagrams, L-systems,
flow-field particles, moiré interference, string-art, and reaction-diffusion
as candidates; picked a **1D elementary cellular automaton** (Wolfram rule
90 or 150, chosen per cycle) because it's a genuinely different technique
(step-by-step emergent generation, not continuous transform), it's naturally
geometric (crisp cells, not organic blobs), rule 90/150 starting from a
symmetric seed produces mirror-symmetric Sierpinski-triangle-family
fractals (satisfying the house style's symmetry preference for free), and
it needs zero external libraries — just a lookup on 3 neighbouring bits.

**What it is**: a row of cells on a wrapped (toroidal) ring evolves one
generation per rule application; time is visualised as flowing DOWNWARD —
each new generation enters at the top and pushes older ones down and off
the bottom, giving continuous scroll motion for free. Seeded from one or
more MIRRORED pairs of cells either side of the centre column (never an
asymmetric or random row), so the automaton stays exactly left-right
symmetric from genesis onward given both candidate rules are themselves
symmetric under swapping their left/right neighbour (`rule(a,b,c) =
rule(c,b,a)`) — verified algebraically, not just visually. Cells are drawn
as bold filled squares (`cols` deliberately kept to 36-56, not a fine pixel
mesh) per the house-style "bigger, fewer, clearer elements" rule; hue is
banded by GENERATION NUMBER (each row's colour is fixed forever once
drawn, never changes with wall-clock time — see why below), so at any
instant the ~25-30 visible rows already span a wide spread of the colour
wheel.

**This engine went through far more iteration than any prior curated
engine** — six substantively different designs, each one motivated by a
real, empirically-found problem with the last, not by guessing. Recorded
here in full because the underlying lessons (a statistical validator
check can alias against ANY periodic signal, not just the specific
whiteout pattern it was built to catch; "looks fine in the first cycle or
two" is not proof against staleness over a full hour) generalise to future
engines with persistent per-frame state, which none of the prior curated
engines have (they're all purely parametric — no history carried between
frames beyond simple counters).

1. **Hard reset every cycleSec (matching every other curated engine's
   `config()`), CYCLE_SEC=44, no density bound.** `validateEngine()` across
   5 seeds passed, but with thin, inconsistent margins (worst
   `projectedRise` 49.8 against the 50 threshold) — a near-empty genesis
   growing to a filled steady state every cycle is a real, repeating
   brightness swing unlike any purely-parametric engine's cycle reset.
2. **Same design, CYCLE_SEC shortened to 26** (wrong intuition: "more
   cycles inside the 300s test window should average out phase-alignment
   noise better"). Made it WORSE — 2 of 10 seeds failed. The intuition was
   backwards; see point 4.
3. **No periodic reset at all**, reasoning a wrapped XOR-rule automaton
   would settle into a bounded steady-state density on its own so a hard
   reset's brightness swing wouldn't be needed. Wrong on two separate
   counts, both confirmed with real evidence rather than assumed:
   - Without any density bound, a direct bit-density simulation (plotting
     raw ON-cell fraction over 800 generations for several ring sizes)
     showed density swinging anywhere from ~7% to ~67% with no sign of
     settling — rule-90/150 XOR automata on a finite wrapped ring are
     governed by long, unpredictable linear-algebra periodicities, not a
     quick convergence to ~50%. `validateEngine()` across the same 10
     seeds: 8 failed, with projected rises up to +332 luma — far worse
     than a periodic reset.
   - Added a `capDensity()` step (below) to bound density directly, then
     removed the reset a second time relying on it alone plus small
     per-cycle re-seed injections. Passed `validateEngine()` far more
     reliably, but rendering ACTUAL frames far into a render (t=600s,
     1800s, 3550s — not just the first cycle or two) showed the SAME
     converged visual texture at every checkpoint. Quantified with a
     pixel-diff, not just eyeballed: only ~13% of cells differed between
     the t=600s and t=1800s frames. Rule-90/150 automata on a wrapped ring
     fall into a strong, fast-reconverging attractor texture almost
     regardless of seed, and `capDensity()`'s deterministic thinning made
     this WORSE, not better (dropping the match rate further, to ~27%
     differing, when capping was disabled for comparison). This is exactly
     the "don't trust validate.js alone — actually render frames and look"
     lesson this file already documents for `composer.html` and
     `torusrings3d.html`, now confirmed a third time on a genuinely new
     failure mode (visual staleness, not whiteout).
4. **The actual root cause of points 1-2's inconsistent margins**, found
   by computing exactly where `validate.js`'s 8 FIXED sample times (its
   `fractions` array: 0.08/0.2/0.35/0.5/0.65/0.8/0.9/0.98 of the 300s test
   window) land relative to a periodic reset every `CYCLE_SEC`: at
   CYCLE_SEC=40, the sample at t=240s lands almost EXACTLY on a reset
   boundary (0.0% of a cycle away) — for EVERY seed, since reset timing is
   fixed by `CYCLE_SEC`/`FPS` alone and is seed-independent. One sample
   systematically caught at its dimmest instant is enough on its own to
   swing an 8-point linear-regression fit into a spurious "rising" slope,
   depending on the neighbouring samples' exact plateau level (which DOES
   vary by seed, explaining the inconsistent pass/fail). CYCLE_SEC=26 was
   similarly unlucky (worst-case sample only 3.8% of a cycle from a
   boundary) — explaining why point 2's "more cycles should average out
   better" intuition was backwards: it didn't change how close the fixed
   samples land to boundaries, and happened to land closer.
   A brute-force search over candidate cycle lengths (script, not by
   hand) for the one maximizing the MINIMUM distance from any of the 8
   fixed sample times to the nearest reset boundary found **43.5s** gives
   every sample a comfortable >=20.7% margin. This generalises: any
   engine with a persistent-state periodic reset should sanity-check its
   cycle length against `validate.js`'s fixed sample fractions the same
   way, rather than picking a cycle length that merely "looks reasonable."
5. **Final design: full periodic reset (point 1's structure) + `CYCLE_SEC
   = 43.5` (point 4's fix) + `capDensity()` (point 3's fix, kept as a
   within-cycle safety net) together.** Both fixes needed: CYCLE_SEC alone
   doesn't bound worst-case density if a cycle runs long relative to
   `genPerSec`, and `capDensity()` alone doesn't fix the reset-boundary
   sample alignment. Combined, this fixes both failure modes AND avoids
   design 3's staleness problem, since a full reset every ~43.5s means the
   automaton never runs long enough for the fast-reconverging attractor
   texture to dominate — confirmed by re-rendering the same t=600s/1800s/
   3550s staleness checkpoints used in point 3, now showing three visibly
   distinct compositions, not a repeat.

`capDensity()` clears cells in symmetric column PAIRS (driven by a
rotating start index tied to the generation counter, so it's not always
the same columns thinned) whenever a generation's ON-cell fraction exceeds
`DENSITY_CEIL = 0.22`, preserving the mirror-symmetry invariant (if a
column is ON, its mirror is provably also ON before thinning, given the
symmetric rule + seed, so clearing both together can't break symmetry).

**Verified** (final design): `validateEngine()` across seeds 1-30 — 29/30
passed; the one failure (seed 1, a "132ms/frame, projected 190min render"
speed-budget rejection) did not reproduce across 3 isolated re-runs
(4-6ms/frame, 5.7-8.7min projected) and was traced to CPU contention from
other background validation batches running concurrently in this sandbox
at that exact moment, not a real engine cost. Brightness margins across
the 30 seeds are comfortable and mostly negative (`projectedRise` from
-101.7 to +23.3, all well clear of the 50 threshold — a real improvement
over designs 1-2's thin ~48-65 margins). `avgSat` 54.5-66.3 throughout
(well above the 22 minimum). Zero near-white pixels in any seed. Visual
spot-checks across 25/50/75/95/105% of a cycle (seeds 1, 2, 3, 12, 25) and
long-timespan staleness checks at t=10s/40s/150s/600s/1800s/3550s (seed 7,
both with and without `capDensity()`, to isolate its contribution) all
by actually rendering PNGs and looking at them, not just reading
validator output.

## Visual fingerprinting (`src/fingerprint.js`) — 2026-08-25

User observation that turned out to be exactly right: *"I think you don't
have capability to determine whether pattern is repeated."* Confirmed by
inspection before building anything — `validate.js` grepped for
`compare|similar|distance|hash|previous|history` returns **zero matches**,
and the only state persisted about past output is two filenames
(`engine-rotation.json`), two list indices (`theme-rotation.json`), and
prose (`creative-research-log.json`). Nothing anywhere recorded what a
video *looked like*.

So all three anti-repeat mechanisms were blind to the image: filename
round-robin (two different files rendering the same centred mandala
satisfy it completely), theme-index round-robin (blind to what Gemini
actually drew), and the "Archetype clustering" analysis above — which was
**my own eyeballing written down as prose**, not a measurement, never
re-run, and not part of the pipeline. `validate.js` scores each engine in
ISOLATION against absolute thresholds, so a near-clone of an existing
engine passes it cleanly. In practice the detector of repetition was the
user watching YouTube.

**Descriptor design.** Two choices driven by this project's own failure
history, not convention:
- **Colour-blind.** Curated engines are recoloured daily from the NASA
  APOD palette, so including hue would let a recolour mask a structural
  repeat — precisely the failure being targeted. Luminance only.
- **Composition, not pixels.** A plain perceptual hash (aHash/dHash/pHash)
  reports "different" for the same mandala at a different rotation or
  cycle phase — the wrong invariance here. Features instead measure
  rotational symmetry orders 2–8 (shift-correlation of a polar
  resampling — this is literally what makes something read as a
  "mandala"), mirror symmetry, radial mass profile, angular unevenness,
  gradient-orientation histogram, lattice periodicity, edge density, and
  lit coverage. These survive rotation and phase.

Distances use z-scored vectors against the corpus's own mean/std, so
unrelated raw units (a correlation vs. an edge fraction) can't let one
feature dominate.

**Validation — the descriptor independently rediscovered known design
facts it was never told about**, which is the real evidence it measures
structure rather than noise: `kaleidoscope` rotSym6 = 0.859 and mirrorLR =
0.999 (it is a mandala); `cascade` rotSym6 = 0.002 with angularUneven =
0.876 (the deliberately non-radial directional engine); `automaton`
mirrorLR = 0.995 (its documented mirror-symmetric seed + symmetric-rule
design); `tessellation` highest periodY = 0.764 (a tiling).

**Original measured result across the 16-engine pool** (`node
scripts/analyze-pool.js`): exactly **one** genuine near-duplicate pair —
`auto-2026-08-12-radial-mandala-built-from-straight-line` ↔
`kaleidoscope` at distance 0.546, a Gemini-promoted engine that duplicated
a hand-written one. It was a clear outlier (next-closest pair 0.674, p10
across all 120 pairs 0.861, median 1.263), which is why the novelty gate
threshold is 0.60. That duplicate file was removed the same day (see
"Remove near-duplicate engine" below) once the measurement identified it,
and the gate was added to `promoteToCuratedPool()` so the next one can't
get in the same way.

**Re-measured after removal, 15-engine pool**: nearest pair is now 0.676
(`solids3d` ↔ `starburst`), and every file is its own singleton group at
threshold 0.55-0.65 — 15 files → 15 groups. `state/engine-fingerprints.json`
(committed, regenerate with `node scripts/analyze-pool.js` whenever the
pool changes) holds these vectors and is what `noveltyDistance()` in
`src/index.js` reads at promotion time, so a production run only
fingerprints the one new candidate rather than re-rendering the whole pool.

Archetype count is threshold-dependent, so quote the curve rather than a
single number (this curve is from the original 16-file measurement; re-run
`analyze-pool.js` for the current pool's exact numbers): 16 files → 16
groups at 0.50, 15 at 0.55–0.65, 13 at 0.70, 10 at 0.75, 7 at 0.80, 3 at
1.00. Read as: at fine discrimination nearly every engine is
distinguishable; at coarse "squint" perception the pool collapses to a
handful of families.

**Caveat worth remembering:** `composer.html` picks LAYOUT×SHAPE once per
video *from the seed*, so fingerprinting it at 2 seeds samples only 2 of
its 12 combinations — it contributes more archetypes than its single row
suggests. Any future pool analysis should fingerprint `composer` across
enough seeds to cover its combos.

## Quasicrystal / Penrose-tiling engine (`quasicrystal.html`) — 2026-08-25

Second daily creative-research firing on the same day, this time under a
stricter brief: draw from something genuinely RANDOM found on the web (not
a pre-planned technique), and pass a new mandatory **novelty gate**
(`src/fingerprint.js`, added earlier the same day — see "Visual
fingerprinting" above) before shipping, not just `validate.js`.

**Research trail**: surveyed the pool first (15 engines at the time —
radial mandalas, periodic grid/tile engines, directional flow, lit-3D,
`automaton.html`'s cellular automaton, `composer.html`'s multi-factor
combinator). Picked a category via the task's own randomising method
(minute-of-firing mod category-count), landed on "obscure mathematical
object / crystal system / physical phenomenon", then WebSearched openly
within it rather than pre-deciding — this surfaced **quasicrystals and
Penrose tiling**: aperiodic tessellations with "forbidden" 5-fold/10-fold
rotational symmetry (impossible for an ordinary periodic crystal), built
from a real substitution/deflation algorithm on golden-ratio-scaled
"Robinson triangles". This is a genuinely different construction
PRINCIPLE from everything else in the pool: not a continuous parametric
transform, not a mirrored-wedge kaleidoscope, not automaton.html's 1D
cellular automaton — a recursive geometric substitution system with
aperiodic-but-locally-repetitive structure. Sources:
[Nature](https://www.nature.com/articles/316050a0),
[PNAS](https://www.pnas.org/doi/10.1073/pnas.93.25.14271),
[Rosetta Code](https://rosettacode.org/wiki/Penrose_tiling),
[apaleyes/penrose-tiling](https://github.com/apaleyes/penrose-tiling)
(the last one supplied a verified, working reference implementation of
the exact Robinson-triangle split formulas, fetched and checked BEFORE
writing any code — getting a subdivision formula subtly wrong produces a
tiling with gaps/overlaps that still "looks plausible" at a glance, not an
obviously-broken image, so guessing from memory alone was too risky here).

**What it is**: the classic 10-triangle "sun" seed (apex at centre,
alternating chirality every 36°) recursively subdivided via 4 oriented
Robinson-triangle classes (ThinLeft/ThinRight/ThickLeft/ThickRight),
scaled by the golden ratio conjugate each level. Subdivision always
repartitions the SAME fixed decagon area, so the outer silhouette never
changes shape, only interior detail — combined with computing the
triangle list ONCE per video (not per frame, not even per cycle — see
below) and only applying a rotation transform every frame, this engine is
structurally whiteout-proof with no persistent per-frame state at all
(closer to spirograph.html's "compute once, transform per frame" pattern
than to automaton.html's stateful generation).

**Three real bugs found only by actually rendering frames / running
validateEngine() across seed batches, not by reasoning about the code**:

1. **A hard colour seam from a wrapped-atan2 linear hue sweep.** First
   version coloured each triangle by `base_hue + hue0 + angFrac*130` where
   `angFrac` was `atan2(...)/(2*PI)` wrapped to [0,1) — this has an
   inherent sawtooth discontinuity where `angFrac` jumps from ~1 back to 0,
   which showed up as a hard, jarring straight-line colour seam cutting
   across the whole rotating disk in rendered PNGs (invisible from reading
   the formula alone). Fixed by switching to `40 * sin(5 * angle)` — smooth
   and periodic by construction (no wrap discontinuity), and using 5x the
   raw angle ties the colour ripple to the tiling's own 5-fold symmetry
   instead of an arbitrary frequency. The result is a genuinely more
   attractive smooth 10-lobe rainbow ripple, not just a bug fix.
2. **Randomised subdivision depth swung stroke coverage, hence brightness,
   between cycles.** Depth was originally re-randomised (`randInt(4,5)`)
   every `cycleSec` reconfigure. Subdivision partitions a FIXED area, so
   depth doesn't change total fill coverage — but the stroke lines drawn
   per triangle EDGE do scale with triangle count, so a deeper subdivision
   means proportionally more (darker) stroke ink. This is the exact
   "starburst" pitfall CLAUDE.md already documents (randomising star count
   there swung additive-overlap coverage the same way) recurring in a new
   engine. `validateEngine()` across 5 seeds showed `projectedRise`
   swinging from -118 to +203 against the 50 threshold. Fixed at the
   source: depth is now a function of `DENSITY` only, computed once,
   never re-rolled per cycle.
3. **A per-cycle random hue0 jump is a real, not aliased, brightness
   swing.** Even after fixing bug 2, `validateEngine()` still failed with
   `projectedRise` up to +327.6. Root cause: `hue0` (the base hue for the
   whole disk) was re-rolled every cycle alongside the rotation reset.
   HSL hue itself carries very different luma even at identical
   saturation/lightness (yellow reads far brighter than blue in any
   standard luma formula), so a fresh random hue0 every ~38s is a genuine
   optical brightness swing, not a validator-sampling artifact — the exact
   same mechanism CLAUDE.md documents for automaton.html's rejected
   `clk * hueDriftRate` continuous drift term, just manifesting as a
   per-cycle jump instead of continuous sweep. Fixed by splitting the
   engine into `initTiling()` (triangle list + colour scheme, called ONCE
   for the whole video) and `reconfigureRotation()` (rotation angle/rate
   only, called every cycleSec — coverage- and luma-neutral by
   construction, since a rotation transform doesn't change how much of the
   frame is lit). The per-triangle `sin(5*angle)` spread from bug 1 still
   provides plenty of colour richness at any single instant; it just can't
   create a *temporal* trend anymore since it's spatially fixed.

**A fourth finding, not a bug but a real validator-metric limitation**:
even with genuinely fast rotation (confirmed via a temporary debug hook
logging the actual angle — 43 degrees over validate.js's 1.5s fast-motion
sample window), `fastMotion` sometimes still read as "too slow to be
exciting". Root cause: Penrose tilings are aperiodic but built from a
small set of endlessly RECURRING local motifs, so a rotation landing near
another nearby patch's orientation can look deceptively self-similar to a
plain per-pixel luma diff even though the disk demonstrably moved. Not
fully fixable by making the check smarter without editing `validate.js`
(out of scope for a curated-engine change), so mitigated at the engine
level: biased `rotRate` toward the faster half of the "lively pace"
4-15s-per-rotation band (now 0.9-1.5 rad/s, full rotation in ~4-7s rather
than the previous 0.4-0.9 rad/s/7-16s range) so even an unlucky
near-self-similar landing still displaces edges enough to register.

**Novelty gate** (mandatory per today's task, using `fingerprintEngine`/
`zscoreMatrix`/`distance` from `src/fingerprint.js` directly, not just
`validate.js`): measured against all 15 existing engines, nearest
neighbour is `lattice3d` at distance **0.795** — comfortably clear of the
0.60 threshold and close to the pool's own median pair distance (1.263,
per the fingerprinting section above). Re-measured after the bug-3 fix
(colour/rotation logic changed) to make sure the fix didn't accidentally
homogenise it with something else: still 0.795, effectively unchanged.

**Verified**: `validateEngine()` across seeds 1-10, 10/10 passed with
comfortable margins — `projectedRise` -7.5 to +9.5 (vs. the 50 threshold),
`avgSat` 72-92 (vs. the 22 minimum), zero near-white pixels,
`fastMotion` comfortably above its floor on every seed,
`projectedHourRenderMin` 27-32min (well inside the CI budget). Visual
spot-checks across 25/50/75/95/105% of a cycle at 6 different seeds,
looking at actual rendered PNGs, confirmed: a correct gap-free aperiodic
tiling (no overlaps, no missing regions — the strongest sign the
Robinson-triangle split formulas were transcribed correctly), a smooth
rainbow colour ripple with no seam, continuous rigid rotation with a
clean per-cycle angle/rate reset (matching the same "reassign angle+rate,
never reset the shared clock" convention already used by
`arcrings.html`/`cascade.html`), and consistently vivid/bold/legible
output across 6 different palette and depth combinations.

## Strip-weave engine (`stripweave.html`) — 2026-08-26

Daily creative-research routine, first firing of a new day. Randomised the
research category the same way as the previous day's firing (firing-time
minute mod category-count over the task's own seed list), landing on
"traditional textile/tiling/ornament tradition from a randomly chosen
culture" — a different category from the prior day's "obscure mathematical
object" pick (`quasicrystal.html`), so no repeated inspiration source.
Open-ended search within that category (not a pre-decided culture) turned
up **Kente cloth**, the strip-woven textile tradition of the Akan/Ewe
peoples of West Africa.

**Extracting a structural principle, not the obvious one.** The first
instinct for "woven textile" is a generic over/under thread interlace
(true of literally any woven fabric — plain weave, twill, basket weave —
not distinctively Kente). Reading further surfaced the actual
Kente-specific structural fact: cloth assembled from **separate narrow
strips**, each woven independently on its own narrow loom with its own
repeating geometric motif rhythm (zigzags, diamonds, checkerboards), then
sewn together side by side — "the strips are sewn together lengthways to
purposely create definite patterns" (research source). That's the
principle worth rendering: a **heterogeneous juxtaposition of different
motifs side by side in one frame**, which nothing else in this pool does —
grid.html/tessellation.html apply one uniform rule across the whole
canvas, cascade.html phase-staggers copies of the *same* falling shape.
Sources:
[Timothy S. Y. Lam Museum of Anthropology](https://lammuseum.wfu.edu/2023/02/ghana-weave-a-kente-cloth/),
[Craft Atlas](https://craftatlas.co/crafts/kente),
[Minneapolis Institute of Art](https://new.artsmia.org/programs/teachers-and-students/teaching-the-arts/artwork-in-focus/asante-kente-cloth).

**What it is**: N vertical strips spanning the full canvas height, each
assigned (once per video) one of three motifs — solid alternating blocks,
diamonds, or chevrons — and its own two-colour scheme drawn from the
palette table (a second, genuinely different palette entry for the accent
colour, not just a lightness nudge of the first, so adjacent strips read
as distinct thread combinations). Every strip's motif tiles seamlessly and
is always 100% opaque (the "background" colour fills the full segment
before the accent shape is drawn on top), so there is never a black gap to
accumulate into — structurally whiteout-proof the same way as every other
clear-and-redraw engine here, with no persistent per-frame state at all.
Each strip scrolls continuously downward (as if being fed off its own
parallel loom) at a shared base rate with a small per-strip jitter
(0.82-1.18x) and its own fixed phase offset, so strips visibly move at
independently different rhythms rather than in lockstep — reinforcing the
"separate strips" read the same way `composer.html`'s directional layout
uses shared-per-column colour to reinforce "these belong to one stream",
just inverted here (independent phase reinforces *separateness* between
strips instead of *unity* within one).

**Applied the last two engines' hardest-won lesson from the start, instead
of re-discovering it the slow way.** Both `automaton.html` and
`quasicrystal.html` shipped only after multiple rounds of discovering (the
expensive way, via `validateEngine()` failures) that any geometry or
colour-scheme parameter re-randomised every `cycleSec` creates a real,
not-aliased frame-average brightness swing between cycles if it changes
total ink coverage OR shifts the overall hue distribution. Built this
engine with that lesson already applied from the first draft: strip count,
per-strip motif, and per-strip colours are all fixed ONCE in `initStrips()`
(never re-rolled), and the only thing `cycleSec` resets is scroll
phase/rate in `reconfigureScroll()` — coverage-neutral by construction,
since a scrolling *periodic* pattern has identical total ink coverage at
every phase. Also relied on scrolling itself (rather than a hue-based
effect) for all per-frame motion, sidestepping the HSL-hue-affects-luma
trap entirely rather than needing to route around it.

**Verified**: `validateEngine()` across seeds 1-10 — **10/10 passed on the
first attempt**, no iteration needed (unlike automaton's six rounds or
quasicrystal's four) — real evidence the fix-once-per-video pattern above
is now a reliable default for new engines, not just a one-off patch.
Margins comfortable throughout: `projectedRise` -10.8 to +8.1 (vs. the 50
threshold), `avgSat` 79.3-90.1 (vs. the 22 minimum), zero near-white
pixels, `fastMotion` comfortably above its floor on every seed,
`projectedHourRenderMin` 3.7-34.2min (well inside the CI budget — the
seed-to-seed spread here is puppeteer/sandbox scheduling noise on this
very cheap-to-render engine, not a real cost difference, per the same
CPU-contention pattern already documented for automaton.html's one flaky
speed reading). Visual spot-checks across 25/50/75/95/105% of a cycle at 3
seeds confirmed bold, vivid, immediately-legible strips with visible
independent scroll motion between checkpoints and a clean, non-jarring
phase reset at the cycle boundary.

**Novelty gate**: measured against all 16 existing engines using
`fingerprintEngine`/`zscoreMatrix`/`distance` from `src/fingerprint.js`
directly. Nearest neighbour is `tessellation` at distance **1.773** —
not just clear of the 0.60 threshold but comfortably above the pool's own
*median* pair distance (1.263, per the fingerprinting section above),
confirming this is a genuinely distinct archetype rather than a
borderline case.

## Chladni-figure / cymatics engine (`chladni.html`) — 2026-08-27

Daily creative-research routine. Randomised category selection (firing-time
minute mod category-count, same method as the previous two firings) landed
on "random featured image" — but this turned out to be impractical in this
sandbox: Wikimedia Commons is blocked by the network egress policy the
same way `en.wikipedia.org` already was (confirmed, not assumed), and
WebSearch alone couldn't surface a specific, concrete, well-documented
subject to extract a structural principle from (results were generic
"beautiful photo" lists, not something with an underlying formula). Rather
than force a weak fit, moved to the *next* candidate from the task's own
category list — "random natural structure" — which hadn't been used yet
and is rich in concrete, well-documented physical structures. Open search
within it surfaced several candidates (mudcrack Y-junction networks,
phyllotaxis spiral lattices, soap-film minimal surfaces); picked
**cymatics / Chladni figures** — the nodal-line patterns that emerge when
a vibrating plate is combined with fine sand, which collects along the
lines where the plate's standing-wave vibration cancels to zero. A
genuinely different construction principle from everything else in the
pool: not a substitution/subdivision system (`quasicrystal.html`), not a
discrete cellular-automaton generation (`automaton.html`), not a rigid
transform of a fixed shape — an **implicit curve** (the zero-set of a wave
interference function), sampled on a grid rather than drawn as an explicit
path. Sources:
[Plateau's laws](https://en.wikipedia.org/wiki/Plateau%27s_laws),
[Mudcrack](https://en.wikipedia.org/wiki/Mudcrack) (background research
that led to the final pick, not the technique used).

**What it is**: the standard visualisation-grade square-plate Chladni
formula, `mode(m,n)(u,v) = cos(m*pi*u)*cos(n*pi*v) - cos(n*pi*u)*cos(m*pi*v)`
for `u,v` in `[-1,1]` — a widely used formula for generating recognisable
nodal patterns (not a lab-exact eigenmode derivation, which wasn't
necessary for a visualisation). Two distinct `(m,n)` mode pairs are picked
once per video and continuously cross-faded via a rotating angle
(`f = cos(theta)*modeA + sin(theta)*modeB`), smoothly morphing the nodal
pattern between the two and everything in between, echoing how real
Chladni demonstrations sweep the driving frequency and watch the sand
reorganise. Grid points near `f=0` are drawn as bold filled squares (not a
fine mesh — see the first bug below) rather than traced as continuous
marching-squares contours, both for implementation safety and because it
reads as more physically authentic (real Chladni sand collects as
particles along the nodal lines, not a smooth drawn curve).

**Three real bugs found only by rendering frames and running
validateEngine() across seed batches, not by reasoning about the code**:

1. **First version's grid was far too fine for the house style.** Initial
   cell sizing (`minDim/78`) produced tiny, scattered single-pixel-ish
   dots that read as noise/confetti, not "bold, few, clear" shapes.
   Confirmed only by actually rendering and looking (the numbers alone
   looked reasonable). Fixed by roughly doubling cell size (`minDim/42`),
   filling each cell almost completely (`dotSize = cellSize*0.88`, up from
   `0.42`), and widening the acceptance band so adjacent hit-cells connect
   into visible chains rather than isolated specks.
2. **A real algebraic degeneracy: `mode(n,m)` is exactly `-mode(m,n)`.**
   Swapping a mode pair's indices just negates the whole expression, so if
   the mode-pair picker ever selected `(n,m)` as the second mode when
   `(m,n)` was the first, `f = cos(theta)*modeA + sin(theta)*modeB`
   collapsed to `modeA` times a single time-varying SCALAR — meaning the
   zero-set (where the nodal lines actually are) never moved at all,
   regardless of theta. `validateEngine()` caught this unambiguously as
   "little/no motion between frames (max diff 0.00)" on 2 of 10 seeds, not
   a borderline case. Fixed by explicitly excluding the swapped pair, not
   just the identical one, when picking modeB.
3. **A real (not aliased) brightness swing from letting the "how mixed is
   the current cross-fade" state vary total lit coverage.** A near-pure
   single mode has structurally less total nodal-line length than a fully
   mixed state, so a fixed `|f| < THRESH` cutoff let coverage genuinely
   swing as theta swept its cycle. Even though the oscillation is
   periodic with dozens of full periods inside validate.js's 300s test
   window (which should statistically average out per the automaton.html/
   quasicrystal.html lesson about many-periods-vs-aliasing), 3 of 10 seeds
   still showed a real trend (`projectedRise` up to +191.7) — 8 sparse
   samples still carry enough variance to occasionally catch a large
   swing badly. Fixed at the source, the same way `automaton.html`'s
   `capDensity()` bounds density regardless of the automaton's own raw
   behaviour: rank ALL grid cells' `|f|` each frame and light up exactly
   the lowest `TARGET_FRAC` (16%) of them, so lit AREA never varies —
   only which specific cells (i.e. the pattern's shape) do.

**A fourth finding, a real trade-off rather than a bug**: the
`TARGET_FRAC` fix above, while fully solving problem 3, was measured
(not assumed) to also damp frame-to-frame pixel churn — a rank/percentile
selection is inherently more stable than a raw value cutoff, since it
tends to keep a consistent "core" of lowest-`|f|` cells across a wide
theta range. Raising the cross-fade rate well past what "many periods fit
the test window" alone called for (0.8-1.4 rad/s, full period only
~2.2-3.9s) still left 4-5 of 10 seeds failing "too slow to read as
exciting". Rather than fight the percentile selection's own stability
further, added an independent, already-proven motion source instead of
tuning the same lever harder: a genuine rigid rotation of the whole
rendered plate, the same technique `quasicrystal.html` already validated
as reliable, layered on top of the mode cross-fade. This displaces every
lit pixel by a large, unambiguous amount every frame regardless of which
specific cells the percentile threshold happens to select, decoupling the
motion-detection fix from the brightness fix entirely.

**Verified** (final design): `validateEngine()` across seeds 1-10 —
**10/10 passed** after the four fixes above. Margins comfortable:
`projectedRise` -13.4 to +33.1 (vs. the 50 threshold), `avgSat` 65.4-76.8
(vs. the 22 minimum), zero near-white pixels, `fastMotion` comfortably
above its floor on every seed (15-23 vs. floors of 4.7-6.1),
`projectedHourRenderMin` 6.0-8.2min (well inside the CI budget). Visual
spot-checks across 25/50/75/95/105% of a cycle at 5 seeds confirmed bold,
clearly-connected nodal-line patterns (diamonds, X-crossings, radial
star-bursts depending on the mode pair) with visible independent morphing
and rotation between checkpoints, and vivid, distinct palettes per seed.

**Novelty gate**: measured against all 17 existing engines (the
fingerprint cache was one commit behind — missing `stripweave.html` —
so it was fingerprinted fresh alongside the candidate rather than trusting
a stale cache) using `fingerprintEngine`/`zscoreMatrix`/`distance` from
`src/fingerprint.js`. Nearest neighbour is `arcrings` at distance
**1.113** — comfortably clear of the 0.60 threshold (roughly double it),
though below the pool's own median pair distance (1.263): the added rigid
rotation likely reads as somewhat similar in raw composition terms to
`arcrings`' rotating segments, even though the underlying technique
(implicit wave-interference sampling vs. explicit rotating arcs) is
completely different. Still a clear, comfortable pass, not a borderline
case.

## Art Deco stepped/ziggurat engine (`ziggurat.html`) — 2026-08-28

Daily creative-research routine. Randomised category selection landed on
"random natural structure" (used the previous day) and "random Wikipedia
article" (impractical -- Wikipedia is blocked) in that order, so moved to
the one category not yet tried in this project: "random architectural or
typographic movement". A first search on Swiss/International Typographic
Style grid systems felt too close to `grid.html`'s existing mathematical-
grid archetype, so searched further and landed on **Art Deco's
stepped/ziggurat motif** -- tiered, setback silhouettes (skyscraper
setbacks, temple ziggurats, cinema-facade staircase arches), one of the
movement's three core geometric vocabulary items alongside sunbursts and
chevrons. Deliberately picked the stepped motif over the other two:
sunburst rays would read too close to `arcrings.html`/`geometric.html`'s
existing radial-line engines, and chevrons already appear as one of
`stripweave.html`'s per-strip motifs. Sources:
[illustrarch](https://illustrarch.com/articles/34588-art-deco-geometric-designs.html),
[awedeco](https://awedeco.com/zigzag-patterns-in-art-deco/).

**What it is**: N wedges arranged radially (a rosette), each wedge built
as a stack of T annular "step" tiers -- every tier is a filled annular
sector, narrower than the tier below it, so the wedge's silhouette
staircases inward as it rises outward from the centre, exactly like a
ziggurat's setback profile viewed in plan around a circle. This is a
genuinely different silhouette from every other radial engine in the
pool: solid, tapering, notched STEPS, not thin arcs (`arcrings.html`),
thin spoke lines (`geometric.html`), mirrored point-stamps
(`kaleidoscope.html`), or nested star outlines (`starburst.html`). Wedge
count and tier count are fixed once per video (function of `DENSITY`
only, never re-randomised per cycle); the only thing that changes over
time is a rigid rotation of the whole rosette, so total covered area
never varies -- structurally whiteout-proof and coverage-stable by
construction, the same pattern `quasicrystal.html`/`chladni.html`
established as safe.

**Two real bugs found only by rendering frames and running
validateEngine() across seed batches, not by reasoning about the code**:

1. **Tapering by ANGLE alone made the wedges widen outward instead of
   narrowing.** First version shrank each tier's angular half-width
   linearly by tier index. That looked, when actually rendered, like
   flower petals fanning OUT rather than a ziggurat narrowing in --
   because arc length is angle times radius, and radius grows across the
   T tiers faster than a linear angular taper shrinks, so the physical
   (on-screen) width of outer tiers was actually LARGER than inner ones
   despite the angular span being smaller. Fixed by tapering the
   PHYSICAL half-width directly (linearly shrinking to 35% of the base
   width by the outermost tier) and converting back to an angular
   half-width using that tier's own radius, so the on-screen taper is
   genuine regardless of how far out a tier sits.
2. **Exact N-fold rotational symmetry created a real (not approximate)
   self-similarity risk for the fast-motion check.** All N wedges are
   identical, so rotating the whole rosette by any exact multiple of the
   sector angle (`2*PI/N`) produces a frame indistinguishable from the
   unrotated one -- a stronger, EXACT version of the "local motif
   recurrence" issue `quasicrystal.html` already documents for Penrose
   tilings (which are only approximately self-similar). An
   independent-of-N rotation rate (0.7-1.2 rad/s) failed 1 of 10 seeds
   because for this pool's default `DENSITY` (giving N=10, sector angle
   36 degrees) that range happened to straddle the exact 2-sector
   resonance point (~0.838 rad/s) at validate.js's 1.5s fast-motion
   sample window. Fixed by tying the rotation rate explicitly to N
   instead of picking it independently: target 1.3-1.7 sectors of
   rotation over the 1.5s window (centred on 1.5, maximally far from the
   resonant 1x and 2x sector points), which by construction can never
   land on an exact multiple of the sector angle regardless of which N a
   given video happens to have.

**Verified**: `validateEngine()` across seeds 1-30 (10 in the initial
batch, 20 more afterward for extra confidence given the resonance bug was
seed-dependent by nature) — **30/30 passed** after both fixes. Margins
comfortable throughout: `projectedRise` -11.0 to +10.2 (vs. the 50
threshold, and tight even by this pool's standards -- the coverage-stable
rotate-only design leaves almost no swing at all), `avgSat` 61.7-73.7
(vs. the 22 minimum), zero near-white pixels, `fastMotion` comfortably
above its floor on every seed (13.6-24.9 vs. floors of 3.8-5.7),
`projectedHourRenderMin` 2.8-7.1min (well inside the CI budget). Visual
spot-checks across 25/50/75/95/105% of a cycle at 3 seeds confirmed bold,
vivid, clearly-stepped tapering wedges with visible tier notches, a clean
non-jarring rotation reset at the cycle boundary, and no artifacts from
either fix.

**Novelty gate**: measured against all 20 existing engines (the
committed fingerprint cache was several commits behind -- missing
`chladni.html`, `stripweave.html`, and a Gemini-promoted
`auto-2026-08-27-...` 3D engine -- so all three were fingerprinted fresh
alongside the candidate) using `fingerprintEngine`/`zscoreMatrix`/
`distance` from `src/fingerprint.js`. Nearest neighbour is `spirograph`
at distance **1.059** — comfortably clear of the 0.60 threshold. Notably,
`arcrings` (the engine this design was originally most worried about
resembling, given both are radial/segmented) came out at 1.215, confirming
the solid tapering-staircase silhouette really does read as structurally
distinct from arcrings' thin rotating arc segments, not just superficially
different.

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
