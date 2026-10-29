import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideFollow } from '../src/endpoints/follow.js';
import type { ObservedEndpoint, SavedEndpoint } from '../src/endpoints/types.js';

const endpoint: SavedEndpoint = { id: 'ep', label: 'box', provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', model: 'alias', follow: { enabled: true, modelId: 'alias' }, createdAt: '', updatedAt: '' };
const observed = (overrides: Partial<ObservedEndpoint> = {}): ObservedEndpoint => ({ identity: 'ep', endpointId: 'ep', baseUrl: endpoint.baseUrl, models: [{ id: 'alias' }], auth: 'none', readiness: 'ready', observedAt: 'now', ...overrides });

test('follow is opt-in and never adopts by discovery alone', () => {
  assert.equal(decideFollow({ endpoint: { ...endpoint, follow: undefined }, observation: observed(), running: false, enabled: false }, observed({ deploymentId: 'b' })).action, 'ignore');
});

test('follow waits while a turn runs or endpoint is loading/down', () => {
  assert.equal(decideFollow({ endpoint, observation: observed({ deploymentId: 'a' }), running: true, enabled: true }, observed({ deploymentId: 'b' })).action, 'wait');
  assert.equal(decideFollow({ endpoint, observation: observed({ deploymentId: 'a' }), running: false, enabled: true }, observed({ readiness: 'loading', deploymentId: 'b' })).action, 'wait');
  assert.equal(decideFollow({ endpoint, observation: observed({ deploymentId: 'a' }), running: false, enabled: true }, observed({ readiness: 'down', deploymentId: 'b' })).action, 'wait');
});

test('follow adopts a changed deployment only when the followed model is present', () => {
  const decision = decideFollow({ endpoint, observation: observed({ deploymentId: 'a' }), running: false, enabled: true }, observed({ deploymentId: 'b' }));
  assert.deepEqual(decision, { action: 'adopt', reason: 'followed deployment is now alias', modelId: 'alias', deploymentId: 'b' });
  assert.equal(decideFollow({ endpoint, observation: observed({ deploymentId: 'a' }), running: false, enabled: true }, observed({ deploymentId: 'b', models: [{ id: 'other' }] })).action, 'wait');
});

test('unchanged identity does not trigger adoption without a revision', () => {
  assert.equal(decideFollow({ endpoint, observation: observed(), running: false, enabled: true }, observed()).action, 'ignore');
});
