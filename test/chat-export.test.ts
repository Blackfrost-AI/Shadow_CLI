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
    assert.match(path, /exports\/shadow-/);
    const body = readFileSync(path, 'utf8');
    assert.match(body, /hello/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});