import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// isolateHome() BEFORE importing anything that derives paths from homedir(), and prove it took.
// See test/helpers/isolateHome.ts. Run with `npm test`, never `bun test`.
const { home: HOME } = isolateHome('credref-resolve');
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const { resolveEntryCredential } = await import('../src/config.js');

test.beforeEach(() => store.setUnlockedVault(null));
test.after(() => rmSync(HOME, { recursive: true, force: true }));

test('credRef resolves from its vault slot', () => {
  store.setUnlockedVault({ 'model.zai': { apiKey: 'zai-key' } });
  const r = resolveEntryCredential({ provider: 'openai', credRef: 'model.zai' });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.apiKey, 'zai-key');
  assert.equal(r.ok && r.source, 'credRef');
});

test('LEAK GUARD: a credRef miss never falls back to the adapter key', () => {
  // Every custom preset (z.ai, Gemini, local vLLM) is adapter 'openai'. If a credRef miss fell
  // through to resolveApiKey('openai'), Shadow would send the user's OpenAI key to whatever host
  // that preset's baseUrl names — a real disclosure to a third party. It must fail instead.
  store.setUnlockedVault({ openai: { apiKey: 'OPENAI-SECRET' } });
  const r = resolveEntryCredential({ provider: 'openai', credRef: 'model.zai' });

  assert.equal(r.ok, false, 'a missing slot is a hard failure, not a fallback');
  assert.equal(r.ok === false && r.slot, 'model.zai');
  // The adapter key must appear nowhere in the result, by any path.
  assert.equal(JSON.stringify(r).includes('OPENAI-SECRET'), false, 'adapter key must not leak into the result');
});

test('LEAK GUARD: env vars are not consulted for a credRef slot either', () => {
  process.env.OPENAI_API_KEY = 'ENV-OPENAI-SECRET';
  try {
    store.setUnlockedVault({});
    const r = resolveEntryCredential({ provider: 'openai', credRef: 'model.zai' });
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(r).includes('ENV-OPENAI-SECRET'), false);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('credRef with a locked vault reports locked, not missing', () => {
  store.setUnlockedVault(null); // locked
  const r = resolveEntryCredential({ provider: 'openai', credRef: 'model.zai' }, { vaultIsLocked: true });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, 'locked');
});

test('legacy inline apiKey still works (unmigrated configs keep running)', () => {
  const r = resolveEntryCredential({ provider: 'openai', apiKey: 'inline-key' });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.apiKey, 'inline-key');
  assert.equal(r.ok && r.source, 'inline');
});

test('no credRef and no inline key falls back to provider-level resolution', () => {
  store.setUnlockedVault({ openai: { apiKey: 'adapter-key' } });
  const r = resolveEntryCredential({ provider: 'openai' });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.apiKey, 'adapter-key');
  assert.equal(r.ok && r.source, 'provider');
});

test('credRef wins over a co-present inline apiKey', () => {
  store.setUnlockedVault({ 'model.zai': { apiKey: 'vault-key' } });
  const r = resolveEntryCredential({ provider: 'openai', credRef: 'model.zai', apiKey: 'stale-inline' });
  assert.equal(r.ok && r.apiKey, 'vault-key');
  assert.equal(r.ok && r.source, 'credRef');
});

test('authToken resolves through a slot too', () => {
  store.setUnlockedVault({ 'model.anth': { authToken: 'bearer-tok' } });
  const r = resolveEntryCredential({ provider: 'anthropic', credRef: 'model.anth' });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.authToken, 'bearer-tok');
});
