import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vimNormalKey, nextWordStart, prevWordStart, wordEnd } from '../src/tui/vim.js';

// Convenience: run a sequence of NORMAL-mode chars, threading state.
function run(input: string, cursor: number, keys: string) {
  let st = { input, cursor, mode: 'normal' as 'normal' | 'insert', pendingOp: '' };
  for (const ch of keys) {
    const r = vimNormalKey(st.input, st.cursor, st.pendingOp, ch);
    st = { input: r.input, cursor: r.cursor, mode: r.mode, pendingOp: r.pendingOp };
  }
  return st;
}

test('word motions (w/b/e) cross tokens correctly', () => {
  const s = 'foo bar.baz qux';
  assert.equal(nextWordStart(s, 0), 4, 'w from "foo" → "bar"');
  assert.equal(nextWordStart(s, 4), 7, 'w from "bar" → "."');
  assert.equal(prevWordStart(s, 12), 8, 'b from "qux" → "baz"');
  assert.equal(wordEnd(s, 0), 2, 'e from start → end of "foo"');
});

test('h/l/0/$ move the cursor and clamp at the ends', () => {
  assert.equal(run('hello', 0, 'l').cursor, 1);
  assert.equal(run('hello', 0, 'h').cursor, 0, 'h clamps at 0');
  assert.equal(run('hello', 2, '$').cursor, 4, '$ goes to last char');
  assert.equal(run('hello', 4, '0').cursor, 0, '0 goes to first char');
});

test('i/a/I/A enter insert mode at the right caret position', () => {
  assert.deepEqual(
    (({ mode, cursor }) => ({ mode, cursor }))(run('abc', 1, 'i')),
    { mode: 'insert', cursor: 1 },
    'i keeps the caret',
  );
  assert.equal(run('abc', 1, 'a').cursor, 2, 'a moves one right');
  assert.equal(run('abc', 1, 'A').cursor, 3, 'A goes to end');
  assert.equal(run('abc', 2, 'I').cursor, 0, 'I goes to start');
  assert.equal(run('abc', 1, 'i').mode, 'insert');
});

test('x deletes the char under the caret; D/C delete to end of line', () => {
  assert.equal(run('hello', 1, 'x').input, 'hllo');
  assert.equal(run('hello', 0, 'D').input, '', 'D from 0 clears the line');
  const c = run('hello', 2, 'C');
  assert.equal(c.input, 'he');
  assert.equal(c.mode, 'insert', 'C enters insert mode');
});

test('dw deletes a word; dd clears the line; cc clears + inserts', () => {
  assert.equal(run('foo bar baz', 0, 'dw').input, 'bar baz', 'dw removes "foo "');
  assert.equal(run('foo bar', 0, 'dd').input, '', 'dd clears the whole line');
  const cc = run('foo bar', 3, 'cc');
  assert.equal(cc.input, '');
  assert.equal(cc.mode, 'insert', 'cc enters insert mode');
});

test('d$ deletes to end of line; an operator then unknown motion is a no-op', () => {
  assert.equal(run('hello world', 5, 'd$').input, 'hello', 'd$ trims the tail');
  const noop = run('hello', 2, 'dz'); // 'z' is not a motion → operator cancels, nothing deleted
  assert.equal(noop.input, 'hello');
  assert.equal(noop.pendingOp, '', 'pending operator was cleared');
});

test('unrecognized NORMAL keys are reported not-consumed (so they never insert text)', () => {
  const r = vimNormalKey('hello', 0, '', 'z');
  assert.equal(r.consumed, false);
  assert.equal(r.input, 'hello', 'no text mutation');
});

// ── Grapheme safety ───────────────────────────────────────────────────────────────────────────
// `cursor ± 1` walks UTF-16 CODE UNITS. On an emoji (surrogate pair) or a ZWJ cluster that lands
// INSIDE the character, so `x`/`s`/`dl`/`dh` deleted half of one — producing a lone surrogate that
// went to the provider in the submitted message.

const NO_ORPHAN_SURROGATE = /[\uD800-\uDFFF]/;

test('x deletes a whole emoji, not half a surrogate pair', () => {
  const r = run('\u{1F389}ab', 0, 'x');
  assert.equal(r.input, 'ab');
  assert.ok(!NO_ORPHAN_SURROGATE.test(r.input), 'no orphaned surrogate may survive');
});

test('x deletes a whole ZWJ family cluster', () => {
  const r = run('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}!', 0, 'x');
  assert.equal(r.input, '!');
});

test('s replaces a whole cluster and enters insert', () => {
  const r = run('\u4E2D\u6587', 0, 's');
  assert.equal(r.input, '\u6587');
  assert.equal(r.mode, 'insert');
});

test('dl deletes one whole cluster forward', () => {
  const r = run('\u{1F680}xy', 0, 'dl');
  assert.equal(r.input, 'xy');
  assert.ok(!NO_ORPHAN_SURROGATE.test(r.input));
});

test('h/l motions step over a whole cluster', () => {
  assert.equal(run('\u{1F680}ab', 0, 'l').cursor, 2, 'a surrogate pair is 2 code units — clear both');
  assert.equal(run('\u{1F680}ab', 2, 'h').cursor, 0);
});

// ── F03-06: hard-line keys in multiline drafts ────────────────────────────────────────────────
// The composer is multiline (Shift+Enter). Line-bound keys used to treat the WHOLE buffer as the
// line: $ jumped to the end of the draft, 0/I to its start, D deleted to the end of the draft,
// and dd cleared everything. Every key below stops at the caret's hard line (composer
// lineStart/lineEnd), never crossing a '\n'.

