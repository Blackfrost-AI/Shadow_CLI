import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

/**
 * Pins the PRODUCTION registry branch (`updateEndpointRegistry` with no explicit path), which
 * persists into the user's global `config.json`.
 *
 * SAFETY: these tests must never read or write the real `~/.shadow/config.json`. An earlier
 * version of this file pointed straight at the real file and restored it from a single `finally`;
 * when the suite was interrupted between the write and the restore, the user's live config was
 * left clobbered — models gone, endpoints gone. `isolateHome()` redirects HOME *before* the store
 * is imported and proves the redirect took, so the module under test cannot reach a real home.
 */

const { home: HOME, shadowDir } = isolateHome('endpoints-registry-global');
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, HOME);

const realConfig = join(shadowDir, 'config.json');

const endpoint = (label: string, id: string) => ({
  id,
  label,
  provider: 'openai' as const,
  baseUrl: 'http://127.0.0.1:8000/v1',
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
});

test('the sandbox never points at the real user config', () => {
  assert.equal(GLOBAL_DIR, shadowDir);
});

test('global registry: production writes persist into config.json and keep other settings', async () => {
  writeFileSync(realConfig, JSON.stringify({ provider: 'openai', theme: 'snowfall' }, null, 2), { mode: 0o600 });
  const { createEndpointId, loadEndpointRegistry, updateEndpointRegistry } = await import(
    '../src/endpoints/store.js'
  );

  const state = updateEndpointRegistry({ expectedRevision: 0, add: endpoint('lan-box', createEndpointId()) });
  assert.equal(state.revision, 1);

  const persisted = JSON.parse(readFileSync(realConfig, 'utf8')) as Record<string, unknown>;
  assert.equal(persisted.provider, 'openai', 'unrelated settings survive the registry write');
  assert.equal(persisted.theme, 'snowfall');
  const endpoints = persisted.endpoints as { revision: number; endpoints: { label: string }[] };
  assert.equal(endpoints.revision, 1);
  assert.equal(endpoints.endpoints[0]?.label, 'lan-box');
  assert.equal(loadEndpointRegistry().endpoints.length, 1);

  const { EndpointConflictError } = await import('../src/endpoints/store.js');
  assert.throws(
    () => updateEndpointRegistry({ expectedRevision: 0, add: endpoint('stale', createEndpointId()) }),
    (error: unknown) => error instanceof EndpointConflictError && error.actualRevision === 1,
  );
});

test('global registry: concurrent production writers never lose an endpoint', async () => {
  writeFileSync(realConfig, JSON.stringify({ provider: 'openai' }, null, 2), { mode: 0o600 });
  const storeUrl = new URL('../src/endpoints/store.ts', import.meta.url).href;
  const RACERS = 6;
  // Racer 0 is this process; the rest are real OS processes. All start from the same revision,
  // which is exactly the interleaving that dropped an endpoint before the lock existed.
  const script = `const store = await import(${JSON.stringify(storeUrl)});
    const barrier = Number(process.env.BARRIER);
    while (Date.now() < barrier) {}
    const label = process.env.LABEL;
    const now = new Date().toISOString();
    const add = { id: store.createEndpointId(), label, provider: 'openai',
      baseUrl: 'http://127.0.0.1:8000/v1', createdAt: now, updatedAt: now };
    for (let attempt = 0; ; attempt++) {
      try {
        store.updateEndpointRegistry({ expectedRevision: store.loadEndpointRegistry().revision, add });
        break;
      } catch (error) {
        if (error?.code !== 'endpoint_revision_conflict' || attempt > 50) throw error;
      }
    }
    process.exit(0);`;
  const barrier = Date.now() + 700;
  const children = Array.from({ length: RACERS - 1 }, (_, i) =>
    spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: { ...process.env, BARRIER: String(barrier), LABEL: `racer-${i + 1}` },
    }),
  );
  const { createEndpointId, loadEndpointRegistry, updateEndpointRegistry } = await import(
    '../src/endpoints/store.js'
  );
  while (Date.now() < barrier) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let attempt = 0; ; attempt++) {
    try {
      updateEndpointRegistry({ expectedRevision: loadEndpointRegistry().revision, add: endpoint('racer-0', createEndpointId()) });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'endpoint_revision_conflict' || attempt > 50) throw error;
    }
  }

  const exits = await Promise.all(children.map((child) => new Promise<number | null>((r) => child.on('exit', r))));
  assert.deepEqual(exits, Array.from({ length: RACERS - 1 }, () => 0), 'every racer must write cleanly');
  const labels = loadEndpointRegistry().endpoints.map((entry) => entry.label).sort();
  assert.deepEqual(
    labels,
    Array.from({ length: RACERS }, (_, i) => `racer-${i}`).sort(),
    'no racer may be lost or duplicated',
  );
  const persisted = JSON.parse(readFileSync(realConfig, 'utf8')) as Record<string, unknown>;
  assert.equal(persisted.provider, 'openai', 'unrelated settings survive concurrent registry writes');
  assert.equal((persisted.endpoints as { revision: number }).revision, RACERS);
});

test('global registry: a malformed registry blob fails closed to empty, never bricks the API', async () => {
  const { loadEndpointRegistry, updateEndpointRegistry, createEndpointId } = await import(
    '../src/endpoints/store.js'
  );
  for (const bad of [{}, { schemaVersion: 99, endpoints: [], observations: [] }, { schemaVersion: 1, endpoints: 'nope' }]) {
    writeFileSync(realConfig, JSON.stringify({ provider: 'openai', endpoints: bad }, null, 2), { mode: 0o600 });
    const loaded = loadEndpointRegistry();
    assert.equal(loaded.endpoints.length, 0, `malformed registry ${JSON.stringify(bad)} must read as empty`);
    assert.equal(loaded.revision, 0);
  }
  writeFileSync(realConfig, JSON.stringify({ endpoints: { broken: true } }, null, 2), { mode: 0o600 });
  const state = updateEndpointRegistry({ expectedRevision: 0, add: endpoint('after-corruption', createEndpointId()) });
  assert.equal(state.revision, 1);
  assert.deepEqual(loadEndpointRegistry().endpoints.map((e) => e.label), ['after-corruption']);
});