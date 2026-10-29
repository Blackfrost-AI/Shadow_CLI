import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EndpointWatcher } from '../src/endpoints/watcher.js';
import type { ObservedEndpoint, SavedEndpoint } from '../src/endpoints/types.js';

const endpoints: SavedEndpoint[] = [1, 2, 3].map((n) => ({
  id: `ep_${n}`, label: `endpoint-${n}`, provider: 'openai', baseUrl: `http://127.0.0.1:${8000 + n}/v1`, createdAt: '', updatedAt: '',
}));
const observation = (endpoint: SavedEndpoint): ObservedEndpoint => ({ identity: endpoint.id, endpointId: endpoint.id, baseUrl: endpoint.baseUrl, models: [], auth: 'none', readiness: 'ready', observedAt: new Date().toISOString() });

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('watcher respects the concurrency cap and reports selected endpoints', async () => {
  let active = 0;
  let peak = 0;
  const seen: string[] = [];
  const watcher = new EndpointWatcher({ intervalMs: 10_000, concurrency: 2, probe: async (endpoint) => {
    active += 1; peak = Math.max(peak, active); await wait(15); active -= 1; return observation(endpoint);
  }, onResult: ({ endpoint }) => { seen.push(endpoint.id); } });
  watcher.start(endpoints);
  await wait(55);
  watcher.stop();
  assert.equal(peak, 2);
  assert.deepEqual(seen.sort(), endpoints.map((item) => item.id).sort());
});

test('stopping invalidates late probe results', async () => {
  const seen: string[] = [];
  const watcher = new EndpointWatcher({ concurrency: 1, probe: async (endpoint, signal) => {
    await wait(25);
    assert.equal(signal.aborted, true);
    return observation(endpoint);
  }, onResult: ({ endpoint }) => { seen.push(endpoint.id); } });
  watcher.start([endpoints[0]!]);
  await wait(2);
  watcher.stop();
  await wait(40);
  assert.deepEqual(seen, []);
});

test('a fresh selection supersedes the previous sweep', async () => {
  const seen: string[] = [];
  const watcher = new EndpointWatcher({ concurrency: 1, probe: async (endpoint) => { await wait(20); return observation(endpoint); }, onResult: ({ endpoint }) => { seen.push(endpoint.id); } });
  watcher.start([endpoints[0]!]);
  await wait(2);
  watcher.start([endpoints[2]!]);
  await wait(45);
  watcher.stop();
  assert.deepEqual(seen, ['ep_3']);
});
