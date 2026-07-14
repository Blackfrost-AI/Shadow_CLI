import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutComposer,
  cursorToRowCol,
  rowColToCursor,
  moveCursorVertical,
  cursorOnFirstRow,
  cursorOnLastRow,
  visibleComposerWindow,
  clickToCursor,
  parseSgrMouse,
  isBigPaste,
} from '../src/tui/composer.js';

test('layoutComposer: hard newlines break; long lines soft-wrap', () => {
  const { lines } = layoutComposer('hello\nworld', 20);
  assert.deepEqual(lines, ['hello', 'world']);
  const wrap = layoutComposer('abcdefghij', 4);
  assert.deepEqual(wrap.lines, ['abcd', 'efgh', 'ij']);
  const trail = layoutComposer('a\n', 20);
  assert.deepEqual(trail.lines, ['a', '']);
});

test('cursorToRowCol / rowColToCursor round-trip', () => {
  const text = 'one\ntwo\nthree';
  for (let i = 0; i <= text.length; i++) {
    const { row, col } = cursorToRowCol(text, i, 40);
    assert.equal(rowColToCursor(text, row, col, 40), i, `round-trip at ${i}`);
  }
});

test('moveCursorVertical preserves column across rows', () => {
  const text = 'aaaa\nbbbb\ncccc';
  // caret on first line col 2
  let c = rowColToCursor(text, 0, 2, 40);
  c = moveCursorVertical(text, c, 1, 40);
  assert.deepEqual(cursorToRowCol(text, c, 40), { row: 1, col: 2 });
  c = moveCursorVertical(text, c, 1, 40);
  assert.deepEqual(cursorToRowCol(text, c, 40), { row: 2, col: 2 });
  // at last row, further down is a no-op
  const stuck = moveCursorVertical(text, c, 1, 40);
  assert.equal(stuck, c);
  assert.equal(cursorOnLastRow(text, c, 40), true);
  assert.equal(cursorOnFirstRow(text, 0, 40), true);
});

test('visibleComposerWindow keeps caret on-screen', () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const cursor = rowColToCursor(text, 15, 0, 40);
  const win = visibleComposerWindow(text, cursor, 40, 5);
  assert.equal(win.lines.length, 5);
  assert.ok(win.caretRow >= 0 && win.caretRow < 5);
  assert.ok(win.offset + win.caretRow === 15);
});

test('clickToCursor maps local row/col into the source', () => {
  const text = 'hello\nworld';
  assert.equal(clickToCursor(text, 1, 2, 40, 0), rowColToCursor(text, 1, 2, 40));
});

test('parseSgrMouse: left click press', () => {
  const ev = parseSgrMouse('\x1b[<0;12;40M');
  assert.deepEqual(ev, { button: 0, x: 12, y: 40, press: true });
  assert.equal(parseSgrMouse('hello'), null);
  assert.equal(parseSgrMouse('\x1b[<0;12;40m')!.press, false);
});

test('isBigPaste: multi-paragraph drafts stay inline; only huge blobs chip', () => {
  assert.equal(isBigPaste('a\nb\nc'), false, '3 lines is editable, not a chip');
  assert.equal(isBigPaste('short path'), false);
  assert.equal(isBigPaste('x'.repeat(9000)), true);
  assert.equal(isBigPaste(Array.from({ length: 50 }, () => 'line').join('\n')), true);
});
