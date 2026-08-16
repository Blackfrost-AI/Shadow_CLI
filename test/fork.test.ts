import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../src/agent/context.js';
import { SessionLog } from '../src/state/session.js';
import { forkSession } from '../src/state/fork.js';
import { saveCheckpoint, listCheckpointsForTurn, restoreCheckpoint } from '../src/state/checkpoints.js';

const opts = { contextBudget: 10_000, triggerRatio: 0.75, keepLastTurns: 4 };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-fork-'));
}

// Keep session logs inside the tmp workspace regardless of the caller's environment.
const prevSessionDir = process.env.SHADOW_SESSION_DIR;
delete process.env.SHADOW_SESSION_DIR;

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('forkSession copies the transcript into a NEW session id and leaves the source untouched', () => {
  const root = tmp();
  try {
    const source = SessionLog.open(root);
    const sourceId = SessionLog.sessionIdFromPath(source.path);
    source.record({ kind: 'user', task: 'hello' });
    source.record({ kind: 'assistant', text: 'hi there' });
    const sourceBefore = readFileSync(source.path, 'utf8');

    const { log, path, forkId } = forkSession(source, root);

    assert.notEqual(forkId, sourceId, 'the fork gets its own session id');
    assert.notEqual(path, source.path, 'the fork lands in a distinct file');
    assert.ok(existsSync(path), 'the forked transcript file exists');

    // The fork carries the source's records PLUS a forked_from marker appended only to the fork.
    const forkLines = readLines(path);
    assert.ok(forkLines.some((l) => l.kind === 'user' && l.task === 'hello'), 'source user record copied');
    assert.ok(forkLines.some((l) => l.kind === 'assistant'), 'source assistant record copied');
    const marker = forkLines.find((l) => l.kind === 'forked_from');
    assert.ok(marker, 'fork records a forked_from lineage marker');
    assert.equal(marker!.sessionId, sourceId, 'the marker names the source session');

    // The source file is byte-identical: no marker, no rewrite.
    assert.equal(readFileSync(source.path, 'utf8'), sourceBefore, 'source transcript is untouched');
    assert.ok(
      !readLines(source.path).some((l) => l.kind === 'forked_from'),
      'no forked_from marker leaks into the source',
    );

    // The returned handle is a live log bound to the copy.
    assert.equal(log.path, path, 'the returned log is bound to the fork path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('appends after a fork go to the FORK, never back to the source', () => {
  const root = tmp();
  try {
    const source = SessionLog.open(root);
    source.record({ kind: 'user', task: 'seed' });
    const { log } = forkSession(source, root);
    const sourceSize = readFileSync(source.path, 'utf8').length;

    log.record({ kind: 'user', task: 'post-fork work' });

    const forkLines = readLines(log.path);
    assert.ok(forkLines.some((l) => l.kind === 'user' && l.task === 'post-fork work'), 'new record lands in the fork');
    assert.equal(readFileSync(source.path, 'utf8').length, sourceSize, 'source size unchanged after fork append');
    assert.ok(
      !readLines(source.path).some((l) => l.task === 'post-fork work'),
      'post-fork record never appears in the source',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the fork inherits the source context snapshots so /rewind still works after a fork', () => {
  const root = tmp();
  try {
    const source = SessionLog.open(root);
    const ctx0 = new Context(opts);
    ctx0.pinTask({ role: 'user', content: [{ type: 'text', text: 't0' }] });
    source.recordSnapshot(ctx0, 0);
    const ctx1 = new Context(opts);
    ctx1.pinTask({ role: 'user', content: [{ type: 'text', text: 't1' }] });
    ctx1.append({ role: 'assistant', content: [{ type: 'text', text: 'a1' }] });
    source.recordSnapshot(ctx1, 1);

    const { log } = forkSession(source, root);

    assert.equal(
      SessionLog.countSnapshots(log.path),
      SessionLog.countSnapshots(source.path),
      'the fork carries over every source snapshot',
    );
    assert.equal(SessionLog.countSnapshots(log.path), 2, 'both snapshots are present in the fork');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('forking a lazy (not-yet-written) source produces an empty fork that still records lineage', () => {
  const root = tmp();
  try {
    // open() now CLAIMS its path eagerly (O_EXCL, F3) so two same-millisecond sessions can never
    // silently share one file — so the source exists immediately, just with no records yet.
    const source = SessionLog.open(root); // no records → claimed but empty
    assert.ok(existsSync(source.path), 'precondition: the source is claimed eagerly…');
    assert.equal(readFileSync(source.path, 'utf8'), '', '…but holds no records yet');

    const { log, path, sourceId } = forkSession(source, root);

    assert.ok(existsSync(path), 'the fork file is materialized');
    const lines = readLines(path);
    assert.equal(lines.length, 1, 'the fork holds only the lineage marker');
    assert.equal(lines[0]!.kind, 'forked_from');
    assert.equal(lines[0]!.sessionId, sourceId);
    // And it is writable from here.
    log.record({ kind: 'user', task: 'first' });
    assert.ok(readLines(log.path).some((l) => l.task === 'first'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two rapid forks of the same source get distinct paths (no overwrite on stamp collision)', () => {
  const root = tmp();
  try {
    const source = SessionLog.open(root);
    source.record({ kind: 'user', task: 'x' });

    const f1 = forkSession(source, root);
    const f2 = forkSession(source, root);

    assert.notEqual(f1.path, f2.path, 'collision on the same millisecond stamp is suffixed, not clobbered');
    assert.ok(existsSync(f1.path) && existsSync(f2.path), 'both forks exist');
    assert.notEqual(f1.forkId, f2.forkId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pre-fork workspace checkpoints are carried under the fork id with self-contained paths', () => {
  const root = tmp();
  try {
    const source = SessionLog.open(root);
    const sourceId = SessionLog.sessionIdFromPath(source.path);
    source.record({ kind: 'user', task: 'edit a file' });
    saveCheckpoint(root, sourceId, 0, 'src/a.txt', 'original-content');

    const { forkId } = forkSession(source, root);

    // The fork now owns a checkpoint tree for turn 0.
    const forkTurnDir = join(root, '.shadow', 'checkpoints', forkId, '0');
    assert.ok(existsSync(forkTurnDir), 'the fork has its own checkpoint turn dir');

    const entries = listCheckpointsForTurn(root, forkId, 0);
    assert.equal(entries.length, 1, 'the fork lists the carried checkpoint');
    assert.equal(entries[0]!.relPath, 'src/a.txt');
    // The index was re-pointed at the FORK's own .bak, so lineage does not depend on the source.
    assert.ok(
      entries[0]!.absPath.startsWith(forkTurnDir),
      `fork index re-pointed into the fork dir, got ${entries[0]!.absPath}`,
    );
    assert.equal(restoreCheckpoint(entries[0]!.absPath), 'original-content', 'fork checkpoint restores the pre-fork bytes');

    // The source tree is intact and still points at the source.
    const srcEntries = listCheckpointsForTurn(root, sourceId, 0);
    assert.equal(srcEntries.length, 1);
    assert.ok(srcEntries[0]!.absPath.startsWith(join(root, '.shadow', 'checkpoints', sourceId)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('forking twice does not clobber the first fork\'s checkpoint tree', () => {
  const root = tmp();
  try {
    const source = SessionLog.open(root);
    const sourceId = SessionLog.sessionIdFromPath(source.path);
    saveCheckpoint(root, sourceId, 0, 'f.txt', 'v0');

    const f1 = forkSession(source, root);
    const f2 = forkSession(source, root);

    const dirs1 = readdirSync(join(root, '.shadow', 'checkpoints', f1.forkId));
    const dirs2 = readdirSync(join(root, '.shadow', 'checkpoints', f2.forkId));
    assert.deepEqual(dirs1, ['0']);
    assert.deepEqual(dirs2, ['0']);
    assert.equal(restoreCheckpoint(listCheckpointsForTurn(root, f1.forkId, 0)[0]!.absPath), 'v0');
    assert.equal(restoreCheckpoint(listCheckpointsForTurn(root, f2.forkId, 0)[0]!.absPath), 'v0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('forkSession cleans up the partial copy if the source copy fails', () => {
  const root = tmp();
  try {
    const source = SessionLog.open(root);
    source.record({ kind: 'user', task: 'x' });
    // Point the source at an unreadable situation by replacing its file with a DIRECTORY of the
    // same name — copyFileSync then throws EISDIR and the fork must not leave a half-file.
    const realPath = source.path;
    rmSync(realPath, { force: true });
    mkdirSync(realPath); // now source.path is a directory → copy fails

    // copyFileSync reads the source (a directory now) → fails with EISDIR; whatever the exact
    // errno, forkSession must throw AND not leave a stray partial fork transcript behind.
    assert.throws(() => forkSession(source, root));
    const dir = join(root, '.shadow', 'sessions');
    const leftover = readdirSync(dir).filter((f) => f !== realPath.split('/').pop());
    assert.deepEqual(leftover, [], 'no partial fork transcript left behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a torn final line (fork racing a concurrent appender) is dropped from the fork, not carried half-written', () => {
  const root = tmp();
  try {
    const source = SessionLog.open(root);
    source.record({ kind: 'user', task: 'complete line' });
    // Simulate the copy observing the source mid-append: a final record with no newline yet.
    appendFileSync(source.path, '{"kind":"user","task":"tor');
    const { path } = forkSession(source, root);
    // readLines JSON.parse's every line — it would throw if a torn fragment survived the copy.
    const lines = readLines(path);
    assert.ok(lines.some((l) => l.task === 'complete line'), 'complete record carried over');
    assert.ok(lines.some((l) => l.kind === 'forked_from'), 'lineage marker present');
    assert.ok(
      !lines.some((l) => typeof l.task === 'string' && (l.task as string).startsWith('tor')),
      'no torn fragment in the fork',
    );
    assert.ok(readFileSync(path, 'utf8').endsWith('\n'), 'fork ends on a line boundary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (prevSessionDir !== undefined) process.env.SHADOW_SESSION_DIR = prevSessionDir;
