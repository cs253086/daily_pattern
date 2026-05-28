// YouTube upload via the Data API v3 (googleapis), authenticated with a stored
// OAuth2 refresh token. Credentials come from environment / GitHub Secrets:
//   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN
// Optional:
//   YT_PRIVACY (default "public"), YT_REDIRECT_URI

import { createReadStream, statSync } from 'node:fs';
import { google } from 'googleapis';

const DEFAULT_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

// Build an authenticated OAuth2 client from environment credentials.
export function getOAuthClient(env = process.env) {
  const clientId = env.YT_CLIENT_ID;
  const clientSecret = env.YT_CLIENT_SECRET;
  const refreshToken = env.YT_REFRESH_TOKEN;

  const missing = [];
  if (!clientId) missing.push('YT_CLIENT_ID');
  if (!clientSecret) missing.push('YT_CLIENT_SECRET');
  if (!refreshToken) missing.push('YT_REFRESH_TOKEN');
  if (missing.length) {
    throw new Error(`Missing YouTube OAuth credentials: ${missing.join(', ')}`);
  }

  const oauth2 = new google.auth.OAuth2(
    clientId,
    clientSecret,
    env.YT_REDIRECT_URI || DEFAULT_REDIRECT,
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

// Upload a single video file. Resolves to the created video resource.
//   opts: { file, title, description, tags, categoryId, privacyStatus,
//           publishAt?, madeForKids? }
export async function uploadVideo(auth, opts) {
  const {
    file,
    title,
    description = '',
    tags = [],
    categoryId = '24',
    privacyStatus = process.env.YT_PRIVACY || 'public',
    madeForKids = false,
  } = opts;

  const size = statSync(file).size;
  const youtube = google.youtube({ version: 'v3', auth });

  console.log(`[upload] "${title}" (${(size / 1e6).toFixed(1)} MB) privacy=${privacyStatus}`);

  let lastPct = -1;
  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title, description, tags, categoryId },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: madeForKids,
        },
      },
      media: { body: createReadStream(file) },
    },
    {
      // Resumable upload; report progress.
      onUploadProgress: (evt) => {
        const pct = Math.floor((evt.bytesRead / size) * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          process.stdout.write(`\r[upload] ${pct}%   `);
        }
      },
    },
  );
  process.stdout.write('\n');

  const id = res.data.id;
  console.log(`[upload] done: https://youtu.be/${id}`);
  return res.data;
}

// Upload the long video then the short, using a metadata object.
export async function uploadAll({ longFile, shortFile, metadata, env = process.env }) {
  const auth = getOAuthClient(env);
  const results = {};

  results.long = await uploadVideo(auth, {
    file: longFile,
    ...metadata.long,
  });

  if (shortFile) {
    results.short = await uploadVideo(auth, {
      file: shortFile,
      ...metadata.short,
    });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Direct invocation: upload a single file for manual testing.
  //   node src/upload.js path/to.mp4 "Title"
  const file = process.argv[2];
  const title = process.argv[3] || 'Test upload';
  if (!file) {
    console.error('usage: node src/upload.js <file.mp4> [title]');
    process.exit(1);
  }
  uploadVideo(getOAuthClient(), { file, title, privacyStatus: process.env.YT_PRIVACY || 'private' })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[upload] FAILED:', e.message);
      process.exit(1);
    });
}
