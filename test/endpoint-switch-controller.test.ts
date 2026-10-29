import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EndpointSwitchController } from '../src/endpoints/switchController.js';
import { emptyEndpointRegistry, type SavedEndpoint, type SessionBinding } from '../src/endpoints/types.js';

const first: SavedEndpoint = {
  id: 'ep_first', label: 'first', provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', model: 'one', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
};
const second: SavedEndpoint = { ...first, id: 'ep_second', label: 'second', model: 'two' };
const binding: SessionBinding = { endpointId: first.id, endpointRevision: 1, modelId: 'one', baseUrl: first.baseUrl, generation: 1, selectedAt: first.updatedAt };

function options(overrides: Partial<ConstructorParameters<typeof EndpointSwitchController<number>>[0]> = {}) {
  return {
    getRegistry: () => ({ ...emptyEndpointRegistry(), endpoints: [first, second] }),
    getBinding: () => binding,
    isRunning: () => false,
    prepare: async (endpoint: SavedEndpoint, signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, endpoint.id === first.id ? 5 : 15);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      return { value: endpoint.id === first.id ? 1 : 2, binding: { ...binding, endpointId: endpoint.id, modelId: endpoint.model ?? 'unknown' } };
    },
    commit: async () => undefined,
    ...overrides,
  };
}

test('switch commits only after preparation and retains the prepared binding', async () => {
  const committed: number[] = [];
  const controller = new EndpointSwitchController({ ...options(), commit: (prepared) => { committed.push(prepared.value); } });
  const result = await controller.switchTo(first);
  assert.equal(result.ok, true);
  assert.deepEqual(committed, [1]);
  if (result.ok) assert.equal(result.prepared.binding.endpointId, first.id);
});

test('running turns refuse a switch before preparation', async () => {
  let prepared = false;
  const controller = new EndpointSwitchController({ ...options(), isRunning: () => true, prepare: async () => { prepared = true; throw new Error('must not run'); } });
  const result = await controller.switchTo(first);
  assert.deepEqual(result, { ok: false, reason: 'running' });
  assert.equal(prepared, false);
});

test('a newer selection supersedes and aborts an older preparation', async () => {
  const committed: number[] = [];
  const controller = new EndpointSwitchController({ ...options(), commit: (prepared) => { committed.push(prepared.value); } });
  const old = controller.switchTo(second);
  await new Promise((resolve) => setTimeout(resolve, 1));
  const current = controller.switchTo(first);
  const [oldResult, currentResult] = await Promise.all([old, current]);
  assert.notEqual(oldResult.ok && oldResult.prepared.value, 2);
  assert.equal(currentResult.ok, true);
  assert.deepEqual(committed, [1]);
});

test('cancel aborts preparation and never commits', async () => {
  const committed: number[] = [];
  const controller = new EndpointSwitchController({ ...options(), commit: (prepared) => { committed.push(prepared.value); } });
  const pending = controller.switchTo(second);
  controller.cancel();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(committed, []);
});
