import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexAuth, parseGrokAuth, jwtExp, isExpired, readImported } from '../src/auth/importStore.js';
import { base64url } from '../src/auth/pkce.js';

/** Build a throwaway unsigned JWT carrying an `exp` claim. */
function jwtWithExp(exp: number): string {
  const h = base64url(Buffer.from(JSON.stringify({ alg: 'none' })));
  const p = base64url(Buffer.from(JSON.stringify({ exp })));
  return `${h}.${p}.sig`;
}

test('parseCodexAuth: API-key mode wins (sanctioned)', () => {
  const c = parseCodexAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test', tokens: null });
  assert.deepEqual(c, { provider: 'codex', kind: 'apiKey', token: 'sk-test' });
});

test('parseCodexAuth: subscription tokens', () => {
  const access = jwtWithExp(2_000_000_000);
  const c = parseCodexAuth({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: 'idt', access_token: access, refresh_token: 'rt', account_id: 'acc-1' },
    last_refresh: '2026-06-22T00:00:00Z',
  });
  assert.equal(c?.kind, 'subscription');
  assert.equal(c?.token, access);
  assert.equal(c?.refreshToken, 'rt');
  assert.equal(c?.accountId, 'acc-1');
  assert.equal(c?.expiresAt, 2_000_000_000);
});

test('parseGrokAuth: issuer-keyed map, api_key preferred', () => {
  const c = parseGrokAuth({ 'https://auth.x.ai::uuid-1': { api_key: 'xai-key', access_token: 'at' } });
  assert.deepEqual(c, { provider: 'grok', kind: 'apiKey', token: 'xai-key' });
});

test('parseGrokAuth: falls back to access_token + expires_at', () => {
  const c = parseGrokAuth({
    'https://auth.x.ai::uuid-1': { access_token: 'at', refresh_token: 'rt', expires_at: 1_900_000_000, token_type: 'Bearer' },
  });
  assert.equal(c?.kind, 'subscription');
  assert.equal(c?.token, 'at');
  assert.equal(c?.expiresAt, 1_900_000_000);
});

test('parseGrokAuth: browser-login shape (key bearer + RFC3339 expires_at)', () => {
  const c = parseGrokAuth({
    'https://auth.x.ai::uuid-1': {
      key: 'grok-session-key',
      auth_mode: 'oidc',
      refresh_token: 'rt86',
      expires_at: '2026-07-01T00:00:00Z',
      oidc_issuer: 'https://auth.x.ai',
    },
  });
  assert.equal(c?.kind, 'subscription');
  assert.equal(c?.token, 'grok-session-key');
  assert.equal(c?.refreshToken, 'rt86');
  assert.equal(c?.expiresAt, Math.floor(Date.parse('2026-07-01T00:00:00Z') / 1000));
});

test('parse functions reject junk', () => {
  assert.equal(parseCodexAuth(null), undefined);
  assert.equal(parseCodexAuth({ tokens: {} }), undefined);
  assert.equal(parseGrokAuth({}), undefined);
});

test('jwtExp extracts exp; tolerates non-JWT', () => {
  assert.equal(jwtExp(jwtWithExp(123)), 123);
  assert.equal(jwtExp('not-a-jwt'), undefined);
});

test('isExpired: api keys never expire; tokens respect skew', () => {
  assert.equal(isExpired({ provider: 'codex', kind: 'apiKey', token: 'k' }, 9_999_999_999), false);
  assert.equal(isExpired({ provider: 'codex', kind: 'subscription', token: 't', expiresAt: 1000 }, 900), false);
  assert.equal(isExpired({ provider: 'codex', kind: 'subscription', token: 't', expiresAt: 1000 }, 950, 60), true); // within skew
  assert.equal(isExpired({ provider: 'codex', kind: 'subscription', token: 't' }, 9_999_999_999), false); // unknown exp → live
});

test('readImported: injected reader, missing file → undefined', () => {
  const c = readImported('codex', () => JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
  assert.equal(c?.token, 'sk-x');
  assert.equal(
    readImported('grok', () => {
      throw new Error('ENOENT');
    }),
    undefined,
  );
});
