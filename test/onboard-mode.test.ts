import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providersForMode, PROVIDERS } from '../src/onboard/catalog.js';

test('mode "cloud" lists every cloud provider + custom, and NO local servers', () => {
  const list = providersForMode('cloud');
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes('anthropic') && ids.includes('openai') && ids.includes('zai'), 'clouds present');
  assert.ok(ids.includes('custom'), 'custom endpoint reachable from cloud');
  assert.ok(!ids.includes('ollama') && !ids.includes('lmstudio'), 'no local servers in the cloud list');
});

test('mode "server" lists local servers + custom, and NO cloud vendors', () => {
  const list = providersForMode('server');
  const ids = list.map((p) => p.id);
  assert.deepEqual(
    ids.sort(),
    ['custom', 'lmstudio', 'ollama', 'ollama-anthropic'].sort(),
    'exactly the local-server entries + custom',
  );
});

test('mode "file" has no provider menu (routes to the .gguf path prompt instead)', () => {
  assert.deepEqual(providersForMode('file'), []);
});

test('every catalog entry is reachable from at least one mode (nothing orphaned)', () => {
  const reachable = new Set([...providersForMode('cloud'), ...providersForMode('server')].map((p) => p.id));
  for (const p of PROVIDERS) assert.ok(reachable.has(p.id), `${p.id} reachable`);
});
