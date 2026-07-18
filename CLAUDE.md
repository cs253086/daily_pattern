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
   drift for dynamic color. When tuning brightness/alpha on an accumulating
   engine, test at multiple points across the cycle, not just frame 1 — a
   look that's fine early can wash out after 20-30s of accumulation.
4. **Titles are a few words** (mood + subject, e.g. "Calming Geometric
   Patterns") — not long tagged strings. Duration/use-case context belongs in
   the description, not the title (see `src/metadata.js`).

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
2. Otherwise (or if Gemini fails both attempts): rotate deterministically by
   date through the curated pool — `engines/manual/*.html`. Currently:
   `geometric`, `grid`, `kaleidoscope`. `engines/bloom.html` exists only as a
   last-resort emergency fallback if the manual pool is ever empty — it's
   organic, not the house style, and excluded from normal rotation.
3. For curated (non-Gemini) engines, `src/palette.js` recolors from that
   day's NASA APOD image when reachable (non-fatal if not).

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
