import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApprovalDiff, PendingOverlay } from '../src/tui/overlays.js';
import type { ToolCall } from '../src/provider/provider.js';

/**
 * F10-04 — edit/write/patch approval dialogs must show the pending CHANGE, not a one-line gist.
 * Users were approving file mutations blind: the committed transcript renders `meta.diff` only
 * AFTER the tool ran. These tests drive the pure builder directly, plus two overlay renders to
 * prove the dialog actually paints the diff (and that non-file tools are untouched).
 */
const call = (name: string, input: unknown): ToolCall => ({ id: 't1', name, input }) as unknown as ToolCall;

const COLORS = { fg: '#fff', dim: '#999', green: '#0f0', cyan: '#0ff', yellow: '#ff0', red: '#f00', purple: '#f0f' };
const ANSI = /\x1b\[[0-9;]*m/g;

function renderPending(c: ToolCall, rows = 40): string {
  const pending = { id: 'ap_t', kind: 'permission' as const, call: c, risk: 'write' as const, preview: `${c.name} preview`, reason: 'test' };
  const { lastFrame, unmount } = render(
    React.createElement(PendingOverlay, {
      pending: pending as never,
      cols: 120,
      rows,
      pageMargin: 4,
      colors: COLORS,
      activeQuestion: undefined,
      activeQuestionIndex: 0,
      pendingQuestionsLength: 0,
      activeQuestionSelection: [],
      questionCursor: {},
      autoAnswerSecs: null,
    } as never),
  );
  const frame = (lastFrame() ?? '').replace(ANSI, '');
  unmount();
  return frame;
}

test('edit_file: removed and added lines carry correct +/- tags', () => {
  const d = buildApprovalDiff(
    call('edit_file', { path: 'src/x.ts', old_string: 'const a = 1;\nreturn a;', new_string: 'const a = 2;\nreturn a;' }),
    20,
  );
  assert.ok(d, 'edit_file must produce an approval diff');
  assert.equal(d.header, 'edit_file src/x.ts');
  assert.ok(d.lines.some((l) => l.tag === '-' && l.text === 'const a = 1;'), 'the removed line is tagged -');
  assert.ok(d.lines.some((l) => l.tag === '+' && l.text === 'const a = 2;'), 'the added line is tagged +');
  assert.ok(d.lines.some((l) => l.tag === ' ' && l.text === 'return a;'), 'unchanged text stays context');
  assert.equal(d.stats, '+1 −1');
  assert.equal(d.hidden, 0);
});

test('write_file to a new path: all-additions diff', () => {
  const d = buildApprovalDiff(call('write_file', { path: 'docs/new.md', content: 'alpha\nbeta\ngamma\n' }), 20, () => null);
  assert.ok(d);
  assert.equal(d.header, 'write_file docs/new.md');
  assert.deepEqual(
    d.lines,
    [
      { tag: '+', text: 'alpha' },
      { tag: '+', text: 'beta' },
      { tag: '+', text: 'gamma' },
    ],
    'a new file previews as pure additions, trailing newline not counted as a line',
  );
  assert.equal(d.stats, '+3');
});

test('write_file overwrite: diffs against the injected prior content', () => {
  const d = buildApprovalDiff(
    call('write_file', { path: 'a.txt', content: 'one\nNEW\nthree' }),
    20,
    () => 'one\nOLD\nthree',
  );
  assert.ok(d);
  assert.ok(d.lines.some((l) => l.tag === '-' && l.text === 'OLD'));
  assert.ok(d.lines.some((l) => l.tag === '+' && l.text === 'NEW'));
  assert.equal(d.stats, '+1 −1');
});

test('write_file overwrite: the default reader picks up a real file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-apdiff-'));
  try {
    const p = join(dir, 'real.txt');
    writeFileSync(p, 'keep\ndrop\n');
    const d = buildApprovalDiff(call('write_file', { path: p, content: 'keep\nadded\n' }), 20);
    assert.ok(d);
    assert.ok(d.lines.some((l) => l.tag === '-' && l.text === 'drop'), 'existing content read from disk shows as removed');
    assert.ok(d.lines.some((l) => l.tag === '+' && l.text === 'added'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply_patch: the patch renders with +/- tags, envelope stripped, file named', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/y.ts',
    '@@',
    ' context line',
    '-old line',
    '+new line',
    '*** End Patch',
  ].join('\n');
  const d = buildApprovalDiff(call('apply_patch', { patch }), 20);
  assert.ok(d);
  assert.equal(d.header, 'apply_patch src/y.ts');
  assert.ok(d.lines.some((l) => l.tag === ' ' && l.text.includes('Update File: src/y.ts')), 'file headers stay visible as context');
  assert.ok(d.lines.some((l) => l.tag === '-' && l.text === 'old line'));
  assert.ok(d.lines.some((l) => l.tag === '+' && l.text === 'new line'));
  assert.ok(d.lines.some((l) => l.tag === ' ' && l.text === 'context line'));
  assert.ok(!d.lines.some((l) => l.text.includes('Begin Patch') || l.text.includes('End Patch')), 'the envelope is not diff content');
});

