import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLog } from '../src/state/session.js';
import { rewindToTurn, listRewindableTurns } from '../src/state/rewind.js';
import { saveCheckpoint } from '../src/state/checkpoints.js';
import type { ContextSnapshotData } from '../src/state/snapshot.js';
import type { Message } from '../src/provider/provider.js';

function ws(): string {
  const d = mkdtempSync(join(tmpdir(), 'rewind-ux-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  return d;
}

function snap(turn: number, prompt: string, messages?: Message[]) {
  const msgs: Message[] =
    messages ?? [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
      { role: 'assistant', content: [{ type: 'text', text: `answer to turn ${turn}` }] },
    ];
  return {
    kind: 'context_snapshot',
    turn,
    data: { messages: msgs, pinnedPrefix: 1, lastActualTokens: 0 } satisfies ContextSnapshotData,
  };
}

const HYDRATE = { contextBudget: 1_000, triggerRatio: 0.9, keepLastTurns: 4 };

// ─── listRewindableTurns — the picker's data source (F08-07) ──────────────────────────────────

test('listRewindableTurns lists turns newest-first with the prompt that produced each', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    log.record(snap(0, 'first question'));
    log.record(snap(1, 'second question'));
    log.record(snap(2, 'third question'));
    const turns = listRewindableTurns(log.path);
    assert.deepEqual(turns.map((t) => t.turn), [2, 1, 0], 'newest first');
    assert.deepEqual(
      turns.map((t) => t.prompt),
      ['third question', 'second question', 'first question'],
    );
    assert.deepEqual(turns.map((t) => t.label), ['third question', 'second question', 'first question']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the prefill prompt strips @-file inlining and hook-context suffixes (what the user TYPED)', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    log.record(snap(0, 'look at this\n\nReferenced files:\n--- @a.ts ---\nconst x = 1;'));
    log.record(snap(1, 'now this\n\nAdditional context (user_prompt_submit hook):\nbe nice'));
    const turns = listRewindableTurns(log.path);
    assert.equal(turns[1]!.prompt, 'look at this', '@-file blocks are not re-submitted');
    assert.equal(turns[0]!.prompt, 'now this', 'hook context is not re-submitted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prompt extraction walks back past tool_result-only user turns', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    log.record(
      snap(0, '', [
        { role: 'user', content: [{ type: 'text', text: 'the real prompt' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', ok: true, content: 'body' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ]),
    );
    assert.equal(listRewindableTurns(log.path)[0]!.prompt, 'the real prompt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a long prompt gets a one-line truncated label but keeps the full prompt for prefill', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const long = 'word '.repeat(40).trim(); // 199 chars on one line
    log.record(snap(0, long));
    const t = listRewindableTurns(log.path)[0]!;
    assert.equal(t.prompt, long, 'prefill keeps the full prompt');
    assert.equal(t.label.length, 73, 'label truncates to 72 chars + ellipsis');
    assert.ok(t.label.endsWith('…'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listRewindableTurns refreshes incrementally as snapshots append (no dupes, no loss)', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    log.record(snap(0, 'q0'));
    assert.equal(listRewindableTurns(log.path).length, 1);
    log.record(snap(1, 'q1'));
    const turns = listRewindableTurns(log.path);
    assert.deepEqual(turns.map((t) => t.turn), [1, 0]);
    assert.deepEqual(turns.map((t) => t.prompt), ['q1', 'q0']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listRewindableTurns returns [] for a missing log and never throws', () => {
  assert.deepEqual(listRewindableTurns(join(tmpdir(), 'definitely-not-a-session-xyz.jsonl')), []);
});

// ─── rewindToTurn scope flags (F08-07) ─────────────────────────────────────────────────────────

test('scope "chat" rewinds the conversation and leaves workspace files alone', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const sid = SessionLog.sessionIdFromPath(log.path);
    log.record(snap(0, 'q0'));
    log.record(snap(1, 'q1'));
    saveCheckpoint(root, sid, 0, 'src/a.ts', 'ORIGINAL');
    writeFileSync(join(root, 'src/a.ts'), 'MODIFIED BY TURN 1');

    const res = rewindToTurn(log.path, 0, root, { ...HYDRATE, scope: 'chat' });
    assert.ok(res.context, 'chat rewind hydrates the conversation');
    assert.equal(res.restoredFiles.length, 0, 'no file work reported');
    assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'MODIFIED BY TURN 1', 'file untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scope "code" restores workspace files and leaves the conversation alone', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const sid = SessionLog.sessionIdFromPath(log.path);
    log.record(snap(0, 'q0'));
    log.record(snap(1, 'q1'));
    saveCheckpoint(root, sid, 0, 'src/a.ts', 'ORIGINAL');
    writeFileSync(join(root, 'src/a.ts'), 'MODIFIED BY TURN 1');

    const res = rewindToTurn(log.path, 0, root, { ...HYDRATE, scope: 'code' });
    assert.equal(res.context, undefined, 'no hydrated context — the conversation did not move');
    assert.deepEqual(res.restoredFiles, ['src/a.ts']);
    assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'ORIGINAL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the default scope rewinds BOTH conversation and files (v6.18 behavior intact)', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const sid = SessionLog.sessionIdFromPath(log.path);
    log.record(snap(0, 'q0'));
    log.record(snap(1, 'q1'));
    saveCheckpoint(root, sid, 0, 'src/a.ts', 'ORIGINAL');
    writeFileSync(join(root, 'src/a.ts'), 'MODIFIED BY TURN 1');

    const res = rewindToTurn(log.path, 0, root, HYDRATE);
    assert.ok(res.context, 'conversation rewound');
    assert.equal(res.turn, 0);
    assert.deepEqual(res.restoredFiles, ['src/a.ts']);
    assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'ORIGINAL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── adversarial-review regressions (F08-07 review) ────────────────────────────────────────────

test('F1: a torn snapshot payload throws BEFORE any workspace file moves', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const sid = SessionLog.sessionIdFromPath(log.path);
    log.record(snap(0, 'q0'));
    // A parseable-but-invalid snapshot for turn 1 (no `messages`) — hydrate must reject it.
    log.record({ kind: 'context_snapshot', turn: 1, data: { pinnedPrefix: 1 } });
    saveCheckpoint(root, sid, 1, 'src/a.ts', 'ORIGINAL');
    writeFileSync(join(root, 'src/a.ts'), 'MODIFIED BY TURN 2');

    assert.throws(() => rewindToTurn(log.path, 1, root, HYDRATE));
    assert.equal(
      readFileSync(join(root, 'src/a.ts'), 'utf8'),
      'MODIFIED BY TURN 2',
      'the workspace must not be half-rewound when the payload is invalid',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F3: a non-monotonic log (resume-seeded turn 0) resolves to the LAST appended exact match', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    log.record(snap(0, 'original lineage'));
    log.record(snap(1, 'original turn 1'));
    log.record(snap(0, 'resumed lineage')); // interactive /resume appends a second turn 0

    const res = rewindToTurn(log.path, 0, root, { ...HYDRATE, scope: 'chat' });
    assert.ok(res.context);
    const msgs = res.context.messages();
    const first = msgs.find((m) => m.role === 'user');
    const text = first?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? '';
    assert.equal(text, 'resumed lineage', 'the newest append of the exact turn wins');

    // turn 1 still resolves to the original-lineage snapshot (no exact-match hijack).
    const res1 = rewindToTurn(log.path, 1, root, { ...HYDRATE, scope: 'chat' });
    const t1 = res1.context!.messages().find((m) => m.role === 'user');
    const t1text = t1?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? '';
    assert.equal(t1text, 'original turn 1', 'turn 1 keeps its own snapshot — no hijack by the seed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F4: a planted checkpoint index.json cannot write or delete outside the workspace', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const sid = SessionLog.sessionIdFromPath(log.path);
    log.record(snap(0, 'q0'));
    log.record(snap(1, 'q1'));

    // Plant a malicious index for turn 1: relPath escapes with '..', absPath reads elsewhere,
    // and an absent entry tries to delete an outside path.
    const evilDir = join(root, '.shadow', 'checkpoints', sid, '1');
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(join(evilDir, 'index.json'), JSON.stringify([
      { relPath: '../escaped.ts', file: 'x.bak', absPath: '/etc/passwd' },
      { relPath: '../../outside-delete.ts', file: '', absPath: '', absent: true },
    ]));
    const outside = join(root, '..', 'escaped.ts');
    writeFileSync(join(root, 'legit.ts'), 'in-workspace file');

    const res = rewindToTurn(log.path, 0, root, { ...HYDRATE, scope: 'code' });
    assert.ok(!existsSync(outside), 'no file written outside the workspace');
    assert.deepEqual(res.restoredFiles, [], 'escaping entries are ignored, not reported');
    assert.equal(readFileSync(join(root, 'legit.ts'), 'utf8'), 'in-workspace file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F5: replacing the log at the same path invalidates the incremental cache (fresh parse)', () => {
  const root = ws();
  try {
    const path = join(root, 'session.jsonl');
    const a = snap(0, 'first file contents');
    writeFileSync(path, JSON.stringify(a) + '\n');
    assert.equal(listRewindableTurns(path)[0]!.prompt, 'first file contents');

    // Same path, SAME size class, totally different content — the head fingerprint must catch it.
    const b = snap(0, 'REPLACED file contents!');
    writeFileSync(path, JSON.stringify(b) + '\n');
    const turns = listRewindableTurns(path);
    assert.equal(turns.length, 1, 'no merged stale+new turns');
    assert.equal(turns[0]!.prompt, 'REPLACED file contents!', 'stale cache not served');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F6: a missing OLDEST backup surfaces in partialFiles instead of silently restoring newer', () => {
  const root = ws();
  try {
    const log = SessionLog.open(root);
    const sid = SessionLog.sessionIdFromPath(log.path);
    log.record(snap(0, 'q0'));
    log.record(snap(1, 'q1'));
    log.record(snap(2, 'q2'));
    saveCheckpoint(root, sid, 1, 'src/a.ts', 'STATE-BEFORE-TURN-1');
    saveCheckpoint(root, sid, 2, 'src/a.ts', 'STATE-BEFORE-TURN-2');
    writeFileSync(join(root, 'src/a.ts'), 'CURRENT');
    // Lose the OLDEST backup: the chain can no longer reach turn 0. Keep the index, drop the .bak.
    const bakDir = join(root, '.shadow', 'checkpoints', sid, '1');
    const idx = JSON.parse(readFileSync(join(bakDir, 'index.json'), 'utf8')) as Array<{ absPath: string }>;
    for (const e of idx) rmSync(e.absPath, { force: true });

    const res = rewindToTurn(log.path, 0, root, { ...HYDRATE, scope: 'code' });
    assert.deepEqual(res.partialFiles, ['src/a.ts'], 'reported as partially restored');
    assert.equal(
      readFileSync(join(root, 'src/a.ts'), 'utf8'),
      'STATE-BEFORE-TURN-2',
      'the newest surviving backup landed — a state LATER than the target, now announced',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
