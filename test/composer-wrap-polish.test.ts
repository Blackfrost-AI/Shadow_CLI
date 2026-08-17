// Composer wrapping + caret polish pins (the "world-class text entry bar" batch).
// Word-aware soft-wrap: the transcript has had wrapSpansWord (break at spaces) since F05; the
// composer's layoutComposer was pure greedy column-fill, so the SAME prose wrapped MID-WORD in
// the entry bar while rendering word-wrapped in the transcript above it. These pin the fix.
// Also pins the caret-row geometry: a caret at the end of a full row gets its own paint row
// (wrap="truncate" used to eat the CARET cell — "type a full row and the caret vanishes"), the
// frame budget agrees with the paint (composerPaintRows), and ↑/↓ keep a goal column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  layoutComposer,
  cursorToRowCol,
  rowColToCursor,
  caretNeedsOwnRow,
  composerPaintRows,
  moveCursorVertical,
} from '../src/tui/composer.js';
import { Composer } from '../src/tui.js';
import { displayWidth } from '../src/util/width.js';

test('layoutComposer word-wraps at spaces (no mid-word breaks when a space fits behind)', () => {
  // 'hello world' at 10 cols: char-fill broke INSIDE 'world' ('hello worl' / 'd').
  const w = layoutComposer('hello world', 10);
  assert.deepEqual(w.lines, ['hello ', 'world']);
  // The trailing wrap space stays at the end of row 1 (invisible when painted) so `starts`
  // remain plain source indices: row 2 begins at the char after the space.
  assert.equal(w.starts[1], 6);
});

test('layoutComposer keeps breakable behavior for space-free text (hard split unchanged)', () => {
  assert.deepEqual(layoutComposer('abcdefghij', 4).lines, ['abcd', 'efgh', 'ij']);
  // A single token wider than the row hard-splits — URLs and code identifiers still wrap.
  assert.deepEqual(layoutComposer('abcdefghijklmnop', 8).lines, ['abcdefgh', 'ijklmnop']);
});

test('layoutComposer: a word longer than the room but shorter than the row moves down whole', () => {
  // 'aa bbbbbbbb c' at 8: after 'aa ' (3 cols) the 8-col word cannot fit the remaining 5 —
  // it starts a fresh row rather than splitting 'bbbbbbbb' across the boundary.
  const w = layoutComposer('aa bbbbbbbb c', 8);
  assert.deepEqual(w.lines, ['aa ', 'bbbbbbbb', ' c']);
});

test('layoutComposer word-wrap: cursor mapping still round-trips at every index', () => {
  const text = 'the quick brown fox jumps over the lazy dog and then some more words wrap here';
  for (let i = 0; i <= text.length; i++) {
    const { row, col } = cursorToRowCol(text, i, 13);
    const back = rowColToCursor(text, row, col, 13);
    assert.equal(back, i, `round-trip at ${i}`);
  }
});

test('layoutComposer word-wrap: no row exceeds the column budget', () => {
  const text =
    'CJK 你好世界 mixed with english words and a verylongidentifierthathardandsplits and spaces     runs   ';
  for (const w of [6, 10, 13, 21]) {
    for (const line of layoutComposer(text, w).lines) {
      assert.ok(displayWidth(line) <= w, `row "${line}" exceeds ${w}`);
    }
  }
});

test('caretNeedsOwnRow: only a caret at the end of a row that exactly fills the width', () => {
  assert.equal(caretNeedsOwnRow('abcdefgh', 8, 8), true); // typed a full row — the vanishing case
  assert.equal(caretNeedsOwnRow('abcdefgh', 3, 8), false); // mid-row: the cell replaces a cluster
  assert.equal(caretNeedsOwnRow('abc', 3, 8), false); // short row: the cell fits after the text
  assert.equal(caretNeedsOwnRow('', 0, 8), false); // empty draft takes the placeholder path
});

test('composerPaintRows: budget matches the paint and never exceeds the cap', () => {
  // One full row, caret at its end: text row + borrowed caret row = 2 (uncapped, rides on top).
  assert.equal(composerPaintRows('x'.repeat(40), 40, 40, 8), 2);
  // Two full rows, caret at the very end: window 2 (< cap 8) + caret row on top = 3.
  assert.equal(composerPaintRows('x'.repeat(80), 80, 40, 8), 3);
  // Eight full rows (window AT the cap): the window yields one row to host the caret → net 8.
  assert.equal(composerPaintRows('x'.repeat(320), 320, 40, 8), 8);
  // Twenty rows, caret at the end: window 8 == cap → yields one → net 8.
  assert.equal(composerPaintRows('x'.repeat(800), 800, 40, 8), 8);
  // Caret mid-text (not at a row end): plain window.
  assert.equal(composerPaintRows('x'.repeat(800), 5, 40, 8), 8);
  assert.equal(composerPaintRows('hello', 5, 40, 8), 1);
});

test('moveCursorVertical: goal column survives passing over a short row', () => {
  // rows: 'aaaaaa' / 'xy' / 'aaaaaa' at width 6. From row 2 col 5, ↑ clamps to col 2 on the
  // short row — the NEXT ↑ must land on col 5 (the goal), not re-anchor at the clamp.
  const text = 'aaaaaa\nxy\naaaaaa';
  const step1 = moveCursorVertical(text, text.length, -1, 6); // row2 end → row1 (clamped)
  const col1 = cursorToRowCol(text, step1, 6).col;
  assert.equal(col1, 2); // clamped by the short row
  const step2 = moveCursorVertical(text, step1, -1, 6, col1 === 2 ? 5 : col1); // aim at the goal
  assert.equal(cursorToRowCol(text, step2, 6).col, 5);
  // Without a goal (old behavior) the second step lands at the clamp: pin the difference.
  const noGoal = moveCursorVertical(text, step1, -1, 6);
  assert.equal(cursorToRowCol(text, noGoal, 6).col, 2);
});

test('Composer paint: a caret ending a full row gets a visible row of its own', () => {
  // Composer geometry at cols 44: PAGE_MARGIN 4 → boxW 36, inner = 36 − COMPOSER_GUTTER 2 = 34.
  const cols = 44;
  const inner = 34;
  const full = 'y'.repeat(inner); // exactly one full row, caret at its end
  const r = render(
    React.createElement(Composer, { input: full, cursor: full.length, hint: '', cols, maxRows: 8, showHint: false }),
  );
  const frame = r.lastFrame() ?? '';
  // The text row paints whole and UNTRUNCATED (all 34 chars), and one more input row exists
  // below it for the caret (the inverse cell would otherwise be the truncated last column).
  assert.ok(frame.includes('y'.repeat(inner)), 'full row must paint untruncated');
  const lines = frame.split('\n');
  const textRow = lines.findIndex((l) => l.includes('y'.repeat(inner)));
  assert.ok(textRow >= 0 && textRow < lines.length - 2, 'a caret row must exist below the text row');
  r.unmount();
});

test('Composer paint: caret under an emoji is the whole cluster, not half', () => {
  const r = render(
    React.createElement(Composer, { input: 'a😀b', cursor: 1, hint: '', cols: 44, maxRows: 8, showHint: false }),
  );
  const frame = r.lastFrame() ?? '';
  assert.ok(frame.includes('a'), 'row paints');
  // No lone-surrogate mojibake (the old slice(col, col+1) emitted half the emoji).
  assert.ok(!frame.includes('�'), 'no replacement char from a split cluster');
  r.unmount();
});
