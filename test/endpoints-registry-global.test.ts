import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

/**
 * Pins the PRODUCTION registry branch (`updateEndpointRegistry` with no explicit path), which
 * persists into `~/.shadow/config.json`.
 *
 * The path-based tests in endpoints-store.test.ts exercise the standalone-file branch. That branch
 * already held a lock; the global branch did not, so a test green on the file branch said nothing
 * about what shipped. These tests run against the real global-config code path and temporarily
 * replace `~/.shadow/config.json`, restoring the original bytes at the end.
 */

const shadowDir = join(homedir(), '.shadow');
const realConfig = join(shadowDir, 'config.json');
const saved = (() => {
  try {
    return readFileSync(realConfig);
  } catch {
    return null;
  }
})();

function restore(): void {
  if (saved) writeFileSync(realConfig, saved, { mode: 0o600 });
  else rmSync(realConfig, { force: true });
}

const endpoint = (label: string, id: string) => ({
  id,
  label,
  provider: 'openai' as const,
  baseUrl: 'http://127.0.0.1:8000/v1',
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
});

test('global registry: production writes persist into config.json and keep other settings', async () => {
  const work = mkdtempSync(join(tmpdir(), 'shadow-endpoints-global-'));
  try {
    mkdirSync(shadowDir, { recursive: true, mode: 0o700 });
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

    // A stale writer still fails closed against the on-disk revision.
    const { EndpointConflictError } = await import('../src/endpoints/store.js');
    assert.throws(
      () => updateEndpointRegistry({ expectedRevision: 0, add: endpoint('stale', createEndpointId()) }),
      (error: unknown) => error instanceof EndpointConflictError && error.actualRevision === 1,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
    restore();
  }
});
test('global registry: concurrent production writers never lose an endpoint', async () => {
  try {
    mkdirSync(shadowDir, { recursive: true, mode: 0o700 });
    writeFileSync(realConfig, JSON.stringify({ provider: 'openai' }, null, 2), { mode: 0o600 });
    const storeUrl = new URL('../src/endpoints/store.ts', import.meta.url).href;
    const RACERS = 6;
    // Racer 0 is this process (in-process path); the rest are real OS processes. All start from the
    // same revision and write at the same instant, which is exactly the interleaving that dropped
    // an endpoint before the lock existed: both read revision N, second rename wins.
    const script = `const store = await import(${JSON.stringify(storeUrl)});
      const barrier = Number(process.env.BARRIER);
      while (Date.now() < barrier) {}
      const label = process.env.LABEL;
      const now = new Date().toISOString();
      const add = { id: store.createEndpointId(), label, provider: 'openai',
        baseUrl: 'http://127.0.0.1:8000/v1', createdAt: now, updatedAt: now };
      // A revision conflict is the intended fail-closed answer for a lost race; the client retries
      // against the fresh revision. What must never happen is a silently dropped endpoint.
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
  } finally {
    restore();
  }
});

test('global registry: a malformed registry blob fails closed to empty, never bricks the API', async () => {
  try {
    mkdirSync(shadowDir, { recursive: true, mode: 0o700 });
    const { loadEndpointRegistry, updateEndpointRegistry, createEndpointId } = await import(
      '../src/endpoints/store.js'
    );
    for (const bad of [{}, { schemaVersion: 99, endpoints: [], observations: [] }, { schemaVersion: 1, endpoints: 'nope' }]) {
      writeFileSync(realConfig, JSON.stringify({ provider: 'openai', endpoints: bad }, null, 2), { mode: 0o600 });
      const loaded = loadEndpointRegistry();
      assert.equal(loaded.endpoints.length, 0, `malformed registry ${JSON.stringify(bad)} must read as empty`);
      assert.equal(loaded.revision, 0);
    }
    // And a write over a corrupt blob succeeds, replacing it.
    writeFileSync(realConfig, JSON.stringify({ endpoints: { broken: true } }, null, 2), { mode: 0o600 });
    const state = updateEndpointRegistry({ expectedRevision: 0, add: endpoint('after-corruption', createEndpointId()) });
    assert.equal(state.revision, 1);
    assert.deepEqual(loadEndpointRegistry().endpoints.map((e) => e.label), ['after-corruption']);
  } finally {
    restore();
  }
});
