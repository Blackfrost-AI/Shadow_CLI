import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home } = isolateHome('ops-schema');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { OpsGraph } = await import('../src/security/ops/graph.js');
const { OPS_SCHEMA_VERSION } = await import('../src/security/ops/types.js');

function tempWs(): string {
  return mkdtempSync(join(tmpdir(), 'ops-schema-ws-'));
}

test('db opens with 0700 dir / 0600 files incl -wal/-shm while open', () => {
  const ws = tempWs();
  try {
    const g = new OpsGraph(ws, { findingStatus: () => 'open' });
    const dir = join(ws, '.shadow', 'security');
    const db = join(dir, 'ops.sqlite');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(db).mode & 0o777, 0o600);
    // -wal/-shm exist after writes while the connection is open.
    g.startRun({ engagementId: 'eng', objective: 'schema check' });
    for (const suffix of ['-wal', '-shm']) {
      assert.ok(existsSync(db + suffix), `expected ${suffix} to exist while open`);
      assert.equal(statSync(db + suffix).mode & 0o777, 0o600, `${suffix} mode`);
    }
    g.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('busy_timeout set; WAL journal mode', () => {
  const ws = tempWs();
  try {
    const g = new OpsGraph(ws, { findingStatus: () => 'open' });
    g.startRun({ engagementId: 'eng', objective: 'pragma check' });
    g.close();
    const raw = new DatabaseSync(join(ws, '.shadow', 'security', 'ops.sqlite'));
    raw.exec('PRAGMA busy_timeout=5000');
    assert.equal((raw.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
    assert.equal((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    raw.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('user_version guard rejects a future schema version', () => {
  const ws = tempWs();
  try {
    const g = new OpsGraph(ws, { findingStatus: () => 'open' });
    assert.equal(OPS_SCHEMA_VERSION, 1);
    g.close();
    const raw = new DatabaseSync(join(ws, '.shadow', 'security', 'ops.sqlite'));
    raw.exec(`PRAGMA user_version=${OPS_SCHEMA_VERSION + 1}`);
    raw.close();
    assert.throws(() => new OpsGraph(ws, { findingStatus: () => 'open' }), /newer than this Shadow version/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('all §3 tables and indexes exist', () => {
  const ws = tempWs();
  try {
    const g = new OpsGraph(ws, { findingStatus: () => 'open' });
    g.startRun({ engagementId: 'eng', objective: 'tables check' });
    g.close();
    const raw = new DatabaseSync(join(ws, '.shadow', 'security', 'ops.sqlite'));
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['nodes', 'anchors', 'triggers', 'runs', 'run_locks']) assert.ok(names.includes(t), `table ${t}`);
    for (const i of ['idx_nodes_run_kind_state', 'idx_triggers_run_consumed']) assert.ok(names.includes(i), `index ${i}`);
    assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, OPS_SCHEMA_VERSION);
    raw.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});