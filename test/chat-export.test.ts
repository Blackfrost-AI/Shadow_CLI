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