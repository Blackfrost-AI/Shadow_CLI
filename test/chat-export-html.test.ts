import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sessionToHtml, exportSession, escapeHtml } from '../src/state/chatExport.js';

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

test('escapeHtml neutralizes markup-significant characters', () => {
  assert.equal(
    escapeHtml('<script>alert("x&y")</script>\'quoted\''),
    '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;&#39;quoted&#39;',
  );
});

test('sessionToHtml renders header facts and user/assistant/tool/blocked sections', () => {
  const events = [
    { kind: 'user', task: 'fix tests', ts: '2026-06-21T11:00:00.000Z' },
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
  const html = sessionToHtml(events, META);
  // Header: session id in title + heading, start date, model, turn count.
  assert.match(html, /<title>Shadow session test<\/title>/);
  assert.match(html, /<h1>Shadow session test<\/h1>/);
  assert.match(html, /2026-06-21T11:00:00\.000Z/);
  assert.match(html, /mock\/mock/);
  assert.match(html, /<dd>1<\/dd>/); // one user turn
  // Transcript sections, visually distinct.
  assert.match(html, /class="msg user"/);
  assert.match(html, /fix tests/);
  assert.match(html, /class="msg assistant"/);
  assert.match(html, /Reading first/);
  assert.match(html, /class="tool ok"/);
  assert.match(html, /Tool · read_file/);
  assert.match(html, /42 lines/);
  assert.match(html, /class="msg blocked"/);
  assert.match(html, /Plan mode is active/);
  // Light + dark themes via media query in inline CSS.
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
});

test('sessionToHtml escapes injected markup — no live <script> survives', () => {
  const events = [
    { kind: 'user', task: '<script>alert(1)</script> & "quotes"' },
    { kind: 'event', type: 'assistant_done', text: 'safe <b>reply</b>' },
    {
      kind: 'event',
      type: 'tool_end',
      call: { name: 'run_shell', input: { command: 'echo "<img src=x onerror=alert(1)>"' } },
      result: { ok: false, summary: '<script>nope</script>' },
    },
  ];
  const html = sessionToHtml(events, META);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;reply&lt;/b&gt;'));
  assert.ok(!html.includes('<script'), 'no raw <script tag may appear');
  assert.ok(!html.includes('<img'), 'no raw <img tag may appear');
  assert.ok(!html.includes('</script>'), 'no raw closing script tag may appear');
});

test('sessionToHtml is self-contained: no external references or scripts', () => {
  const events = [
    { kind: 'user', task: 'hello world' },
    { kind: 'event', type: 'assistant_done', text: 'hi' },
  ];
  const html = sessionToHtml(events, META);
  assert.ok(!html.includes('http://'), 'no http:// references');
  assert.ok(!html.includes('https://'), 'no https:// references');
  assert.ok(!html.includes('<script'), 'zero JavaScript');
  assert.ok(!html.includes('<link'), 'no external stylesheets');
  assert.ok(!html.includes('@import'), 'no CSS imports');
  assert.match(html, /<style>/, 'CSS is inline');
});

test('sessionToHtml renders subagent transcripts inside <details> collapsibles', () => {
  const events = [
    { kind: 'user', task: 'delegate the search' },
    {
      kind: 'event',
      type: 'bg_agent_launched',
      taskId: 'agent_123',
      prompt: 'find the flaky test',
      subagentType: 'explore',
    },
    {
      kind: 'event',
      type: 'task_notification',
      taskId: 'agent_123',
      answer: 'found it: timing race in retry.test.ts',
      fromSubagent: 'explore',
    },
  ];
  const html = sessionToHtml(events, META);
  assert.equal(html.match(/<details class="subagent">/g)!.length, 2);
  assert.match(html, /<summary>Background agent launched · explore \(agent_123\)<\/summary>/);
  assert.match(html, /find the flaky test/);
  assert.match(html, /<summary>Subagent result · explore<\/summary>/);
  assert.match(html, /found it: timing race in retry\.test\.ts/);
});

test('sessionToHtml trims long tool args/results with a "… N more chars" marker', () => {
  const big = 'x'.repeat(2500);
  const events = [
    {
      kind: 'event',
      type: 'tool_end',
      call: { name: 'run_shell', input: { command: big } },
      result: { ok: true, summary: big },
    },
  ];
  const html = sessionToHtml(events, META);
  assert.match(html, /… 500 more chars/);
  assert.ok(!html.includes('x'.repeat(2500)), 'raw untrimmed value must not appear');
});

test('exportSession with format html writes a .html file under workspace exports/', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-export-html-'));
  try {
    const sessionDir = join(root, '.shadow', 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, 's.jsonl');
    writeFileSync(sessionPath, JSON.stringify({ kind: 'user', task: 'hello' }) + '\n');
    const { path, bytes } = exportSession({
      sessionPath,
      workspaceRoot: root,
      format: 'html',
      meta: { ...META, workspaceRoot: root, sessionPath },
    });
    assert.ok(bytes > 0);
    assert.match(path, /exports\/shadow-.*\.html$/);
    const body = readFileSync(path, 'utf8');
    assert.match(body, /^<!doctype html>/);
    assert.match(body, /hello/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
