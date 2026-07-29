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
