import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkCenter, type WorkCenterSnapshot, type WorkItem } from '../src/app/workCenter.js';
import { queryWorkHistory, readLatestWorkCenterSnapshot, recordWorkCenterSnapshot } from '../src/state/workCenterPersistence.js';
import { SessionLog } from '../src/state/session.js';

function item(id: string, status: WorkItem['status'] = 'completed'): WorkItem {
  return {
    id,
    type: 'subagent',
    status,
    description: `work ${id}`,
    depth: 0,
    startedAt: 1,
    lastActivityAt: 2,
    activities: [],
  };
}

function record(snapshot: WorkCenterSnapshot): string {
  return JSON.stringify({ ts: new Date().toISOString(), kind: 'work_center_snapshot', data: snapshot });
}

test('reverse scan returns the newest valid snapshot and skips torn/corrupt lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-work-persist-'));
  const path = join(root, 'session.jsonl');
  try {
    const oldSnap: WorkCenterSnapshot = { version: 1, capturedAt: 1, items: [item('old')] };
    const newSnap: WorkCenterSnapshot = { version: 1, capturedAt: 2, items: [item('new')] };
    writeFileSync(path, `${record(oldSnap)}\nnot-json\n${record(newSnap)}\n{"kind":"work_center_snapshot"`);
    assert.equal(readLatestWorkCenterSnapshot(path)?.items[0]?.id, 'new');
    assert.equal(readLatestWorkCenterSnapshot(join(root, 'missing.jsonl')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore preserves completed work and marks live/paused work interrupted', () => {
  const center = new WorkCenter();
  center.restore({ version: 1, capturedAt: 1, items: [item('done'), item('live', 'running'), item('wait', 'paused')] });
  assert.equal(center.get('done')?.status, 'completed');
  assert.equal(center.get('live')?.status, 'failed');
  assert.equal(center.get('wait')?.status, 'failed');
  assert.match(center.get('live')?.exitReason ?? '', /session ended/);
});

test('cross-session query returns the newest snapshot from five sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-work-history-'));
  const dir = join(root, '.shadow', 'sessions');
  mkdirSync(dir, { recursive: true });
  try {
    for (let i = 0; i < 5; i++) {
      const first: WorkCenterSnapshot = { version: 1, capturedAt: i, items: [item(`stale-${i}`)] };
      const latest: WorkCenterSnapshot = { version: 1, capturedAt: i + 10, items: [item(`latest-${i}`)] };
      writeFileSync(join(dir, `2026-01-0${i + 1}.jsonl`), `${record(first)}\n${record(latest)}\n`);
    }
    const rows = queryWorkHistory(root);
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.item.id.startsWith('latest-')));
    assert.equal(queryWorkHistory(root, '2026-01-03').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a worst-case bounded 50-item snapshot stays below 10 MB', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-work-size-'));
  const path = join(root, 'session.jsonl');
  try {
    const items = Array.from({ length: 50 }, (_, i): WorkItem => ({
      ...item(`agent-${i}`),
      finalOutput: 'x'.repeat(64 * 1024),
      activities: Array.from({ length: 100 }, (__, j) => ({ timestamp: j, type: 'detail', text: 'y'.repeat(1000) })),
    }));
    writeFileSync(path, `${record({ version: 1, capturedAt: Date.now(), items })}\n`);
    assert.ok(statSync(path).size < 10 * 1024 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable writes replace a 0600 sidecar instead of appending repeated full snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-work-sidecar-'));
  try {
    const log = SessionLog.open(root);
    for (let i = 0; i < 20; i++) {
      recordWorkCenterSnapshot(log, { version: 1, capturedAt: i, items: [item(`latest-${i}`)] });
    }
    const sidecar = `${log.path}.work.json`;
    assert.equal(readLatestWorkCenterSnapshot(log.path)?.items[0]?.id, 'latest-19');
    assert.ok(statSync(sidecar).size < 10_000);
    if (process.platform !== 'win32') assert.equal(statSync(sidecar).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
