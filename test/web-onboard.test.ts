import { test } from 'node:test';
import assert from 'node:assert/strict';
import { page } from '../src/onboard/webOnboard.js';

test('onboarding page embeds the one-time token and the form fields', () => {
  const html = page('TESTTOKEN123');
  assert.match(html, /TESTTOKEN123/, 'token is embedded for the /save handshake');
  for (const id of ['id="provider"', 'id="apiKey"', 'id="baseUrl"', 'id="pw"', 'id="pw2"']) {
    assert.ok(html.includes(id), `has ${id}`);
  }
});

test('onboarding page loads NO external resources (CSP/offline safe — a key cannot be exfiltrated)', () => {
  const html = page('t');
  // No off-origin resource loads: no external <script src>, <link href>, <img src=http>, no @import.
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'no external scripts');
  assert.doesNotMatch(html, /<link[^>]+href=/i, 'no external stylesheets');
  assert.doesNotMatch(html, /<img[^>]+src=["']?https?:/i, 'no remote images');
  assert.doesNotMatch(html, /@import/i, 'no CSS @import');
  // The only network call the script makes is the same-origin POST back to Shadow.
  assert.ok(html.includes("fetch('/save'"), 'posts to the local /save endpoint');
  assert.doesNotMatch(html, /fetch\(\s*["']https?:/i, 'never fetches an external URL');
});
