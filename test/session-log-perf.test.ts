import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../src/agent/context.js';
import { SessionLog } from '../src/state/session.js';
import { listResumableSessions, resumeSession } from '../src/state/resume.js';
import { sessionToMarkdown } from '../src/state/chatExport.js';

const opts = { contextBudget: 10_000, triggerRatio: 0.75, keepLastTurns: 4 };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-logperf-'));
}

/** Build a bare `context_snapshot` JSONL line with a controlled ts + turn + data. */
function snapLine(turn: number, ts = '2020-01-01T00:00:00.000Z', extra = ''): string {
  const data = { messages: [], pinnedPrefix: 0, lastActualTokens: 0 };
  // `turn` is a single digit in these fixtures, so lines with different turns share a byte length.
  return JSON.stringify({ ts, kind: 'context_snapshot', data, turn, pad: extra }) + '\n';
}

// ── ITEM 1 (P1B-06): per-token write volume ────────────────────────────────

test('recordEvent drops per-token deltas — a 100-delta turn writes O(1) records', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    log.record({ kind: 'user', task: 'do the thing' });
    // A turn that streamed 100 text + 100 thinking + 100 shell_output deltas...
    for (let i = 0; i < 100; i++) {
      log.recordEvent({ type: 'text', delta: `tok${i} ` });
      log.recordEvent({ type: 'thinking', delta: `r${i} ` });
      log.recordEvent({ type: 'shell_output', callId: 'c1', stream: 'stdout', chunk: `out${i}` });
    }
    // ...commits the streamed text ONCE via the reasoning_done / assistant_done events.
    log.recordEvent({ type: 'reasoning_done', text: 'the full reasoning' });
    log.recordEvent({ type: 'assistant_done', text: 'the full answer' });
    assert.equal(log.lastError, undefined, 'writes succeed');

    const events = SessionLog.load(log.path) as Array<Record<string, unknown>>;
    const bus = events.filter((e) => e.kind === 'event');
    const perToken = bus.filter((e) => e.type === 'text' || e.type === 'thinking' || e.type === 'shell_output');
    assert.equal(perToken.length, 0, 'no per-token delta record lands on disk');
    // O(1) — the two committed records, NOT ~300.
    assert.equal(bus.length, 2, 'only assistant_done + reasoning_done recorded for the turn');
    assert.equal(bus.filter((e) => e.type === 'assistant_done').length, 1);
    assert.equal(bus.filter((e) => e.type === 'reasoning_done').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transcript reconstructs from committed events after deltas are dropped', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    log.record({ kind: 'user', task: 'fix the bug' });
    for (let i = 0; i < 50; i++) log.recordEvent({ type: 'text', delta: `part${i} ` });
    log.recordEvent({ type: 'assistant_done', text: 'I fixed the bug in foo.ts.' });
    log.recordEvent({
      type: 'tool_end',
      call: { name: 'read_file', input: { path: 'foo.ts' } },
      result: { ok: true, summary: '10 lines' },
    });

    const events = SessionLog.load(log.path);
    const md = sessionToMarkdown(events, {
      version: '0', workspaceRoot: root, provider: 'p', model: 'm',
      style: 's', autonomy: 'a', sessionPath: log.path, exportedAt: '2026-01-01T00:00:00.000Z',
    });
    // The transcript is rebuilt from the COMMITTED events, not the streamed deltas.
    assert.match(md, /## User/);
    assert.match(md, /fix the bug/);
    assert.match(md, /I fixed the bug in foo\.ts\./);
    assert.match(md, /## Tool · read_file/);
    assert.match(md, /10 lines/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistent-fd writes are synchronous, ordered, and 0600', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    log.record({ kind: 'user', text: 'a' });
    log.record({ kind: 'event', type: 'assistant_done', text: 'b' });
    log.record({ kind: 'user', text: 'c' });
    // Synchronous: content is on disk immediately after the calls return.
    const events = SessionLog.load(log.path) as Array<Record<string, unknown>>;
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.text as string), ['a', 'b', 'c']);
    assert.equal(statSync(log.path).mode & 0o777, 0o600, 'file forced to 0600');
    assert.equal(log.lastError, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── ITEM 2 (P1B-07): tail-scan snapshot lookup + manifest cache ─────────────

test('backward scan finds the latest snapshot at tail / middle / head / absent', () => {
  const root = tmp();
  try {
    const dir = join(root, '.shadow', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const filler = JSON.stringify({ kind: 'event', type: 'tool_end', x: 'y' }) + '\n';

    // tail: snapshot is the last line
    const pTail = join(dir, 'a.jsonl');
    writeFileSync(pTail, filler + filler + snapLine(3));
    assert.equal((SessionLog.findLatestSnapshotRecord(pTail) as any)?.turn, 3);

    // middle: snapshot sandwiched between fillers
    const pMid = join(dir, 'b.jsonl');
    writeFileSync(pMid, filler + snapLine(2) + filler + filler);
    assert.equal((SessionLog.findLatestSnapshotRecord(pMid) as any)?.turn, 2);

    // head: snapshot is the first line
    const pHead = join(dir, 'c.jsonl');
    writeFileSync(pHead, snapLine(1) + filler + filler);
    assert.equal((SessionLog.findLatestSnapshotRecord(pHead) as any)?.turn, 1);

    // absent: no snapshot at all
    const pNone = join(dir, 'd.jsonl');
    writeFileSync(pNone, filler + filler);
    assert.equal(SessionLog.findLatestSnapshotRecord(pNone), null);
    assert.equal(SessionLog.findLatestSnapshot(pNone), null);

    // latest wins: two snapshots, the last (turn 5) is returned
    const pMulti = join(dir, 'e.jsonl');
    writeFileSync(pMulti, snapLine(0) + filler + snapLine(5) + filler);
    assert.equal((SessionLog.findLatestSnapshotRecord(pMulti) as any)?.turn, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findLatestSnapshot on a large log scans only the tail chunk, not the whole file', () => {
  const root = tmp();
  try {
    const CHUNK = 64 * 1024;
    const dir = join(root, '.shadow', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const path = join(dir, 'big.jsonl');
    // ~460KB of non-snapshot filler (7+ chunks), then the snapshot near the tail, then a little more.
    const filler = JSON.stringify({ kind: 'event', type: 'text_line', pad: 'x'.repeat(200) }) + '\n';
    let body = '';
    for (let i = 0; i < 2000; i++) body += filler; // ≈ 460KB
    body += snapLine(9);
    body += filler + filler;
    writeFileSync(path, body);
    const fileSize = statSync(path).size;
    assert.ok(fileSize > 7 * CHUNK, 'fixture spans many chunks');

    // Cold cache (raw file, never written via a SessionLog instance) — snapshotInfo forces the
    // backward tail scan. The scan reads chunks from EOF and STOPS at the first match, so a
    // snapshot located within the last chunk means exactly ONE chunk was read — not the whole file.
    const info = SessionLog.snapshotInfo(path);
    assert.equal(info.hasSnapshot, true);
    assert.equal(info.turn, 9);
    assert.ok(info.offset !== undefined, 'offset recorded');
    assert.ok(
      info.offset! >= fileSize - CHUNK,
      `snapshot at ${info.offset} is within the last chunk (fileSize ${fileSize}) — one-chunk scan`,
    );

    // And the fast path agrees with a full parse of the same file.
    const record = SessionLog.findLatestSnapshotRecord(path) as any;
    assert.equal(record.turn, 9);
    const all = SessionLog.load(path) as Array<Record<string, unknown>>;
    const lastSnap = [...all].reverse().find((e) => e.kind === 'context_snapshot');
    assert.deepEqual(record.data, (lastSnap as any).data);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest invalidates on mtime change (size held constant)', () => {
  const root = tmp();
  try {
    const dir = join(root, '.shadow', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const path = join(dir, 'm.jsonl');

    writeFileSync(path, snapLine(0));
    const t1 = new Date(1_000_000_000_000);
    utimesSync(path, t1, t1);
    assert.equal(SessionLog.countSnapshots(path), 1, 'turn 0 -> count 1');
    assert.equal((SessionLog.findLatestSnapshotRecord(path) as any)?.turn, 0);

    // Overwrite with a different snapshot of the SAME byte length, then bump mtime.
    const before = statSync(path).size;
    writeFileSync(path, snapLine(7));
    assert.equal(statSync(path).size, before, 'same size — only mtime distinguishes the change');
    const t2 = new Date(2_000_000_000_000);
    utimesSync(path, t2, t2);

    assert.equal(SessionLog.countSnapshots(path), 8, 'recomputed after mtime change -> count 8');
    assert.equal((SessionLog.findLatestSnapshotRecord(path) as any)?.turn, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('countSnapshots + listResumableSessions match multi-snapshot logs', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const ctx = new Context(opts);
    ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    log.recordSnapshot(ctx, 0);
    ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'a1' }] });
    log.recordSnapshot(ctx, 1);
    log.recordSnapshot(ctx, 2);

    assert.equal(SessionLog.countSnapshots(log.path), 3, 'max turn 2 + 1');
    const sessions = listResumableSessions(root);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.id, SessionLog.sessionIdFromPath(log.path));
    // ts comes from the latest snapshot record
    assert.equal(typeof sessions[0]!.ts, 'string');

    const { context, meta } = resumeSession(log.path, opts);
    assert.equal(meta.turn, 2);
    assert.equal(context.messages().length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('countSnapshots stays warm after subsequent appends (write path updates manifest)', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const ctx = new Context(opts);
    ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'go' }] });
    log.recordSnapshot(ctx, 0);
    assert.equal(SessionLog.countSnapshots(log.path), 1);
    // Tool/assistant records land BETWEEN snapshots (growing the file) and must not corrupt the
    // count — the value tracks the latest snapshot's turn, not the raw record count.
    log.record({ kind: 'event', type: 'assistant_done', text: 'x' });
    log.record({ kind: 'event', type: 'tool_end', call: { name: 'read_file' }, result: { ok: true } });
    assert.equal(SessionLog.countSnapshots(log.path), 1);
    log.recordSnapshot(ctx, 1);
    log.record({ kind: 'event', type: 'assistant_done', text: 'y' });
    assert.equal(SessionLog.countSnapshots(log.path), 2, 'latest snapshot turn 1 -> count 2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
