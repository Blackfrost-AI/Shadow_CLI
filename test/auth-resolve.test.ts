import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuth } from '../src/auth/resolve.js';
import type { ImportedCredential } from '../src/auth/types.js';

const NOW = 1_700_000_000;

test('anthropic is API-key-only: env bearer passes, import is ignored', () => {
  const live: ImportedCredential = { provider: 'codex', kind: 'apiKey', token: 'leak' };
  assert.deepEqual(resolveAuth({ provider: 'anthropic', allowImport: true, envBearer: 'sk-ant', liveImport: live, nowSec: NOW }), {
    bearer: 'sk-ant',
    source: 'env',
  });
  // No env key and no permitted import → nothing (never an imported cred for anthropic).
  assert.equal(resolveAuth({ provider: 'anthropic', allowImport: true, liveImport: live, nowSec: NOW }), undefined);
});

test('explicit env bearer wins over import for any provider', () => {
  const live: ImportedCredential = { provider: 'codex', kind: 'subscription', token: 'at', accountId: 'a1' };
  const r = resolveAuth({ provider: 'openai', subProvider: 'codex', allowImport: true, envBearer: 'sk-env', liveImport: live, nowSec: NOW });
  assert.deepEqual(r, { bearer: 'sk-env', source: 'env' });
});

test('import is gated behind allowImport', () => {
  const live: ImportedCredential = { provider: 'codex', kind: 'apiKey', token: 'k' };
  assert.equal(resolveAuth({ provider: 'openai', subProvider: 'codex', allowImport: false, liveImport: live, nowSec: NOW }), undefined);
});

test('codex subscription import → subscription base + identity headers + expiry', () => {
  const live: ImportedCredential = { provider: 'codex', kind: 'subscription', token: 'at', accountId: 'acc-9', expiresAt: NOW + 3600 };
  const r = resolveAuth({ provider: 'openai', subProvider: 'codex', allowImport: true, liveImport: live, nowSec: NOW });
  assert.equal(r?.bearer, 'at');
  assert.equal(r?.baseUrl, 'https://chatgpt.com/backend-api/codex');
  assert.equal(r?.extraHeaders?.['ChatGPT-Account-ID'], 'acc-9');
  assert.equal(r?.extraHeaders?.['OAI-Product-Sku'], 'codex');
  assert.equal(r?.expiresAt, NOW + 3600);
  assert.equal(r?.source, 'imported-codex');
});

test('grok api_key import → sanctioned api.x.ai base, no extra headers', () => {
  const live: ImportedCredential = { provider: 'grok', kind: 'apiKey', token: 'xai-key' };
  const r = resolveAuth({ provider: 'openai', subProvider: 'grok', allowImport: true, liveImport: live, nowSec: NOW });
  assert.equal(r?.bearer, 'xai-key');
  assert.equal(r?.baseUrl, 'https://api.x.ai/v1');
  assert.deepEqual(r?.extraHeaders, undefined);
});

test('freshest wins: expired stored falls back to live', () => {
  const stored: ImportedCredential = { provider: 'codex', kind: 'subscription', token: 'old', expiresAt: NOW - 10 };
  const live: ImportedCredential = { provider: 'codex', kind: 'subscription', token: 'new', expiresAt: NOW + 3600 };
  const r = resolveAuth({ provider: 'openai', subProvider: 'codex', allowImport: true, storedCred: stored, liveImport: live, nowSec: NOW });
  assert.equal(r?.bearer, 'new');
});
