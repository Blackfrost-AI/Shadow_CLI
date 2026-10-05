import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionToMarkdown, exportSession } from '../src/state/chatExport.js';

const META = {
  version: '0.4.0',
  workspaceRoot: '/tmp/ws',
  provider: 'mock',
  model: 'mock',
  style: 'proactive',
  autonomy: 'auto-edit',
  sessionPath: '/tmp/ws/.shadow/sessions/test.jsonl',
  exportedAt: '2026-06-21T12:00:00.000Z',
};

test('sessionToMarkdown renders user, assistant, tool, and blocked rows', () => {
  const events = [
    { kind: 'user', task: 'fix tests' },
    { kind: 'event', type: 'assistant_done', text: 'Reading first.' },
    {
      kind: 'event',
      type: 'tool_end',
      call: { name: 'read_file', input: { path: 'src/a.ts' } },
      result: { ok: true, summary: '42 lines' },
    },
    {
      kind: 'event',
      type: 'tool_denied',
      call: { name: 'write_file' },
      reason: 'plan mode blocks write tool write_file',
    },
  ];
  const md = sessionToMarkdown(events, META);
  assert.match(md, /## User/);
  assert.match(md, /> fix tests/);
  assert.match(md, /## Assistant/);
  assert.match(md, /Reading first/);
  assert.match(md, /## Tool · read_file/);
  assert.match(md, /42 lines/);
  assert.match(md, /## Blocked · write_file/);
  assert.match(md, /Plan mode is active/);
});

test('sessionToMarkdown renders retry events as reason + attempt, never raw JSON (review F4)', () => {
  // Retry events carry {attempt, delayMs, reason} — never `message`. The old code fell back to
  // JSON.stringify and dumped `{"type":"retry","attempt":1,…}` into exported transcripts.
  const events = [
    { kind: 'user', task: 'go' },
    { kind: 'event', type: 'retry', attempt: 1, delayMs: 0, reason: 'context overflow — compacted and retrying' },
    { kind: 'event', type: 'retry', attempt: 0, delayMs: 250, reason: 'empty response' },
  ];
  const md = sessionToMarkdown(events, META);
  assert.match(md, /Retry \(attempt 1\): context overflow — compacted and retrying/);
  assert.match(md, /Retry: empty response/, 'attempt 0 renders without an attempt suffix');
  assert.doesNotMatch(md, /\{"type":"retry"/, 'no raw JSON event dump');
});

test('sessionToMarkdown exports reasoning_done as a collapsed details block (F02-04)', () => {
  // The old export silently DROPPED reasoning — a transcript that silently lost a whole section.
  // Now it survives, collapsed so the readable answer stays front and center.
  const events = [
    { kind: 'user', task: 'think hard' },
    { kind: 'event', type: 'reasoning_done', text: 'First consider the edge cases…' },
    { kind: 'event', type: 'assistant_done', text: 'Here is the answer.' },
    // empty reasoning exports nothing
    { kind: 'event', type: 'reasoning_done', text: '   ' },
  ];
  const md = sessionToMarkdown(events, META);
  assert.match(md, /## Reasoning/);
  assert.match(md, /<details><summary>Reasoning \(collapsed\)<\/summary>/);
  assert.match(md, /First consider the edge cases…/);
  assert.match(md, /<\/details>/);
  assert.match(md, /Here is the answer\./);
  // reasoning appears BEFORE the assistant answer, matching the turn order
  assert.ok(md.indexOf('## Reasoning') < md.indexOf('## Assistant'));
  // the whitespace-only reasoning event added no second block
  assert.equal(md.match(/## Reasoning/g)?.length, 1);
});

test('exportSession writes markdown file under workspace exports/', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-export-'));
  try {
    const sessionDir = join(root, '.shadow', 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, 's.jsonl');
    writeFileSync(sessionPath, JSON.stringify({ kind: 'user', task: 'hello' }) + '\n');
    const { path, bytes } = exportSession({
      sessionPath,
      workspaceRoot: root,
      meta: { ...META, workspaceRoot: root, sessionPath },
    });
    assert.ok(bytes > 0);
    assert.match(path.replaceAll('\\', '/'), /exports\/shadow-/);
    const body = readFileSync(path, 'utf8');
    assert.match(body, /hello/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportSession uses the latest context snapshot as a resumed transcript baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-export-snapshot-'));
  try {
    const sessionDir = join(root, '.shadow', 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, 'resumed.jsonl');
    const snapshot = {
      ts: '2026-06-21T11:00:00.000Z',
      kind: 'context_snapshot',
      format: 'full',
      turn: 0,
      data: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'restored prompt' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'restored answer' }] },
        ],
        pinnedPrefix: 1,
        lastActualTokens: 0,
      },
    };
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({ kind: 'user', task: 'discarded pre-snapshot duplicate' }),
        JSON.stringify(snapshot),
        JSON.stringify({ kind: 'resumed_from', sessionId: 'source-session', path: '/source.jsonl' }),
        JSON.stringify({ kind: 'user', task: 'new prompt' }),
        JSON.stringify({ kind: 'event', type: 'assistant_done', text: 'new answer' }),
      ].join('\n') + '\n',
    );

    const mdPath = exportSession({
      sessionPath,
      workspaceRoot: root,
      outPath: 'snapshot.md',
      meta: { ...META, workspaceRoot: root, sessionPath },
    }).path;
    const htmlPath = exportSession({
      sessionPath,
      workspaceRoot: root,
      outPath: 'snapshot.html',
      format: 'html',
      meta: { ...META, workspaceRoot: root, sessionPath },
    }).path;
    for (const body of [readFileSync(mdPath, 'utf8'), readFileSync(htmlPath, 'utf8')]) {
      assert.match(body, /restored prompt/);
      assert.match(body, /restored answer/);
      assert.match(body, /new prompt/);
      assert.match(body, /new answer/);
      assert.doesNotMatch(body, /discarded pre-snapshot duplicate/);
      assert.equal(body.match(/restored answer/g)?.length, 1, 'snapshot history is not duplicated');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('normal checkpoints do not erase reasoning, errors, or other pre-snapshot audit events', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-export-audit-'));
  try {
    const sessionDir = join(root, '.shadow', 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, 'normal.jsonl');
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({ kind: 'user', task: 'investigate' }),
        JSON.stringify({ kind: 'event', type: 'reasoning_done', text: 'audit reasoning' }),
        JSON.stringify({ kind: 'event', type: 'assistant_done', text: 'audit answer' }),
        JSON.stringify({ kind: 'event', type: 'error', message: 'audit error' }),
        JSON.stringify({
          kind: 'context_snapshot',
          format: 'full',
          turn: 0,
          data: {
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'investigate' }] },
              { role: 'assistant', content: [{ type: 'text', text: 'audit answer' }] },
            ],
            pinnedPrefix: 1,
            lastActualTokens: 0,
          },
        }),
      ].join('\n') + '\n',
    );

    const path = exportSession({
      sessionPath,
      workspaceRoot: root,
      outPath: 'normal.md',
      meta: { ...META, workspaceRoot: root, sessionPath },
    }).path;
    const body = readFileSync(path, 'utf8');
    assert.match(body, /audit reasoning/);
    assert.match(body, /audit answer/);
    assert.match(body, /audit error/);
    assert.equal(body.match(/audit answer/g)?.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rewind lineage drops only the undone suffix and preserves earlier audit events', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-export-rewind-'));
  try {
    const sessionDir = join(root, '.shadow', 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, 'rewound.jsonl');
    const lines: string[] = [];
    let bytes = 0;
    const add = (record: unknown): number => {
      const offset = bytes;
      const line = JSON.stringify(record) + '\n';
      lines.push(line);
      bytes += Buffer.byteLength(line);
      return offset;
    };
    add({ kind: 'user', task: 'kept prompt' });
    add({ kind: 'event', type: 'reasoning_done', text: 'kept reasoning' });
    add({ kind: 'event', type: 'assistant_done', text: 'kept answer' });
    const sourceSnapshotOffset = add({
      kind: 'context_snapshot',
      format: 'full',
      turn: 0,
      data: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'kept prompt' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'kept answer' }] },
        ],
        pinnedPrefix: 1,
        lastActualTokens: 0,
      },
    });
    add({ kind: 'user', task: 'undone prompt' });
    add({ kind: 'event', type: 'assistant_done', text: 'undone answer' });
    add({
      kind: 'context_snapshot',
      format: 'full',
      turn: 1,
      data: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'kept prompt' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'kept answer' }] },
          { role: 'user', content: [{ type: 'text', text: 'undone prompt' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'undone answer' }] },
        ],
        pinnedPrefix: 1,
        lastActualTokens: 0,
      },
    });
    const durableSnapshotOffset = add({
      kind: 'context_snapshot',
      format: 'full',
      turn: 0,
      data: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'kept prompt' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'kept answer' }] },
        ],
        pinnedPrefix: 1,
        lastActualTokens: 0,
      },
    });
    add({ kind: 'rewound_to', turn: 0, sourceSnapshotOffset, durableSnapshotOffset });
    add({ kind: 'user', task: 'replacement prompt' });
    add({ kind: 'event', type: 'assistant_done', text: 'replacement answer' });
    writeFileSync(sessionPath, lines.join(''));

    const path = exportSession({
      sessionPath,
      workspaceRoot: root,
      outPath: 'rewound.md',
      meta: { ...META, workspaceRoot: root, sessionPath },
    }).path;
    const body = readFileSync(path, 'utf8');
    assert.match(body, /kept prompt/);
    assert.match(body, /kept reasoning/);
    assert.match(body, /kept answer/);
    assert.match(body, /replacement prompt/);
    assert.match(body, /replacement answer/);
    assert.doesNotMatch(body, /undone prompt|undone answer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