test('apply_patch: multi-file patch names the file count', () => {
  const patch = ['*** Begin Patch', '*** Add File: a.txt', '+hello', '*** Delete File: b.txt', '*** End Patch'].join('\n');
  const d = buildApprovalDiff(call('apply_patch', { patch }), 20);
  assert.ok(d);
  assert.equal(d.header, 'apply_patch (2 files)');
});

test('multi_edit: per-edit separators and both hunks', () => {
  const d = buildApprovalDiff(
    call('multi_edit', {
      path: 'src/m.ts',
      edits: [
        { old_string: 'aaa', new_string: 'bbb' },
        { old_string: 'ccc', new_string: 'ddd' },
      ],
    }),
    20,
  );
  assert.ok(d);
  assert.equal(d.header, 'multi_edit src/m.ts (2 edits)');
  assert.ok(d.lines.some((l) => l.tag === ' ' && l.text === '— edit 1/2 —'));
  assert.ok(d.lines.some((l) => l.tag === ' ' && l.text === '— edit 2/2 —'));
  assert.ok(d.lines.some((l) => l.tag === '-' && l.text === 'aaa'));
  assert.ok(d.lines.some((l) => l.tag === '+' && l.text === 'ddd'));
  assert.equal(d.stats, '+2 −2');
});

test('huge edit: the cap holds and the elided count is reported', () => {
  const oldText = Array.from({ length: 120 }, (_, i) => `old line ${i}`).join('\n');
  const newText = Array.from({ length: 120 }, (_, i) => `new line ${i}`).join('\n');
  const d = buildApprovalDiff(call('edit_file', { path: 'big.ts', old_string: oldText, new_string: newText }), 20);
  assert.ok(d);
  assert.equal(d.lines.length, 20, 'the visible cap holds');
  assert.ok(d.hidden > 0, 'the elided remainder is counted');
});

test('non-file tools and malformed inputs fall back to null (one-line preview keeps working)', () => {
  assert.equal(buildApprovalDiff(call('run_shell', { command: 'rm -rf /' }), 20), null);
  assert.equal(buildApprovalDiff(call('read_file', { path: 'a.ts' }), 20), null);
  assert.equal(buildApprovalDiff(call('edit_file', { path: 'a.ts', old_string: 'x' }), 20), null, 'missing new_string');
  assert.equal(buildApprovalDiff(call('edit_file', { path: 'a.ts', old_string: 'x', new_string: 'x' }), 20), null, 'no net change');
  assert.equal(buildApprovalDiff(call('write_file', { path: 'a.ts', content: 42 }), 20, () => null), null);
  assert.equal(buildApprovalDiff(call('multi_edit', { path: 'a.ts', edits: 'nope' }), 20), null);
  assert.equal(buildApprovalDiff(call('apply_patch', { patch: '' }), 20), null);
  assert.equal(buildApprovalDiff(call('apply_patch', 'not an object'), 20), null);
});

test('the rendered dialog paints the diff for a pending edit_file', () => {
  const frame = renderPending(
    call('edit_file', { path: 'src/x.ts', old_string: 'const a = 1;\nreturn a;', new_string: 'const a = 2;\nreturn a;' }),
  );
  assert.match(frame, /action: edit_file src\/x\.ts/, 'the action row names tool + path');
  assert.match(frame, /\+1 −1/, 'the +N −M stat line matches the committed-diff convention');
  assert.match(frame, /- const a = 1;/, 'the removed line is visible before approval');
  assert.match(frame, /\+ const a = 2;/, 'the added line is visible before approval');
});

test('the rendered dialog caps a huge diff with the elision marker', () => {
  const oldText = Array.from({ length: 120 }, (_, i) => `old line ${i}`).join('\n');
  const newText = Array.from({ length: 120 }, (_, i) => `new line ${i}`).join('\n');
  const frame = renderPending(call('edit_file', { path: 'big.ts', old_string: oldText, new_string: newText }));
  assert.match(frame, /more diff lines not shown — deny and inspect if unsure/);
});

test('a short terminal keeps the plain preview (no diff rows in the frame budget)', () => {
  const frame = renderPending(
    call('edit_file', { path: 'src/x.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }),
    18,
  );
  assert.match(frame, /action: edit_file preview/, 'the one-line preview is untouched');
  assert.doesNotMatch(frame, /- const a = 1;/);
});

test('regression: run_shell dialog is unchanged — command preview, no diff chrome', () => {
  const frame = renderPending(call('run_shell', { command: 'rm -rf /', description: 'List files' }));
  assert.match(frame, /action: run_shell preview/, 'the one-line preview still carries the action');
  assert.match(frame, /Why: test/);
  assert.doesNotMatch(frame, /−|diff lines not shown/, 'no diff stat or marker appears for a shell call');
});
