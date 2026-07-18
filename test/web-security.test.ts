import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedHost,
  isAllowedOrigin,
  tokenMatches,
  extractToken,
  authorizeRequest,
} from '../src/web/security.js';

const PORT = 41234;
const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaa';

// --- Host: the DNS-rebinding defense -----------------------------------------------

test('Host: loopback names on our port are allowed', () => {
  for (const h of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `LOCALHOST:${PORT}`]) {
    assert.equal(isAllowedHost(h, PORT), true, h);
  }
});

test('Host: a rebound attacker domain is rejected', () => {
  // The whole point: in a rebinding attack the socket lands on 127.0.0.1 but the browser
  // still sends the name from the URL bar.
  for (const h of [`evil.com:${PORT}`, `evil.com`, `127.0.0.1.nip.io:${PORT}`, `xn--evil:${PORT}`]) {
    assert.equal(isAllowedHost(h, PORT), false, h);
  }
});

test('Host: right name, wrong port is rejected', () => {
  assert.equal(isAllowedHost(`127.0.0.1:${PORT + 1}`, PORT), false);
  assert.equal(isAllowedHost('127.0.0.1', PORT), false, 'no port means :80, which we never bind');
});

test('Host: a missing header is rejected, not defaulted', () => {
  assert.equal(isAllowedHost(undefined, PORT), false);
  assert.equal(isAllowedHost('', PORT), false);
});

// --- Origin: cross-site POST defense -----------------------------------------------

test('Origin: our own origins are allowed', () => {
  assert.equal(isAllowedOrigin(`http://127.0.0.1:${PORT}`, PORT), true);
  assert.equal(isAllowedOrigin(`http://localhost:${PORT}`, PORT), true);
});

test('Origin: a foreign site is rejected', () => {
  assert.equal(isAllowedOrigin('http://evil.com', PORT), false);
  assert.equal(isAllowedOrigin(`https://127.0.0.1:${PORT}`, PORT), false, 'we never serve https');
  assert.equal(isAllowedOrigin(`http://127.0.0.1:${PORT + 1}`, PORT), false);
});

test('Origin: opaque and malformed origins are rejected', () => {
  assert.equal(isAllowedOrigin('null', PORT), false);
  assert.equal(isAllowedOrigin('not a url', PORT), false);
});

test('Origin: absent is allowed (non-browser clients), token still gates', () => {
  assert.equal(isAllowedOrigin(undefined, PORT), true);
});

// --- Token -------------------------------------------------------------------------

test('token: exact match only', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN.slice(0, -1) + 'b', TOKEN), false);
});

test('token: length mismatch returns false instead of throwing', () => {
  // timingSafeEqual throws on unequal lengths; a naive wrapper would 500 on every probe.
  assert.doesNotThrow(() => tokenMatches('short', TOKEN));
  assert.equal(tokenMatches('short', TOKEN), false);
  assert.equal(tokenMatches('', TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
});

test('token: extracted from bearer header or ?t= query', () => {
  assert.equal(extractToken({ authorization: `Bearer ${TOKEN}` }, undefined), TOKEN);
  assert.equal(extractToken({ authorization: `bearer ${TOKEN}` }, undefined), TOKEN);
  assert.equal(extractToken({}, `/events?t=${TOKEN}`), TOKEN);
  assert.equal(extractToken({}, '/events'), undefined);
});

// --- The gate ----------------------------------------------------------------------

const ok = (over: Record<string, string> = {}, url = '/') => ({
  headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...over },
  url,
});

test('gate: a well-formed local request passes', () => {
  assert.deepEqual(authorizeRequest(ok(), { port: PORT, token: TOKEN }), { ok: true });
});

test('gate: host is checked before the token', () => {
  // A rebinding attempt must not become a token oracle.
  const r = authorizeRequest(ok({ host: 'evil.com', authorization: 'Bearer wrong' }), {
    port: PORT,
    token: TOKEN,
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'bad host');
});

test('gate: cross-site POST with a valid token is still refused', () => {
  const r = authorizeRequest(ok({ origin: 'http://evil.com' }), { port: PORT, token: TOKEN });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'bad origin');
});

test('gate: no token is 401', () => {
  const r = authorizeRequest({ headers: { host: `127.0.0.1:${PORT}` }, url: '/' }, { port: PORT, token: TOKEN });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 401);
});
