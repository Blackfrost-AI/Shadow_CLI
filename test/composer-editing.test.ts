import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wordLeft,
  wordRight,
  lineStart,
  lineEnd,
  deleteWordLeft,
  deleteWordRight,
  deleteCharLeft,
  deleteCharRight,
  killToLineEnd,
  killToLineStart,
  isWordChar,
  parseSgrMouse,
  hasSgrMouse,
  stripSgrMouse,
} from '../src/tui/composer.js';

// A caret marker makes these readable: '|' is where the cursor sits.
const at = (s: string): { text: string; cursor: number } => ({ text: s.replace('|', ''), cursor: s.indexOf('|') });

test('wordLeft: absorbs whitespace then one run (word or punctuation)', () => {
  const c = (s: string): number => {
    const { text, cursor } = at(s);
    return wordLeft(text, cursor);
  };
  assert.equal(c('hello world|'), 6, 'stops at the start of the last word');
  assert.equal(c('hello world   |'), 6, 'trailing spaces are absorbed with the word');
  assert.equal(c('hello |world'), 0, 'from a word start, jumps the previous word');
  assert.equal(c('|hello'), 0, 'buffer start is a fixed point');
  // A path peels segment by segment — extension, dot, name, slash — like a native text field.
  assert.equal(c('src/tui/composer.ts|'), 17, 'peels the extension off a path');
  assert.equal(c('src/tui/composer.|ts'), 16, 'then the dot');
  assert.equal(c('src/tui/composer|.ts'), 8, 'then the name');
  assert.equal(c('src/tui/|composer.ts'), 7, 'then the separator');
});

test('wordRight: mirror of wordLeft', () => {
  const c = (s: string): number => {
    const { text, cursor } = at(s);
    return wordRight(text, cursor);
  };
  assert.equal(c('|hello world'), 5);
  assert.equal(c('hello| world'), 11);
  assert.equal(c('hello world|'), 11, 'buffer end is a fixed point');
  assert.equal(c('|  spaced'), 8, 'leading whitespace is absorbed');
});

test('word motions are Unicode-aware and never leave the buffer', () => {
  assert.ok(isWordChar('é') && isWordChar('9') && isWordChar('_'));
  assert.ok(!isWordChar('-') && !isWordChar(' ') && !isWordChar(undefined));
  assert.equal(wordLeft('naïve café', 10), 6);
  // Out-of-range cursors clamp instead of producing NaN/negative indexes.
  assert.equal(wordLeft('abc', 99), 0);
  assert.equal(wordRight('abc', -5), 3);
});

test('deleteWordLeft is Option+Delete: one word per press, kill ring filled', () => {
  const { text, cursor } = at('fix the tui spacing|');
  let r = deleteWordLeft(text, cursor);
  assert.equal(r.text, 'fix the tui ');
  assert.equal(r.cursor, 12);
  assert.equal(r.killed, 'spacing');
  r = deleteWordLeft(r.text, r.cursor);
  assert.equal(r.text, 'fix the ', 'the space rides along with the word');
  r = deleteWordLeft(r.text, r.cursor);
  assert.equal(r.text, 'fix ');
  r = deleteWordLeft(r.text, r.cursor);
  assert.equal(r.text, '');
  r = deleteWordLeft(r.text, r.cursor);
  assert.equal(r.text, '', 'no-op at the buffer start');
  assert.equal(r.killed, '', 'a no-op must not clobber the kill ring');
});

test('deleteWordLeft only touches text before the caret', () => {
  const { text, cursor } = at('alpha beta| gamma');
  const r = deleteWordLeft(text, cursor);
  assert.equal(r.text, 'alpha  gamma');
  assert.equal(r.cursor, 6);
});

test('deleteWordRight / deleteCharRight', () => {
  const { text, cursor } = at('alpha |beta gamma');
  const r = deleteWordRight(text, cursor);
  assert.equal(r.text, 'alpha  gamma');
  assert.equal(r.cursor, 6, 'caret stays put on a forward delete');
  assert.equal(deleteCharRight('abc', 1).text, 'ac');
  assert.equal(deleteCharRight('abc', 3).text, 'abc', 'no-op at the end');
  assert.equal(deleteCharLeft('abc', 0).text, 'abc', 'no-op at the start');
  assert.equal(deleteCharLeft('abc', 3).text, 'ab');
});

test('line motions and kills work per HARD line in a multi-row draft', () => {
  const text = 'first line\nsecond line\nthird';
  const mid = text.indexOf('second') + 3; // inside "second"
  assert.equal(lineStart(text, mid), 11);
  assert.equal(lineEnd(text, mid), 22);
  assert.equal(lineStart(text, 0), 0);
  assert.equal(lineEnd(text, text.length), text.length);

  const k = killToLineEnd(text, mid);
  assert.equal(k.text, 'first line\nsec\nthird');
  assert.equal(k.killed, 'ond line');

  const u = killToLineStart(text, mid);
  assert.equal(u.text, 'first line\nond line\nthird');
  assert.equal(u.cursor, 11);
  assert.equal(u.killed, 'sec');
});

test('killToLineEnd at a line end eats the newline (readline behavior)', () => {
  const text = 'one\ntwo';
  const r = killToLineEnd(text, 3); // caret right before the \n
  assert.equal(r.text, 'onetwo');
  assert.equal(r.killed, '\n');
});

test('a draft that BEGINS with a newline still reports line start 0 at the caret origin', () => {
  // lastIndexOf clamps a negative fromIndex to 0, so the naive form finds that leading newline
  // and reports 1 — Ctrl+A would jump the caret forward and Ctrl+U would eat the blank line.
  const text = '\nsecond';
  assert.equal(lineStart(text, 0), 0);
  assert.equal(killToLineStart(text, 0).text, text, 'Ctrl+U at position 0 is a no-op');
  assert.equal(lineStart(text, 3), 1, 'and the second line still starts after the newline');
});

test('parseSgrMouse accepts the ESC-stripped form Ink actually delivers', () => {
  // The regression that made click-to-caret dead code for the whole 3.x line: Ink strips a
  // chunk-leading ESC, so the handler only ever saw '[<0;12;30M'.
  const stripped = parseSgrMouse('[<0;12;30M');
  assert.deepEqual(stripped, { button: 0, x: 12, y: 30, press: true });
  const withEsc = parseSgrMouse('\x1b[<0;12;30M');
  assert.deepEqual(withEsc, stripped);
  assert.equal(parseSgrMouse('hello')?.button, undefined);
  // Release events and the wheel are parsed, and rejected by the caller — not here.
  assert.equal(parseSgrMouse('\x1b[<0;5;5m')?.press, false);
  assert.equal(parseSgrMouse('\x1b[<64;5;5M')?.button, 64);
  // A batch reports the LAST event (the newest position).
  assert.equal(parseSgrMouse('\x1b[<0;1;1M\x1b[<0;9;9M')?.x, 9);
});

test('hasSgrMouse / stripSgrMouse cover both forms', () => {
  assert.ok(hasSgrMouse('[<0;1;1M'));
  assert.ok(hasSgrMouse('\x1b[<0;1;1M'));
  assert.ok(!hasSgrMouse('plain text'));
  assert.equal(stripSgrMouse('ab[<0;1;1Mcd'), 'abcd');
  assert.equal(stripSgrMouse('ab\x1b[<0;1;1Mcd'), 'abcd');
});
