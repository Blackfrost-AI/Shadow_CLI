import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCheckpoint, saveCheckpointAbsent, listCheckpointsForTurn, listCheckpointTurns } from '../src/state/checkpoints.js';

/**
 * T0-5 — /rewind destroyed the backup it exists to restore.
 *
 * Four compounding defects, each independently reproduced below:
 *   1. turnIndex restarted at 0 per user message, so turn 1 and turn 5 collided in one dir…
 *   2. …and saveCheckpoint overwrote unconditionally, so the pristine original was lost.
 *   3. The model's raw `input.path` was the key, so `src/a.ts` and `/abs/src/a.ts` were two
 *      entries for one file, applied in arbitrary order.
 *   4. rewind restored ONLY the target turn, leaving every later turn's edits on disk.
 */
function ws(): string {
  const d = mkdtempSync(join(tmpdir(), 'rewind-integrity-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  return d;
}

test('first write wins: a second edit in the same turn must not clobber the backup', () => {
  const root = ws();
  try {
    saveCheckpoint(root, 's1', 2, 'src/a.ts', 'ORIGINAL');
    saveCheckpoint(root, 's1', 2, 'src/a.ts', 'AFTER-FIRST-EDIT');
    const entries = listCheckpointsForTurn(root, 's1', 2);
    assert.equal(entries.length, 1, 'one entry per file per turn');
    assert.equal(readFileSync(entries[0]!.absPath, 'utf8'), 'ORIGINAL',
      'the stored backup must be the state BEFORE the turn touched the file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('relative and absolute spellings of one file are ONE checkpoint entry', () => {
  const root = ws();
  try {
    saveCheckpoint(root, 's1', 1, 'src/a.ts', 'ORIGINAL');
    saveCheckpoint(root, 's1', 1, join(root, 'src/a.ts'), 'LATER');
    const entries = listCheckpointsForTurn(root, 's1', 1);
    assert.equal(entries.length, 1, 'the model’s path spelling must not create a second entry');
    assert.equal(readFileSync(entries[0]!.absPath, 'utf8'), 'ORIGINAL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('separate turns keep separate checkpoint dirs', () => {
  const root = ws();
  try {
    saveCheckpoint(root, 's1', 1, 'src/a.ts', 'V1');
    saveCheckpoint(root, 's1', 5, 'src/a.ts', 'V5');
    assert.deepEqual(listCheckpointTurns(root, 's1'), [1, 5]);
    assert.equal(readFileSync(listCheckpointsForTurn(root, 's1', 1)[0]!.absPath, 'utf8'), 'V1');
    assert.equal(readFileSync(listCheckpointsForTurn(root, 's1', 5)[0]!.absPath, 'utf8'), 'V5');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an ABSENT marker records that a file did not exist before the turn', () => {
  const root = ws();
  try {
    saveCheckpointAbsent(root, 's1', 3, 'src/new.ts');
    const [entry] = listCheckpointsForTurn(root, 's1', 3);
    assert.equal(entry!.absent, true);
    assert.equal(entry!.relPath, 'src/new.ts');
    // first-write-wins applies here too
    saveCheckpoint(root, 's1', 3, 'src/new.ts', 'SOMETHING');
    assert.equal(listCheckpointsForTurn(root, 's1', 3).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listCheckpointTurns is empty for an unknown session and never throws', () => {
  const root = ws();
  try {
    assert.deepEqual(listCheckpointTurns(root, 'nope'), []);
    assert.deepEqual(listCheckpointsForTurn(root, 'nope', 0), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('multi_edit and apply_patch now import the checkpoint API at all', async () => {
  // The plainest possible guard for "wrote no checkpoint at all": both modules had zero
  // reference to state/checkpoints, so /rewind silently skipped every file they touched.
  const me = readFileSync(new URL('../src/tools/multiEdit.ts', import.meta.url), 'utf8');
  const ap = readFileSync(new URL('../src/tools/applyPatch.ts', import.meta.url), 'utf8');
  assert.match(me, /saveCheckpoint\(/, 'multi_edit must checkpoint before writing');
  assert.match(ap, /saveCheckpoint\(/, 'apply_patch must checkpoint every write');
  assert.match(ap, /saveCheckpointAbsent\(/, 'apply_patch must record file CREATION so rewind can undo it');
});

// ── end-to-end: rewind must return the WHOLE working tree, not just one turn's files ─────────
const { SessionLog } = await import('../src/state/session.js');
const { Context } = await import('../src/agent/context.js');
const { rewindToTurn } = await import('../src/state/rewind.js');

const HYDRATE = { contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 6 };

test('rewind restores EVERY turn from the target onward, oldest backup winning', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const ctx = new Context(HYDRATE);

    // turn 2 edits a.ts (original "A0"), turn 4 edits both a.ts and b.ts.
    writeFileSync(join(root, 'src/a.ts'), 'A0');
    writeFileSync(join(root, 'src/b.ts'), 'B0');
    const id = SessionLog.sessionIdFromPath(log.path);

    ctx.append({ role: 'user', content: [{ type: 'text', text: 'turn 2' }] });
    log.recordSnapshot(ctx, 2);
    saveCheckpoint(root, id, 2, 'src/a.ts', 'A0');
    writeFileSync(join(root, 'src/a.ts'), 'A2');

    ctx.append({ role: 'user', content: [{ type: 'text', text: 'turn 4' }] });
    log.recordSnapshot(ctx, 4);
    saveCheckpoint(root, id, 4, 'src/a.ts', 'A2'); // a.ts already changed once
    saveCheckpoint(root, id, 4, 'src/b.ts', 'B0');
    writeFileSync(join(root, 'src/a.ts'), 'A4');
    writeFileSync(join(root, 'src/b.ts'), 'B4');

    const res = rewindToTurn(log.path, 2, root, HYDRATE);

    assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'A0',
      'a.ts must go back to its turn-2 original, not to turn 4’s backup');
    assert.equal(readFileSync(join(root, 'src/b.ts'), 'utf8'), 'B0',
      'b.ts was edited in a LATER turn — rewinding past it must undo that too');
    assert.deepEqual(res.restoredFiles.sort(), ['src/a.ts', 'src/b.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rewind deletes files created after the target turn', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const ctx = new Context(HYDRATE);
    const id = SessionLog.sessionIdFromPath(log.path);

    ctx.append({ role: 'user', content: [{ type: 'text', text: 'turn 0' }] });
    log.recordSnapshot(ctx, 0);

    // Turn 1 CREATES a file (apply_patch "Add File") — recorded as absent-before.
    ctx.append({ role: 'user', content: [{ type: 'text', text: 'turn 1' }] });
    log.recordSnapshot(ctx, 1);
    saveCheckpointAbsent(root, id, 1, 'src/new.ts');
    writeFileSync(join(root, 'src/new.ts'), 'CREATED');

    const res = rewindToTurn(log.path, 0, root, HYDRATE);
    assert.equal(existsSync(join(root, 'src/new.ts')), false, 'a file created after the target must be removed');
    assert.deepEqual(res.deletedFiles, ['src/new.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rewind to turn 0 finds turn 0 checkpoints (the old off-by-one read an empty dir)', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const ctx = new Context(HYDRATE);
    const id = SessionLog.sessionIdFromPath(log.path);
    writeFileSync(join(root, 'src/a.ts'), 'ORIGINAL');
    ctx.append({ role: 'user', content: [{ type: 'text', text: 'first' }] });
    log.recordSnapshot(ctx, 0);
    saveCheckpoint(root, id, 0, 'src/a.ts', 'ORIGINAL');
    writeFileSync(join(root, 'src/a.ts'), 'EDITED');

    const res = rewindToTurn(log.path, 0, root, HYDRATE);
    assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'ORIGINAL');
    assert.deepEqual(res.restoredFiles, ['src/a.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session-scoped turn counter does not restart per user message', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const ctx = new Context(HYDRATE);
    assert.equal(SessionLog.countSnapshots(log.path), 0, 'a fresh session starts at 0');
    log.recordSnapshot(ctx, 0);
    log.recordSnapshot(ctx, 1);
    assert.equal(SessionLog.countSnapshots(log.path), 2,
      'a NEW AgentLoop for the next user message must continue from here, not restart at 0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