//                f  o  o \n  b  a  r  _  b  a  z \n  q  u  x
// indices:       0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
const ML = 'foo\nbar baz\nqux';

test('hard-line motions: 0/$/I/A/h/l stop at the caret\'s line ends, not the buffer ends', () => {
  assert.equal(run(ML, 6, '0').cursor, 4, '0 lands on the first char of "bar baz"');
  assert.equal(run(ML, 6, '$').cursor, 10, '$ lands on the LAST char of "bar baz"');
  assert.equal(run(ML, 6, 'I').cursor, 4, 'I inserts at the hard-line start');
  assert.equal(run(ML, 6, 'A').cursor, 11, 'A inserts at the hard-line end');
  assert.equal(run(ML, 4, 'h').cursor, 4, 'h at a line start cannot cross the newline');
  assert.equal(run(ML, 10, 'l').cursor, 10, 'l at a line end cannot cross onto the newline');
  // Single-line drafts degenerate to the whole buffer — old behavior preserved.
  assert.equal(run('hello', 2, '$').cursor, 4);
  assert.equal(run('hello', 2, '0').cursor, 0);
});

test('hard-line deletes: x/D never eat the line break', () => {
  assert.equal(run(ML, 10, 'x').input, 'foo\nbar ba\nqux', 'x removes the "z", the newline stays');
  assert.equal(run(ML, 11, 'x').input, ML, 'x while the caret sits ON a newline is a no-op');
  assert.equal(run(ML, 6, 'D').input, 'foo\nba\nqux', 'D kills to the hard-line end only');
  const c = run(ML, 6, 'C');
  assert.equal(c.input, 'foo\nba\nqux');
  assert.equal(c.mode, 'insert');
});

test('hard-line operator motions: d$/d0/dh/dl stay on the caret\'s line', () => {
  assert.equal(run(ML, 6, 'd$').input, 'foo\nba\nqux');
  assert.equal(run(ML, 6, 'd0').input, 'foo\nr baz\nqux', 'd0 keeps the char under the caret');
  assert.equal(run(ML, 4, 'dh').input, ML, 'dh at a line start deletes nothing');
  assert.equal(run(ML, 10, 'dl').input, 'foo\nbar ba\nqux', 'dl deletes the "z", not the newline');
});

test('dd/cc delete ONE hard line, swallowing one adjacent newline', () => {
  assert.equal(run(ML, 6, 'dd').input, 'foo\nqux', 'an inner line vanishes with its own newline');
  assert.equal(run(ML, 6, 'dd').cursor, 4, 'the caret lands where the line used to start');
  assert.equal(run(ML, 13, 'dd').input, 'foo\nbar baz', 'the LAST line swallows the newline before it');
  assert.equal(run(ML, 13, 'dd').cursor, 10, 'the caret clamps onto the new last char');
  assert.equal(run(ML, 1, 'dd').input, 'bar baz\nqux', 'the FIRST line swallows its own newline');
  const cc = run(ML, 6, 'cc');
  assert.equal(cc.input, 'foo\nqux');
  assert.equal(cc.mode, 'insert');
  assert.equal(cc.cursor, 4);
  assert.equal(run('abc', 1, 'dd').input, '', 'a one-line draft still collapses to empty');
});

// ── F03-06: charClass aligned with the composer ───────────────────────────────────────────────
// The old charClass used \w — CJK counts as PUNCTUATION there, so vim and the composer disagreed
// on where words are. One table (isWordChar: \p{L}\p{N}_) now drives both.

test('word motions agree with the composer on CJK (isWordChar, not \\w)', () => {
  const s = 'a太 b';
  assert.equal(nextWordStart(s, 0), 3, 'w skips "a" AND "太" — one word class, not two');
  assert.equal(run(s, 0, 'w').cursor, 3);
  assert.equal(prevWordStart(s, 3), 0, 'b lands back on the a+太 run (old \\w charClass stopped at 1)');
  assert.equal(wordEnd('太 郎', 0), 2, 'e still finds the end of the next CJK run');
});

// ── F03-06: j/k visual-row motion ─────────────────────────────────────────────────────────────

test('j/k move between WRAPPED visual rows when given the composer width', () => {
  // 'aaaaaaa' wraps into 'aaaa' + 'aaa' at width 4; lines = [aaaa, aaa, bb], starts = [0,4,8].
  const buf = 'aaaaaaa\nbb';
  assert.equal(vimNormalKey(buf, 1, '', 'j', 4).cursor, 5, 'j preserves the column across the wrap');
  assert.equal(vimNormalKey(buf, 5, '', 'j', 4).cursor, 9, 'j again lands on the second hard line');
  assert.equal(vimNormalKey(buf, 9, '', 'k', 4).cursor, 5);
  assert.equal(vimNormalKey(buf, 9, '', 'j', 4).cursor, 9, 'j on the last visual row is a no-op');
  assert.equal(vimNormalKey(buf, 1, '', 'k', 4).cursor, 1, 'k on the first visual row is a no-op');
});

test('j/k without a width fall back to HARD-line motion (unit-test default)', () => {
  assert.equal(run('foo\nbar\nqux', 1, 'j').cursor, 5, 'same column on the next hard line');
  assert.equal(run('foo\nbar\nqux', 5, 'k').cursor, 1);
  assert.equal(run('foo\nb', 2, 'j').cursor, 5, 'column clamps to the shorter line');
});
