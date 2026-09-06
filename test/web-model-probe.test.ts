import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const fixture = isolateHome('model-probe');
for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete process.env[name];
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, fixture.home);
const { probeModel, credentialStatus, endpointLabel } = await import('../src/web/modelProbe.js');
const entry = { label: 'My model', provider: 'openai' as const, model: 'sample', baseUrl: 'http://127.0.0.1:1234/v1', credRef: 'model.example' };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; store.setUnlockedVault(null); });

test('endpoint probe uses the selected model credential and checks its model list', async () => {
  store.setUnlockedVault({ openai: { apiKey: 'other-key' }, 'model.example': { apiKey: 'model-key' } });
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://127.0.0.1:1234/v1/models');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer model-key');
    assert.equal(init?.body, undefined);
    return Response.json({ data: [{ id: 'sample' }] });
  };
  const result = await probeModel(entry, 'endpoint');
  assert.equal(result.ok, true);
  assert.equal(result.modelAvailable, true);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /model-key|other-key/);
});

test('response probe sends only the fixed bounded prompt and never echoes the answer', async () => {
  store.setUnlockedVault({ 'model.example': { apiKey: 'model-key' } });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:1234/v1/chat/completions');
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'sample', messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 64, stream: false });
    return Response.json({ choices: [{ message: { content: 'private-provider-output' } }] });
  };
  const result = await probeModel(entry, 'response');
  assert.equal(result.ok, true);
  assert.match(result.message, /Tool calling was not tested/);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-output/);
});

test('authentication failure is actionable and never echoes the provider body', async () => {
  store.setUnlockedVault({ 'model.example': { apiKey: 'model-key' } });
  globalThis.fetch = async () => Response.json({ error: 'provider echoed model-key' }, { status: 401 });
  const result = await probeModel(entry, 'endpoint');
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.message, /credential source/);
  assert.doesNotMatch(JSON.stringify(result), /model-key/);
});

test('a missing model credential is visible before any request', async () => {
  store.setUnlockedVault({ openai: { apiKey: 'other-key' } });
  globalThis.fetch = async () => { assert.fail('No request should be made'); };
  assert.equal((await probeModel(entry, 'endpoint')).ok, false);
  assert.equal(credentialStatus(entry), 'Model credential missing');
});

test('probe distinguishes unsupported discovery, redirects and non-JSON web pages', async () => {
  store.setUnlockedVault({ 'model.example': { apiKey: 'model-key' } });
  for (const [response, message] of [
    [new Response('', { status: 404 }), /does not expose a models API/],
    [new Response('', { status: 302 }), /credentials were not forwarded/],
    [new Response('<html>Login</html>'), /non-JSON/],
  ] as const) {
    globalThis.fetch = async () => response;
    const result = await probeModel(entry, 'endpoint');
    assert.equal(result.ok, false);
    assert.match(result.message, message);
  }
});

test('endpoint labels omit credential-bearing URL components', () => {
  assert.equal(endpointLabel('https://user:password@example.com/v1?key=secret#token'), 'https://example.com/v1');
});
