import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  copyFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../src/agent/context.js';
import { SessionLog } from '../src/state/session.js';
import { resumeSession } from '../src/state/resume.js';
import { rewindToTurn, listRewindableTurns } from '../src/state/rewind.js';

// P2-13: chained delta snapshots. Before this change, two FULL context snapshots per turn made
// the log O(T²) — a measured 99% snapshot bytes and a 100× transcript ratio at 30 turns. These
// tests pin the new contract: first snapshot full, later ones deltas chained by baseOffset;
// byte volume ~linear in the transcript; every reader (resume/rewind/turn-list) reconstructs
// the exact live state; lineage divergence re-bases as a full; corruption falls back one step.

const opts = { contextBudget: 1_000_000, triggerRatio: 0.9, keepLastTurns: 12 };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-snapdelta-'));
}

/** Run a T-turn session the way loop.ts does: assistant+tool_use, PRE-tool snapshot, tool_result,
 *  transcript events persisted as the bus→recordEvent subscriber persists them (FULL tool result
 *  bodies — see index.ts's `bus.on((e) => sessionLog.recordEvent(e))`), POST-tool snapshot. */
function runSession(log: SessionLog, T: number, R = 2000, A = 400): { ctx: Context; states: string[][] } {
  const ctx = new Context(opts);
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'Fix the failing build and tests.' }] });
  log.record({ kind: 'user', task: 'Fix the failing build and tests.' });
  const states: string[][] = [];
  for (let turn = 0; turn < T; turn++) {
    const aText = `Turn ${turn}: here is what I did and found. `.repeat(Math.ceil(A / 40));
    const callId = `call_${turn}`;
    ctx.append({
      role: 'assistant',
      content: [
        { type: 'text', text: aText },
        { type: 'tool_use', id: callId, name: 'run_shell', input: { command: `npm test ${turn}` } },
      ],
    });
    log.record({ kind: 'event', type: 'assistant_done', text: aText });
    log.recordSnapshot(ctx, turn); // pre-tool (loop.ts:575 equivalent)
    states.push(ctx.messages().map((m) => JSON.stringify(m)));
    const resultBody = `output of turn ${turn}\n`.padEnd(R, 'x');
    ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: callId, ok: true, content: resultBody }] });
    log.record({
      kind: 'event',
      type: 'tool_end',
      call: { name: 'run_shell' },
      result: { ok: true, content: [{ type: 'text', text: resultBody }] },
    });
    log.recordSnapshot(ctx, turn); // post-tool supersedes (loop.ts:804 equivalent)
    states.push(ctx.messages().map((m) => JSON.stringify(m)));
  }
  return { ctx, states };
}

/** Every `context_snapshot` line with its byte offset + byte length, in file order (raw — no
 *  reconstruction). */
function rawSnapshotLines(path: string): Array<{ rec: Record<string, any>; offset: number; len: number }> {
  const buf = readFileSync(path);
  const out: Array<{ rec: Record<string, any>; offset: number; len: number }> = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0x0a) continue;
    const seg = buf.subarray(start, i);
    const off = start;
    start = i + 1;
    if (!seg.length) continue;
    try {
      const rec = JSON.parse(seg.toString('utf8'));
      if (rec && rec.kind === 'context_snapshot') out.push({ rec, offset: off, len: seg.length + 1 });
    } catch {
      /* non-JSON or torn line */
    }
  }
  return out;
}

