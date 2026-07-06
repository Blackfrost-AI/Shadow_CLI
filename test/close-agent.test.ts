import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeAgent } from '../src/tools/webFetch.js';

/**
 * Regression guard for the shipped-binary web-tool crash: Node's undici Agent has
 * `.close()`, but the Bun-compiled binary's Agent does NOT — a bare `agent.close()`
 * threw "agent.close is not a function" on EVERY web_fetch / web_search call in the
 * v1.0.0-rc.1 binary (the Node test suite never caught it because Node's Agent has
 * close()). closeAgent() must guard both methods and never throw.
 */

test('closeAgent: no-op on undefined', () => {
  assert.doesNotThrow(() => closeAgent(undefined));
});

test('closeAgent: uses .close() when present (Node undici)', () => {
  let closed = false;
  closeAgent({ close: () => { closed = true; } } as never);
  assert.equal(closed, true);
});

test('closeAgent: falls back to .destroy() when .close is absent', () => {
  let destroyed = false;
  closeAgent({ destroy: () => { destroyed = true; } } as never);
  assert.equal(destroyed, true);
});

test('closeAgent: does NOT throw when neither .close nor .destroy exists (the Bun-binary crash)', () => {
  assert.doesNotThrow(() => closeAgent({} as never));
});

test('closeAgent: swallows an error thrown by close() — teardown must never fail the tool', () => {
  assert.doesNotThrow(() => closeAgent({ close: () => { throw new Error('boom'); } } as never));
});
