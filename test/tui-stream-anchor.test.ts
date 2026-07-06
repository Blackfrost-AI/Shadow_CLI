import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCompleteBlocks, clampTail } from '../src/tui.js';

// ── extractCompleteBlocks ───────────────────────────────────────────────────
// Splits an accumulating markdown stream into completed top-level blocks (to be
// committed to <Static>) plus the still-incomplete trailing remainder (kept live).
// The invariant the streaming TUI relies on: completed prose flows to scrollback
// as it finishes, so the live region — and therefore the input composer — never
// grows unboundedly mid-turn.

test('no blank-line boundary yet → nothing committed, all stays live', () => {
  const { blocks, rest } = extractCompleteBlocks('partial line still streaming');
  assert.deepEqual(blocks, []);
  assert.equal(rest, 'partial line still streaming');
});

test('one completed paragraph commits, partial next stays live', () => {
  const { blocks, rest } = extractCompleteBlocks('First paragraph.\n\nSecond para');
  assert.deepEqual(blocks, ['First paragraph.']);
  assert.equal(rest, 'Second para');
});

test('multiple completed blocks commit in order', () => {
  const { blocks, rest } = extractCompleteBlocks('A\n\nB\n\nC still going');
  assert.deepEqual(blocks, ['A', 'B']);
  assert.equal(rest, 'C still going');
});

test('an OPEN code fence is never split — whole fence stays live until it closes', () => {
  const buf = 'Here is code:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n';
  const { blocks, rest } = extractCompleteBlocks(buf);
  // The prose paragraph commits; the open fence (which contains a blank line!)
  // must NOT be committed or split on that interior blank line.
  assert.deepEqual(blocks, ['Here is code:']);
  assert.equal(rest, '```ts\nconst a = 1;\n\nconst b = 2;\n');
});

test('a CLOSED code fence commits as one whole block', () => {
  const buf = '```ts\nconst a = 1;\n```\n\nafter';
  const { blocks, rest } = extractCompleteBlocks(buf);
  assert.deepEqual(blocks, ['```ts\nconst a = 1;\n```']);
  assert.equal(rest, 'after');
});

test('interior single newlines (lists) stay within one block', () => {
  const { blocks, rest } = extractCompleteBlocks('1. one\n2. two\n3. three\n\nnext');
  assert.deepEqual(blocks, ['1. one\n2. two\n3. three']);
  assert.equal(rest, 'next');
});

// ── clampTail ────────────────────────────────────────────────────────────────
// Bounds the live (in-progress) block to its last N lines so even a giant
// still-open code block cannot push the composer down or overflow the viewport.

test('short text is returned unchanged', () => {
  assert.equal(clampTail('a\nb\nc', 6), 'a\nb\nc');
});

test('long text is clamped to the last N lines', () => {
  const src = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const out = clampTail(src, 5);
  assert.equal(out.split('\n').length, 5);
  assert.equal(out, 'line 15\nline 16\nline 17\nline 18\nline 19');
});

test('clamping inside an OPEN fence re-opens the fence so it still renders as code', () => {
  const lines = ['```swift', ...Array.from({ length: 30 }, (_, i) => `code ${i}`)];
  const out = clampTail(lines.join('\n'), 5);
  // The original ``` opener has scrolled off; clampTail must re-open the fence
  // (preserving the language) so Markdown keeps code styling.
  assert.ok(out.startsWith('```swift\n'), `expected reopened swift fence, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('code 29'), 'keeps the most recent code line');
});

test('clamping a closed (balanced) region does not inject a fence', () => {
  const lines = ['```\nx\n```', ...Array.from({ length: 30 }, (_, i) => `p ${i}`)];
  const out = clampTail(lines.join('\n'), 4);
  assert.ok(!out.startsWith('```'), 'no spurious fence when not inside an open fence');
});

test('does NOT inject a second fence when the opener is already inside the tail', () => {
  // Prose with no blank line before the fence keeps prose+fence in ONE block, so the
  // live buffer is "prose\n```ts\n<code>". When the kept tail still contains the real
  // opener, re-opening would produce ```ts\n```ts — an empty code block + plain text.
  const out = clampTail('Let me show you:\n```ts\nc1\nc2\nc3\nc4\nc5', 6);
  assert.equal(out, '```ts\nc1\nc2\nc3\nc4\nc5');
  assert.equal((out.match(/```/g) ?? []).length, 1, 'exactly one fence opener survives');
});
