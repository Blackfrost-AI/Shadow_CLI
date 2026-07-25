import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutComposer, displayWidth, clickToCursor, cursorToRowCol, rowColToCursor } from '../src/tui/composer.js';

/**
 * B5 — the composer wrapped by UTF-16 code unit, not by terminal column.
 *
 * `layoutComposer('你好…', 10)` returned rows of 10 CHARACTERS = 20 columns, so every CJK/emoji
 * row overran the box, Ink truncated it, and the caret drifted by up to 2× across the row.
 */
const cols = (s: string): number => displayWidth(s);

test('displayWidth counts terminal columns, not characters', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('你好'), 4, 'CJK is double-width');
  assert.equal(displayWidth('😀'), 2, 'emoji is double-width');
  assert.equal(displayWidth(''), 0);
  // A ZWJ family emoji is ONE cluster: measured once, not once per component.
  assert.ok(displayWidth('👩‍👩‍👧') <= 2, `ZWJ sequence must not count per component, got ${displayWidth('👩‍👩‍👧')}`);
  // Combining marks add no width.
  assert.equal(displayWidth('é'), 1, 'e + combining acute is one column');
});

test('no wrapped row ever exceeds the requested width', () => {
  for (const [text, w] of [
    ['你好世界你好世界你好世界', 10],
    ['😀😀😀😀😀😀', 6],
    ['ok 你好 done here now', 10],
    ['abcdefghijklmnop', 10],
    ['a你b好c世d界e', 5],
  ] as const) {
    for (const line of layoutComposer(text, w).lines) {
      assert.ok(cols(line) <= w, `"${line}" is ${cols(line)} cols, max ${w}`);
    }
  }
});

test('a wrap never lands inside a grapheme cluster', () => {
  const { lines } = layoutComposer('😀😀😀😀', 3); // 3 cols fits ONE emoji (2) but not two
  for (const line of lines) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(line), `"${line}" ends on a lone high surrogate`);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(line), `"${line}" starts on a lone low surrogate`);
  }
  assert.equal(lines.join(''), '😀😀😀😀', 'and nothing is lost');
});

test('ASCII layout is completely unchanged', () => {
  assert.deepEqual(layoutComposer('abcdefghij', 4).lines, ['abcd', 'efgh', 'ij']);
  assert.deepEqual(layoutComposer('hello\nworld', 20).lines, ['hello', 'world']);
  assert.deepEqual(layoutComposer('a\n', 20).lines, ['a', '']);
});

test('cursor round-trips through the layout for wide text', () => {
  const text = '你好\nworld';
  for (let i = 0; i <= text.length; i++) {
    const { row, col } = cursorToRowCol(text, i, 10);
    assert.equal(rowColToCursor(text, row, col, 10), i, `round-trip at ${i}`);
  }
});

test('a click maps DISPLAY columns to the right source index past a wide char', () => {
  // "你好ab" — 你 occupies cols 0-1, 好 cols 2-3, a col 4, b col 5.
  const text = '你好ab';
  assert.equal(clickToCursor(text, 0, 0, 20), 0, 'col 0 → before 你');
  assert.equal(clickToCursor(text, 0, 2, 20), 1, 'col 2 → before 好 (source index 1, not 2)');
  assert.equal(clickToCursor(text, 0, 4, 20), 2, 'col 4 → before a');
  assert.equal(clickToCursor(text, 0, 5, 20), 3, 'col 5 → before b');
  // Clicking the LEFT half of a wide cluster puts the caret before it, not inside it.
  assert.equal(clickToCursor(text, 0, 1, 20), 0, 'col 1 is inside 你 → caret before it');
  // Past the end clamps to the row end.
  assert.equal(clickToCursor(text, 0, 99, 20), 4);
});