test('first snapshot is full, later snapshots are deltas chained onto the previous line', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    runSession(log, 4);
    const snaps = rawSnapshotLines(log.path);
    assert.equal(snaps.length, 8, '2 snapshots per turn');
    assert.equal(snaps[0]!.rec.format, 'full', 'the first snapshot re-bases as a full');
    assert.ok(Array.isArray(snaps[0]!.rec.data.messages), 'full carries the whole array');
    for (let i = 1; i < snaps.length; i++) {
      const s = snaps[i]!;
      assert.equal(s.rec.format, 'delta', `snapshot ${i} is a delta`);
      assert.equal(s.rec.baseOffset, snaps[i - 1]!.offset, `delta ${i} chains onto the previous snapshot line`);
      assert.ok(Array.isArray(s.rec.data.appended), 'delta carries only appended messages');
      assert.ok(!('messages' in s.rec.data), 'delta does NOT re-serialize the whole array');
      assert.equal(typeof s.rec.messageCount, 'number');
    }
    // Snapshot 0 is the PRE-tool full and already carries the turn-0 assistant message, so the
    // first delta appends the turn-0 tool_result (a user message) and the next appends the
    // turn-1 assistant message.
    assert.equal(snaps[1]!.rec.data.appended.length, 1);
    assert.equal(snaps[1]!.rec.data.appended[0].role, 'user');
    assert.equal(snaps[2]!.rec.data.appended.length, 1);
    assert.equal(snaps[2]!.rec.data.appended[0].role, 'assistant');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every snapshot reconstructs byte-identical to the live context at write time', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const { states } = runSession(log, 6);
    const recs = SessionLog.loadSnapshotRecords(log.path);
    assert.equal(recs.length, states.length, 'one reconstructed record per snapshot written');
    recs.forEach(({ record }, i) => {
      const data = record.data as { messages: unknown[] };
      assert.deepEqual(
        data.messages.map((m) => JSON.stringify(m)),
        states[i],
        `snapshot ${i} reconstructs the exact state the loop saw`,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a 30-turn log stays within ~3x the transcript — and the ratio does not grow with length', () => {
  const measure = (T: number) => {
    const root = tmp();
    try {
      const log = SessionLog.open(root);
      runSession(log, T);
      const total = statSync(log.path).size;
      const snapBytes = rawSnapshotLines(log.path).reduce((a, s) => a + s.len, 0);
      return { ratio: total / (total - snapBytes), share: snapBytes / total };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const m30 = measure(30);
  // Acceptance (FRONTIER P2-13): 30-turn log ≤ ~3x the transcript. Pre-fix measurement: 100.17x.
  assert.ok(m30.ratio <= 3.0, `30-turn ratio ${m30.ratio.toFixed(2)}x within the ~3x budget`);
  assert.ok(m30.share < 0.75, `snapshot share ${(m30.share * 100).toFixed(0)}% — no 84%+ pathology (was 99%)`);
  // Linear: a 4x longer session holds the same ratio (pre-fix it grew quadratically).
  const m120 = measure(120);
  assert.ok(
    Math.abs(m120.ratio - m30.ratio) < 0.35,
    `ratio stable across length: 30 turns ${m30.ratio.toFixed(2)}x vs 120 turns ${m120.ratio.toFixed(2)}x`,
  );
});

test('resume hydrates the latest state through the delta chain', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const { ctx } = runSession(log, 5);
    const { context, meta } = resumeSession(log.path, opts);
    assert.deepEqual(
      context.messages().map((m) => JSON.stringify(m)),
      ctx.messages().map((m) => JSON.stringify(m)),
      'resumed context equals the live context at the last snapshot',
    );
    assert.equal(meta.turn, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a torn latest delta falls back to the previous snapshot (one-snapshot blast radius)', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const { states } = runSession(log, 4);
    SessionLog.snapshotInfo(log.path); // warm the manifest so the fast path is exercised too
    const snaps = rawSnapshotLines(log.path);
    const last = snaps[snaps.length - 1]!;
    // Corrupt the last delta line's STRUCTURE (torn-write simulation) so it no longer parses:
    // overwrite the opening `{"ts":` — clobbering bytes inside a quoted string value would
    // still be valid JSON and (correctly) NOT count as torn.
    const fd = openSync(log.path, 'r+');
    try {
      writeSync(fd, Buffer.from('XXXXXXXXXX'), 0, 10, last.offset + 2);
    } finally {
      closeSync(fd);
    }
    const rec = SessionLog.findLatestSnapshotRecord(log.path)!;
    const data = rec.data as { messages: unknown[] };
    assert.deepEqual(
      data.messages.map((m) => JSON.stringify(m)),
      states[states.length - 2],
      'falls back to the snapshot immediately before the torn one — nothing more is lost',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rewind + turn picker see the same turns on a delta log as the live session', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const { states } = runSession(log, 3);
    // /rewind to turn 1 hydrates the LAST turn-1 snapshot (post-tool), via the delta chain.
    const res = rewindToTurn(log.path, 1, root, { ...opts, scope: 'chat' });
    assert.equal(res.turn, 1);
    assert.deepEqual(
      res.context!.messages().map((m) => JSON.stringify(m)),
      states[3],
      'rewinding to turn 1 restores the exact turn-1 post-tool state',
    );
    // The picker lists every snapshot turn, newest first, with the prompt that produced it.
    const turns = listRewindableTurns(log.path);
    assert.deepEqual([...new Set(turns.map((t) => t.turn))], [2, 1, 0], 'turns 2,1,0 newest-first');
    for (const t of turns) assert.ok(t.prompt.includes('Fix the failing build'), 'prompt recovered');
    // The TUI's /rewind handler then appends the durability snapshot (tui.tsx:3678) — the rewound
    // array is SHORTER than the last snapshot's, so it must re-base as a full, and the picker must
    // still resolve every turn afterwards (newest append of a turn wins).
    log.recordSnapshot(res.context!, res.turn);
    assert.equal(rawSnapshotLines(log.path).at(-1)!.rec.format, 'full', 'rewind durability snapshot re-bases');
    const after = listRewindableTurns(log.path);
    // Newest-first by file order (the legacy reverse() semantics): the turn-1 durability
    // snapshot is now the NEWEST line, so turn 1 leads; every turn is still listed exactly once.
    assert.deepEqual([...new Set(after.map((t) => t.turn))], [1, 2, 0], 'all turns still listed, newest-first');
    const rewoundAgain = rewindToTurn(log.path, 1, root, { ...opts, scope: 'chat' });
    assert.deepEqual(
      rewoundAgain.context!.messages().map((m) => JSON.stringify(m)),
      states[3],
      'latest-append-wins still resolves turn 1 after the durability full',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('incremental turn-list cache resolves newly appended deltas, and re-parses on a base miss', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const { ctx } = runSession(log, 2);
    const first = listRewindableTurns(log.path);
    assert.equal(first.length, 4, 'both turns × pre/post snapshots');
    // Continue the SAME lineage — the refreshed list resolves new deltas against the cached
    // last snapshot without re-reading earlier bytes.
    ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'one more' }] });
    log.recordSnapshot(ctx, 2);
    ctx.append({ role: 'user', content: [{ type: 'text', text: 'and a reply' }] });
    log.recordSnapshot(ctx, 3);
    const second = listRewindableTurns(log.path);
    assert.equal(second.length, 6, 'the two appended snapshots are listed');
    assert.deepEqual([...new Set(second.map((t) => t.turn))], [3, 2, 1, 0], 'newest-first');

    // Base-miss reparse: hand-append a delta whose baseOffset points at the FIRST full rather
    // than the immediately previous line (as a foreign writer could do). The warm pass cannot
    // resolve it from the single cached base → one-shot reparse from 0 picks it up.
    const snaps = rawSnapshotLines(log.path);
    const fullOffset = snaps[0]!.offset;
    const extra =
      JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'context_snapshot',
        format: 'delta',
        baseOffset: fullOffset,
        messageCount: 2,
        data: {
          appended: [{ role: 'assistant', content: [{ type: 'text', text: 'foreign append' }] }],
          pinnedPrefix: 0,
          lastActualTokens: 0,
        },
        turn: 9,
      }) + '\n';
    appendFileSync(log.path, extra);
    const third = listRewindableTurns(log.path);
    assert.ok(third.some((t) => t.turn === 9), 'the foreign delta resolves after the one-shot reparse');
    assert.equal(third.length, second.length + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('in-place mutation and truncation re-base the next snapshot as a full', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const { ctx } = runSession(log, 2);

    // In-place mutation (what microcompact does to stale tool_result bodies): same length,
    // different digest → full.
    const mutated = ctx.exportState();
    const msgs = mutated.messages.map((m) => ({ ...m }));
    const anyMsg = msgs.find((m) => m.role === 'assistant') as any;
    anyMsg.content = [{ type: 'text', text: 'cleared by microcompact' }];
    const ctx2 = new Context(opts);
    ctx2.loadState({ ...mutated, messages: msgs });
    log.recordSnapshot(ctx2, 2);
    let snaps = rawSnapshotLines(log.path);
    assert.equal(snaps.at(-1)!.rec.format, 'full', 'in-place mutation breaks the prefix digest → full');

    // Truncation (what /rewind does): fewer messages → full.
    const truncated = ctx.exportState();
    const ctx3 = new Context(opts);
    ctx3.loadState({ ...truncated, messages: truncated.messages.slice(0, 2) });
    log.recordSnapshot(ctx3, 1);
    snaps = rawSnapshotLines(log.path);
    assert.equal(snaps.at(-1)!.rec.format, 'full', 'a shorter array cannot chain → full');

    // A clean append after the re-base chains again.
    ctx3.append({ role: 'assistant', content: [{ type: 'text', text: 'next' }] });
    log.recordSnapshot(ctx3, 2);
    snaps = rawSnapshotLines(log.path);
    assert.equal(snaps.at(-1)!.rec.format, 'delta', 'clean append after a full chains again');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the periodic checkpoint fires for many small messages and stays reconstructable', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    // 300 tiny turns = 600 snapshots > FULL_EVERY_N_SNAPSHOTS(512) with delta bytes far below
    // the byte threshold → the COUNT rule must force at least one periodic full.
    const { ctx } = runSession(log, 300, 12, 12);
    const snaps = rawSnapshotLines(log.path);
    const fulls = snaps.filter((s) => s.rec.format === 'full').length;
    assert.ok(fulls >= 2, `periodic full fired (${fulls} fulls incl. the first)`);
    const rec = SessionLog.findLatestSnapshotRecord(log.path)!;
    assert.deepEqual(
      (rec.data as { messages: unknown[] }).messages.map((m) => JSON.stringify(m)),
      ctx.messages().map((m) => JSON.stringify(m)),
      'the latest snapshot still reconstructs across the checkpoint boundary',
    );
    const turns = listRewindableTurns(log.path);
    assert.equal(new Set(turns.map((t) => t.turn)).size, 300, 'every turn listed across checkpoints');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy full-only logs (no format field) keep working everywhere', () => {
  const root = tmp();
  try {
    const dir = SessionLog.sessionsDir(root);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'legacy.jsonl');
    const data0 = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello legacy' }] }], pinnedPrefix: 0, lastActualTokens: 0 };
    const data1 = { messages: [...data0.messages, { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] }], pinnedPrefix: 0, lastActualTokens: 0 };
    writeFileSync(
      path,
      JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', kind: 'context_snapshot', data: data0, turn: 0 }) +
        '\n' +
        JSON.stringify({ ts: '2020-01-01T00:00:01.000Z', kind: 'context_snapshot', data: data1, turn: 1 }) +
        '\n',
    );
    const rec = SessionLog.findLatestSnapshotRecord(path)! as any;
    assert.equal(rec.turn, 1);
    assert.deepEqual(rec.data, data1, 'legacy records pass through un-rewritten');
    assert.equal(SessionLog.loadSnapshotRecords(path).length, 2);
    const turns = listRewindableTurns(path);
    assert.deepEqual(turns.map((t) => t.turn), [1, 0]);
    assert.ok(turns[0]!.prompt.includes('hello legacy'));
    const { context } = resumeSession(path, opts);
    assert.equal(context.messages().length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fractional baseOffset is a broken chain link, never a crash (F1)', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const { states } = runSession(log, 1);
    const snaps = rawSnapshotLines(log.path);
    // Append a delta whose baseOffset is FRACTIONAL — pre-fix the chain walk handed it to
    // readSync at a mid-character position (RangeError/TypeError territory); post-fix it is
    // simply a corrupt link: skipped, and readers fall back one step.
    appendFileSync(
      log.path,
      JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'context_snapshot',
        format: 'delta',
        baseOffset: snaps[0]!.offset + 0.5,
        messageCount: 99,
        data: { appended: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], pinnedPrefix: 0, lastActualTokens: 0 },
        turn: 9,
      }) + '\n',
    );
    const rec = SessionLog.findLatestSnapshotRecord(log.path)!;
    assert.deepEqual(
      (rec.data as { messages: unknown[] }).messages.map((m) => JSON.stringify(m)),
      states[states.length - 1],
      'falls back to the last reconstructable snapshot — no throw',
    );
    assert.ok(listRewindableTurns(log.path).length >= 2, 'the turn list survives the corrupt link too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a messageCount lie refuses assembly instead of silently losing turns (F4)', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    runSession(log, 1);
    const snaps = rawSnapshotLines(log.path);
    const base = snaps[snaps.length - 1]!; // the last good snapshot line
    // Claim 99 messages while base+appended is 4 → assembly must REFUSE, not guess.
    appendFileSync(
      log.path,
      JSON.stringify({
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'context_snapshot',
        format: 'delta',
        baseOffset: base.offset,
        messageCount: 99,
        data: { appended: [{ role: 'user', content: [{ type: 'text', text: 'lying delta' }] }], pinnedPrefix: 0, lastActualTokens: 0 },
        turn: 7,
      }) + '\n',
    );
    const rec = SessionLog.findLatestSnapshotRecord(log.path)!;
    assert.equal(rec.turn, 0, 'the lying delta is never served — readers fall back to turn 0');
    const recs = SessionLog.loadSnapshotRecords(log.path);
    assert.ok(!recs.some((r) => (r.record as { turn?: number }).turn === 7), 'and never assembled in the forward pass either');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('interleaved lineages (sub-agents sharing one log) chain per-context, never cross (C3)', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const ctxA = new Context(opts);
    ctxA.pinTask({ role: 'user', content: [{ type: 'text', text: 'parent task' }] });
    const ctxB = new Context(opts);
    ctxB.pinTask({ role: 'user', content: [{ type: 'text', text: 'sub-agent task' }] });

    log.recordSnapshot(ctxA, 0); // lineage A: full
    log.recordSnapshot(ctxB, 0); // lineage B: must re-base as ITS OWN full, not delta onto A
    ctxA.append({ role: 'assistant', content: [{ type: 'text', text: 'A step 1' }] });
    log.recordSnapshot(ctxA, 1); // A delta — chains onto A's own line, skipping over B's
    ctxB.append({ role: 'assistant', content: [{ type: 'text', text: 'B step 1' }] });
    log.recordSnapshot(ctxB, 1); // B delta — chains onto B's own line

    const snaps = rawSnapshotLines(log.path);
    assert.equal(snaps.length, 4);
    assert.equal(snaps[0]!.rec.format, 'full');
    assert.equal(snaps[1]!.rec.format, 'full', 'a second lineage re-bases as a full');
    assert.equal(snaps[2]!.rec.format, 'delta');
    assert.equal(snaps[2]!.rec.baseOffset, snaps[0]!.offset, 'A chains onto A');
    assert.equal(snaps[3]!.rec.format, 'delta');
    assert.equal(snaps[3]!.rec.baseOffset, snaps[1]!.offset, 'B chains onto B');
    // Both reconstruct to exactly their own live states (no cross-lineage bleed).
    const recs = SessionLog.loadSnapshotRecords(log.path);
    assert.equal(recs.length, 4);
    assert.deepEqual(
      (recs[2]!.record.data as { messages: unknown[] }).messages.map((m) => JSON.stringify(m)),
      ctxA.messages().map((m) => JSON.stringify(m)),
    );
    assert.deepEqual(
      (recs[3]!.record.data as { messages: unknown[] }).messages.map((m) => JSON.stringify(m)),
      ctxB.messages().map((m) => JSON.stringify(m)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('same-millisecond opens never share a file — O_EXCL claim with suffixes (F3)', () => {
  const root = tmp();
  try {
    // 25 opens in a tight loop straddle few enough milliseconds that at least two normally
    // compute the same ISO stamp — pre-fix both would have silently adopted ONE file.
    const logs: SessionLog[] = [];
    for (let i = 0; i < 25; i++) logs.push(SessionLog.open(root));
    const paths = logs.map((l) => l.path);
    assert.equal(new Set(paths).size, paths.length, 'every SessionLog owns a unique file');
    for (const l of logs) assert.ok(statSync(l.path).isFile(), 'each claimed path exists');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed snapshot message shapes never crash the turn list (F5)', () => {
  const root = tmp();
  try {
    const dir = SessionLog.sessionsDir(root);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'malformed.jsonl');
    // A hand-edited/torn log can carry non-object rows and non-array content — the /rewind
    // menu must skip the garbage rows, not throw a TypeError mid-refresh.
    writeFileSync(
      path,
      JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'context_snapshot',
        turn: 0,
        data: {
          messages: [
            'garbage string row',
            42,
            null,
            { role: 'user', content: 'not-an-array' },
            { role: 'user', content: [{ type: 'text' }, { bogus: true }, { type: 'text', text: 'real prompt' }] },
          ],
          pinnedPrefix: 0,
          lastActualTokens: 0,
        },
      }) + '\n',
    );
    const turns = listRewindableTurns(path);
    assert.equal(turns.length, 1, 'the snapshot still yields its turn');
    assert.equal(turns[0]!.prompt, 'real prompt', 'the first well-formed user text wins, garbage skipped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('openExisting (fork adoption) re-bases its first snapshot as a full', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const { ctx } = runSession(log, 2);
    // /fork byte-copies the log, then adopts the COPY — the adopter has no in-memory digest
    // state, so its first snapshot must be a full (a delta pointing into unknown bytes would
    // be unreconstructable).
    const forkPath = join(SessionLog.sessionsDir(root), 'forked.jsonl');
    copyFileSync(log.path, forkPath);
    const adopted = SessionLog.openExisting(forkPath);
    ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'after fork' }] });
    adopted.recordSnapshot(ctx, 2);
    const snaps = rawSnapshotLines(forkPath);
    assert.equal(snaps.at(-1)!.rec.format, 'full', 'the first snapshot after adoption re-bases');
    const rec = SessionLog.findLatestSnapshotRecord(forkPath)!;
    assert.deepEqual(
      (rec.data as { messages: unknown[] }).messages.map((m) => JSON.stringify(m)),
      ctx.messages().map((m) => JSON.stringify(m)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
