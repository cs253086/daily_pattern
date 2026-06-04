// Manual two-step OAuth helper for environments where the loopback server
// can't be reached by the user's browser (e.g. running inside a cloud
// container while the browser is on a different machine).
//
//   step 1: node scripts/get-refresh-token-manual.js
//           -> prints an auth URL. Open it in a browser signed into the
//              channel-owner account, authorize, then copy the FULL URL
//              from the address bar AFTER the (failed) redirect.
//   step 2: node scripts/get-refresh-token-manual.js "<that-url-or-just-code>"
//           -> prints the refresh token.

import { google } from 'googleapis';

const REDIRECT = 'http://localhost';
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

const clientId = process.env.YT_CLIENT_ID;
const clientSecret = process.env.YT_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set YT_CLIENT_ID and YT_CLIENT_SECRET in the environment.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);

const arg = process.argv[2];
if (!arg) {
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [SCOPE],
  });
  console.log('Open this URL and authorize:\n');
  console.log(url);
  console.log('\nAfter you click Allow, your browser will try to redirect to http://localhost/...');
  console.log('That page will fail to load — that is expected. Copy the FULL URL from the address bar,');
  console.log('then re-run this script with that URL (or just the value of the "code" query param) as an argument.');
  process.exit(0);
}

// Accept either a full redirect URL or just the bare code.
let code = arg;
try {
  const u = new URL(arg);
  const c = u.searchParams.get('code');
  if (c) code = c;
} catch { /* not a URL, treat as bare code */ }

try {
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error('No refresh_token returned. This usually means you have already authorized this app.');
    console.error('Revoke access at https://myaccount.google.com/permissions and run step 1 again.');
    process.exit(1);
  }
  console.log('\n=== SUCCESS ===\n');
  console.log('YT_REFRESH_TOKEN:\n');
  console.log(tokens.refresh_token);
  console.log('\nAdd this as a GitHub repository secret. Do not paste it back into chat.');
} catch (e) {
  const msg = (e.response && e.response.data) ? JSON.stringify(e.response.data) : e.message;
  console.error('Token exchange failed:', msg);
  process.exit(1);
}
