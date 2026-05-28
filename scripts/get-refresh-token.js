// One-time helper to obtain a YouTube OAuth refresh token.
//
//   YT_CLIENT_ID=xxx YT_CLIENT_SECRET=yyy node scripts/get-refresh-token.js
//
// Uses the loopback-redirect flow recommended for "Desktop app" OAuth clients
// (the old urn:...:oob copy/paste flow is deprecated by Google). A temporary
// local web server captures the authorization code automatically, so there is
// nothing to paste back.

import http from 'node:http';
import { URL } from 'node:url';
import { google } from 'googleapis';

const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const PORT = Number(process.env.OAUTH_PORT || 53682);
const REDIRECT = `http://localhost:${PORT}`;

const clientId = process.env.YT_CLIENT_ID;
const clientSecret = process.env.YT_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set YT_CLIENT_ID and YT_CLIENT_SECRET in the environment first.');
  console.error('  YT_CLIENT_ID=xxx YT_CLIENT_SECRET=yyy node scripts/get-refresh-token.js');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',   // required to receive a refresh token
  prompt: 'consent',        // force a refresh token even on re-auth
  scope: [SCOPE],
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Authorization failed: ${error}`);
      console.error('\nAuthorization failed:', error);
      server.close();
      process.exit(1);
    }
    if (!code) {
      // Ignore stray requests (e.g. favicon).
      res.writeHead(204);
      res.end();
      return;
    }

    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Success — you can close this tab and return to the terminal.</h2>');

    console.log('\n=== OAuth tokens ===');
    if (tokens.refresh_token) {
      console.log('\nYT_REFRESH_TOKEN:\n' + tokens.refresh_token + '\n');
      console.log('Store this as the GitHub secret YT_REFRESH_TOKEN.');
    } else {
      console.error('\nNo refresh_token was returned. This usually means you have');
      console.error('already authorized this app. Revoke access at');
      console.error('https://myaccount.google.com/permissions and run this again.');
    }
    server.close();
    process.exit(tokens.refresh_token ? 0 : 1);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error exchanging code. Check the terminal.');
    console.error('\nToken exchange failed:', e.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('Open this URL in a browser signed in to the channel owner account:\n');
  console.log(authUrl + '\n');
  console.log(`Waiting for the redirect on ${REDIRECT} ...`);
});
