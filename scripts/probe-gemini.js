// Diagnose which Gemini models the configured API key can actually use on the
// free tier. Some models return `limit: 0` even when the key is tagged "free",
// because Google's free-tier model availability varies by region / project /
// rollout. This script makes a tiny request to each candidate model and reports
// which succeed (these are the values you can put in the GEMINI_MODEL secret).
//
//   GEMINI_API_KEY=xxx node scripts/probe-gemini.js

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('Set GEMINI_API_KEY in the environment.'); process.exit(1); }

const MODELS = [
  // Newest / preferred (usually best quality if available)
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  // Previous generation
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  // Older still — often free even when newer are paid-only
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];

const PROMPT = 'Reply with the single word: ok';

async function probe(model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(KEY)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 8 },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        const msg = j?.error?.message || '';
        if (/limit: 0/.test(msg)) reason = `429 (no free-tier quota — limit: 0)`;
        else if (res.status === 429) reason = '429 rate-limited';
        else if (res.status === 404) reason = '404 model not found / not available';
        else if (res.status === 403) reason = '403 forbidden';
        else reason = `${res.status} ${msg.slice(0, 120)}`;
      } catch {}
      return { model, ok: false, reason };
    }
    return { model, ok: true, reason: 'ok' };
  } catch (e) {
    return { model, ok: false, reason: `network: ${e.message}` };
  }
}

console.log(`Probing ${MODELS.length} models with the configured API key...\n`);
const results = [];
for (const m of MODELS) {
  const r = await probe(m);
  console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${m.padEnd(28)}  ${r.reason}`);
  results.push(r);
}

const usable = results.filter((r) => r.ok).map((r) => r.model);
console.log('\n=== SUMMARY ===');
if (usable.length === 0) {
  console.log('No models worked with this key. Likely fixes:');
  console.log('  1. Generate a NEW key at https://aistudio.google.com/apikey on a fresh project.');
  console.log('  2. Or enable billing on the current project (free tier still applies first).');
  console.log('  3. Confirm Gemini API free tier is available in your country.');
  process.exit(2);
}
console.log('Models you can use (set GEMINI_MODEL to one of these):');
for (const m of usable) console.log(`  - ${m}`);
console.log('\nRecommended: the first one in this list (newest that works).');
console.log(`\n  -> GEMINI_MODEL=${usable[0]}`);
