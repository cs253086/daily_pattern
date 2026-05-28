# Daily Pattern — Automated Generative Screensaver Channel

A `$0/month` pipeline that, every day on a GitHub Actions cron, renders a fresh
hypnotic generative-art video and uploads it to YouTube — both a **1-hour long
video** and a **30-second Short** cut from it.

- **Compute:** GitHub Actions (free tier)
- **Render:** Puppeteer (headless Chromium) drives a deterministic engine frame
  by frame; ffmpeg encodes the frames into H.264 mp4. Faster than real time.
- **Upload:** YouTube Data API v3 via `googleapis`, using a stored OAuth refresh
  token.
- **Storage:** none — the Actions runner's ephemeral disk only.

## Status

- **Phase 1 (done):** end-to-end render → encode → upload with the Bloom engine.
- **Phase 2 (planned):** `src/generate.js` + `src/validate.js` — Gemini writes a
  fresh engine each day; falls back to Bloom if it fails the quality gate.
- **Phase 3 (planned):** prompt tuning after real uploads.

## How it works

```
src/index.js      orchestrator: select engine → render → metadata → upload
src/render.js     Puppeteer + ffmpeg: engine HTML → output/long.mp4 + output/short.mp4
src/metadata.js   deterministic templated titles / descriptions / tags
src/upload.js     YouTube Data API v3 resumable upload
engines/bloom.html  the fallback engine (a.k.a. screensaver.html)
```

### Engine contract

Every engine is a standalone HTML file that:

- Reads URL params: `seed`, `palette`, `width`, `height`, `fps`, `duration`,
  `speed`, `density`, `cycleSec`.
- Exposes on `window`: `READY` (bool), `TOTAL_FRAMES` (int), `currentFrame`
  (int), `advanceFrame()` (renders exactly one frame), `advanceFrames(n)`.
- Uses a seeded PRNG so the same seed always produces the same video.
- Does **not** use `requestAnimationFrame` — it only paints when
  `advanceFrame()` is called, so Puppeteer fully controls the clock.

`render.js` waits for `window.READY === true`, reads `window.TOTAL_FRAMES`, then
loops: `advanceFrame()` → read the canvas as a JPEG → pipe it to ffmpeg.

## Local development

Prerequisites: Node 20+, and `ffmpeg` on your `PATH`. `npm install` downloads a
matching Chromium for Puppeteer automatically.

```bash
npm install

# Quick pipeline smoke test (no YouTube needed) using the test fixture engine:
node src/index.js --no-upload \
  --engine=tests/fixtures/test-engine.html \
  --duration=10 --fps=15 --width=640 --height=360

# Render with the real Bloom engine, 10s, no upload:
node src/render.js --duration=10

# Outputs land in ./output/long.mp4 and ./output/short.mp4
```

### Useful flags / env vars

CLI flags take priority over env vars, which take priority over defaults.

| Flag | Env | Default | Meaning |
|------|-----|---------|---------|
| `--engine=` | `ENGINE` | `engines/bloom.html` | Engine HTML to render |
| `--seed=` | `SEED` | today's `YYYYMMDD` | PRNG seed |
| `--palette=` | `PALETTE` | engine default | Palette index |
| `--width=` / `--height=` | `WIDTH` / `HEIGHT` | `1920` / `1080` | Resolution |
| `--fps=` | `FPS` | `24` | Frames per second |
| `--duration=` | `DURATION` | `3600` | Length in seconds |
| `--crf=` | `CRF` | `20` | x264 quality (lower = better/bigger) |
| `--preset=` | `PRESET` | `medium` | x264 speed/size preset |
| `--shortStart=` | `SHORT_START` | `2100` | Short cut start (sec, 35:00) |
| `--shortDuration=` | `SHORT_DURATION` | `30` | Short length (sec) |
| `--no-upload` | `DRY_RUN=1` | off | Render only, skip upload |

## One-time YouTube OAuth setup

This is the **only** manual step. You need three secrets:
`YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`.

1. **Create a Google Cloud project**
   - Go to <https://console.cloud.google.com/> → create a new project.

2. **Enable the YouTube Data API v3**
   - APIs & Services → Library → search "YouTube Data API v3" → **Enable**.

3. **Configure the OAuth consent screen**
   - APIs & Services → OAuth consent screen.
   - User type **External**. Fill in the required app name / support email.
   - Add the scope `https://www.googleapis.com/auth/youtube.upload`.
   - Under **Test users**, add the Google account that owns the YouTube channel.
     (While the app is in "Testing", refresh tokens are valid and you don't need
     Google verification — this is fine for a personal channel.)

4. **Create OAuth client credentials**
   - APIs & Services → Credentials → Create credentials → **OAuth client ID**.
   - Application type: **Desktop app**.
   - Copy the **Client ID** and **Client secret** → these are `YT_CLIENT_ID`
     and `YT_CLIENT_SECRET`.

5. **Get a refresh token** (run the helper locally — needs `npm install` first):
   ```bash
   YT_CLIENT_ID=xxx YT_CLIENT_SECRET=yyy node scripts/get-refresh-token.js
   ```
   - It prints a URL. Open it, sign in with the channel's Google account, and
     grant access. You'll be redirected back to a local page and the helper
     captures the code automatically — nothing to paste.
   - The script then prints your **refresh token** → this is `YT_REFRESH_TOKEN`.
   - Desktop-app OAuth clients allow `http://localhost` redirects automatically,
     so no extra redirect-URI configuration is needed. (Override the port with
     `OAUTH_PORT=...` if 53682 is taken.)
   - Keep this secret. It does not expire while the OAuth app stays in "Testing"
     and is used at least every 6 months.

6. **Store the secrets in GitHub**
   - Repo → Settings → Secrets and variables → Actions → New repository secret.
   - Add `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`.
   - Optional: `YT_PRIVACY` (`public` | `unlisted` | `private`, default
     `public`). Set it to `unlisted` for the first few runs if you want to eyeball
     the uploads before they go public.

### Local `.env` (optional)

For local upload testing, create a `.env` (git-ignored):

```
YT_CLIENT_ID=...
YT_CLIENT_SECRET=...
YT_REFRESH_TOKEN=...
YT_PRIVACY=unlisted
```

## Running in CI

`.github/workflows/daily.yml` runs daily at 09:00 UTC. You can also trigger it
manually: **Actions → Daily Screensaver → Run workflow**, where you can set a
shorter `duration`, a custom `seed`, or `dry_run=true` for a no-upload test.

A first **`dry_run=true` with `duration=30`** is the recommended smoke test once
your secrets are in place but before committing to a full 1-hour public upload.

## Notes & caveats

- **Shorts classification.** The Short is cut at the source 16:9 resolution. The
  `#Shorts` tag plus a sub-60s length usually gets it shelved as a Short, but
  YouTube currently favors vertical/square video for the Shorts feed. If you want
  guaranteed Shorts placement, we can add a vertical (1080×1920) crop/pad pass to
  `render.js`.
- **Render budget.** 1 hour at 24fps = 86,400 frames. Each frame is one Puppeteer
  round-trip. Verify a full-length render completes inside the job timeout before
  relying on the daily cron; drop `fps` (15 is fine for slow ambient content) or
  `duration` if needed.
- **Public-repo minutes are unlimited**; private repos get 2,000 min/month. Keep
  the repo public for the free unlimited tier.
