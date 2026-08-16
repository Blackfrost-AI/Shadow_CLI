import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vimNormalKey, type VimMode, type VimFind } from '../src/tui/vim.js';

/** Full cross-keypress state — the same shape tui.tsx threads through its refs (F08-08). */
interface St {
  input: string;
  cursor: number;
  mode: VimMode;
  pendingOp: string;
  lastFind: VimFind | null;
  count: number;
  register: string;
}

function st(input: string, cursor = 0): St {
  return { input, cursor, mode: 'normal', pendingOp: '', lastFind: null, count: 0, register: '' };
}

function press(s: St, ch: string, w = 1_000_000): St {
  const r = vimNormalKey(s.input, s.cursor, s.pendingOp, ch, w, {
    lastFind: s.lastFind,
    count: s.count,
    register: s.register,
  });
  return {
    input: r.input,
    cursor: r.cursor,
    mode: r.mode,
    pendingOp: r.pendingOp,
    lastFind: r.lastFind,
    count: r.count,
    register: r.register,
  };
}

function type(s: St, keys: string, w = 1_000_000): St {
  for (const ch of keys) s = press(s, ch, w);
  return s;
}

// ─── f / F / t / T with ; and , ─────────────────────────────────────────────────────────────────
// Buffer: h0 e1 l2 l3 o4 ␣5 w6 o7 r8 l9 d10
const HELLOWORLD = 'hello world';

test('f lands ON the char, t just BEFORE it', () => {
  assert.equal(type(st(HELLOWORLD), 'fl').cursor, 2);
  assert.equal(type(st(HELLOWORLD), 'tl').cursor, 1);
  assert.equal(type(st(HELLOWORLD, 2), 'fl').cursor, 3, 'next occurrence after the caret');
});

test('F and T search backwards (on / just-after)', () => {
  assert.equal(type(st(HELLOWORLD, 10), 'Fl').cursor, 9);
  assert.equal(type(st(HELLOWORLD, 10), 'Tl').cursor, 4, 'T lands just after the match');
});

test('a find with no match does not move and cancels cleanly', () => {
  const s = type(st('abc'), 'fz');
  assert.equal(s.cursor, 0);
  assert.equal(s.pendingOp, '', 'no dangling find state');
  assert.equal(s.count, 0);
});

test('a count BEFORE the find reaches the Nth occurrence (2fl)', () => {
  assert.equal(type(st(HELLOWORLD), '2fl').cursor, 3, '2fl lands on the second l');
});

test('; repeats the last find, , repeats it backwards', () => {
  let s = type(st(HELLOWORLD), 'fl'); // → 2
  s = type(s, ';');
  assert.equal(s.cursor, 3);
  s = type(s, ';');
  assert.equal(s.cursor, 9);
  s = type(s, ',');
  assert.equal(s.cursor, 3);
  s = type(s, ',');
  assert.equal(s.cursor, 2);
});

test('t-repeat never sticks on the adjacent match', () => {
  // a0 ␣1 x2 ␣3 x4 — after landing before the first x, ; must reach before the SECOND x.
  let s = type(st('a x x'), 'tx');
  assert.equal(s.cursor, 1);
  s = type(s, ';');
  assert.equal(s.cursor, 3);
});

test('the find target may itself be a motion letter or a digit', () => {
  assert.equal(type(st('a w b'), 'fw').cursor, 2, 'fw searches for w, does not word-move');
  assert.equal(type(st('a 3 b'), 'f3').cursor, 2, 'f3 searches for 3, does not extend a count');
});

// ─── counts ──────────────────────────────────────────────────────────────────────────────────────

test('counts multiply motions: 3l, 2w, 4h clamped at line start', () => {
  assert.equal(type(st(HELLOWORLD), '3l').cursor, 3);
  assert.equal(type(st('one two three'), '2w').cursor, 8);
  assert.equal(type(st(HELLOWORLD, 5), '4h').cursor, 1);
});

test('a count survives an unrecognized key, then applies', () => {
  const s = type(st(HELLOWORLD), '2zl');
  assert.equal(s.cursor, 2, 'z consumed nothing; the 2 still applied to l');
});

test('bare 0 is still the line-start motion, but 10l is a count', () => {
  assert.equal(type(st(HELLOWORLD, 6), '0').cursor, 0);
  assert.equal(type(st('x'.repeat(20)), '10l').cursor, 10);
});

test('2x deletes two clusters and fills the register', () => {
  const s = type(st('abcd'), '2x');
  assert.equal(s.input, 'cd');
  assert.equal(s.register, 'ab');
});

// ─── operators with counts and finds ─────────────────────────────────────────────────────────────

test('d2w deletes two words; d0/d$ unchanged', () => {
  const s = type(st('one two three four'), 'd2w');
  assert.equal(s.input, 'three four');
  assert.equal(s.register, 'one two ');
});

test('2dd deletes two hard lines', () => {
  const s = type(st('a\nb\nc'), '2dd');
  assert.equal(s.input, 'c');
  assert.equal(s.register, 'a\nb\n');
});

test('dfc deletes through the char; dtc stops before it', () => {
  assert.equal(type(st('abcdef'), 'dfc').input, 'def');
  assert.equal(type(st('abcdef'), 'dtc').input, 'cdef');
  assert.equal(type(st('abcdef'), 'dfc').register, 'abc');
});

test('dFx deletes backwards through the char', () => {
  const s = type(st('abcdef', 5), 'dFb');
  assert.equal(s.input, 'af');
  assert.equal(s.register, 'bcde');
});

test('an operator-find with no match cancels without touching the buffer', () => {
  const s = type(st('abcdef'), 'dfz');
  assert.equal(s.input, 'abcdef');
  assert.equal(s.pendingOp, '');
});

test('cw-family still enters INSERT after the cut', () => {
  const s = type(st('hello'), 'cfl');
  assert.equal(s.input, 'lo');
  assert.equal(s.mode, 'insert');
});

// ─── y / p / P ───────────────────────────────────────────────────────────────────────────────────

test('yw yanks without moving; p pastes after the cell, P before', () => {
  const s = type(st('abc def'), 'yw');
  assert.equal(s.register, 'abc ');
  assert.equal(s.cursor, 0, 'yank never moves the caret');
  const after = type(s, 'p');
  assert.equal(after.input, 'aabc bc def');
  assert.equal(after.cursor, 4, 'caret lands on the last pasted char');
  const before = type(s, 'P');
  assert.equal(before.input, 'abc abc def');
});

test('yy is line-wise: p inserts a whole line below, P above', () => {
  let s = type(st('one\ntwo'), 'yy');
  assert.equal(s.register, 'one\n');
  s = type(s, 'p');
  assert.equal(s.input, 'one\none\ntwo');
  assert.equal(s.cursor, 4, 'caret on the first char of the pasted line');

  const up = type(type(st('one\ntwo'), 'yy'), 'P');
  assert.equal(up.input, 'one\none\ntwo');
  assert.equal(up.cursor, 0);
});

test('deletes fill the register too — x then p round-trips', () => {
  let s = type(st('abc'), 'x');
  assert.equal(s.register, 'a');
  s = type(s, 'p');
  assert.equal(s.input, 'bac');
});

test('p with an empty register is a no-op', () => {
  const s = type(st('abc'), 'p');
  assert.equal(s.input, 'abc');
  assert.equal(s.cursor, 0);
});

test('3p pastes the register three times', () => {
  const s = type(type(st('abc'), 'x'), '3p');
  assert.equal(s.input, 'baaac');
  assert.equal(s.cursor, 3, 'caret on the last pasted char');
});

// ─── o / O / r / J ───────────────────────────────────────────────────────────────────────────────

test('o opens below, O opens above — both drop into INSERT on the new line', () => {
  const down = type(st('ab\ncd'), 'o');
  assert.equal(down.input, 'ab\n\ncd');
  assert.equal(down.cursor, 3);
  assert.equal(down.mode, 'insert');

  const up = type(st('ab\ncd', 3), 'O');
  assert.equal(up.input, 'ab\n\ncd');
  assert.equal(up.cursor, 3, 'caret on the new empty line');
  assert.equal(up.mode, 'insert');
});

test('r replaces the cell under the caret and stays in NORMAL', () => {
  const s = type(st('abc'), 'rz');
  assert.equal(s.input, 'zbc');
  assert.equal(s.cursor, 0);
  assert.equal(s.mode, 'normal');
});

test('2r replaces two cells with the same char', () => {
  const s = type(st('abcd'), '2ra');
  assert.equal(s.input, 'aacd');
  assert.equal(s.cursor, 1, 'caret on the last replaced cell');
});

test('J joins the next line: strips indent, one space, caret at the join', () => {
  const s = type(st('one\n    two'), 'J');
  assert.equal(s.input, 'one two');
  assert.equal(s.cursor, 3);
});

test('2J joins three lines; J on the last line is a no-op', () => {
  assert.equal(type(st('a\nb\nc'), '2J').input, 'a b c');
  const s = type(st('only one line', 3), 'J');
  assert.equal(s.input, 'only one line');
});

// ─── adversarial review regressions (2026-08-14) ───────────────────────────────────────────────

// Detects an UNPAIRED surrogate (half of a pair). The naive /[\uD800-\uDFFF]/ also matches the
// two code units of a perfectly healthy astral char — which would false-positive on a register
// that legitimately holds an emoji — so match a high NOT followed by a low, or a low NOT
// preceded by a high.
const HAS_LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('V1: backward find with no earlier match terminates at index 0 (no infinite loop)', () => {
  // 'fl' lands on the first l (index 2). One more ',' scans backwards for 'l', but none exists
  // before index 2 — the scan must walk to index 0 and STOP, not spin. prevGrapheme stalls at 0
  // (composer), so an unguarded `while (i >= ls)` looped forever on the FIRST hard line.
  const s = type(type(st(HELLOWORLD), 'fl'), ',');
  assert.equal(s.cursor, 2, 'no match behind — caret stays put');
  assert.equal(type(st('abc', 2), 'Fz').cursor, 2, 'Fz with no z terminates cleanly');
  assert.equal(type(st('abc', 2), 'Tz').cursor, 2, 'backward till with no match terminates');
});

test('V2: df<emoji> deletes the WHOLE astral target, never an orphaned surrogate', () => {
  const s = type(st('a\u{1F389}b'), 'df\u{1F389}');
  assert.equal(s.input, 'b');
  assert.equal(s.register, 'a\u{1F389}');
  assert.ok(!HAS_LONE_SURROGATE.test(s.input), 'no lone surrogate may survive the delete');
  assert.ok(!HAS_LONE_SURROGATE.test(s.register));
});

test('V3: t before a multi-unit cluster lands on the cluster start, not mid-pair', () => {
  // 'a😀x': x is at index 3; t must land at the emoji cluster start (1), not the low surrogate (2).
  const s = type(st('a\u{1F600}x'), 'tx');
  assert.equal(s.cursor, 1, 'cluster-aligned landing');
});

test('V4: x/dl on a line\'s last cell heals the caret onto the new last cell', () => {
  const s = type(st('ab\ncd', 1), 'x'); // delete 'b' — line 'ab' → 'a'
  assert.equal(s.input, 'a\ncd');
  assert.equal(s.cursor, 0, 'caret back on "a", not parked on the "\\n" cell');
  const t = type(st('abc', 2), 'x'); // delete the final char of the only line
  assert.equal(t.input, 'ab');
  assert.equal(t.cursor, 1, 'caret on the new last cell, not past the end');
  const u = type(st('ab\ncd', 1), 'dl');
  assert.equal(u.input, 'a\ncd');
  assert.equal(u.cursor, 0);
});

test('V5: J with the caret on a newline cell refuses rather than splicing the wrong lines', () => {
  // x the 'b' out of 'a\nb\nc' — the caret is left ON the '\n'; J used to swallow BOTH breaks
  // around the empty line and produce 'a c'. It must now be a no-op.
  let s = type(st('a\nb\nc', 2), 'x');
  assert.equal(s.input, 'a\n\nc');
  assert.equal(s.cursor, 2, 'caret sits on the newline cell');
  s = type(s, 'J');
  assert.equal(s.input, 'a\n\nc', 'J refused — both newlines intact');
  assert.equal(type(st('\n'), 'J').input, '\n', 'J on a lone-newline buffer is a no-op');
});

test('V6: p/P/r with multi-unit clusters park the caret on a cluster start', () => {
  const s = type(st('a\u{1F389}b', 1), 'x'); // x the emoji → register '🎉', input 'ab', caret 1
  assert.equal(s.register, '\u{1F389}');
  assert.equal(s.input, 'ab');

  const p = type(s, 'p'); // paste after 'b'
  assert.equal(p.input, 'ab\u{1F389}');
  assert.equal(p.cursor, 2, 'caret on the pasted emoji start, not its low surrogate (3)');

  const P = type(s, 'P'); // paste before 'b'
  assert.equal(P.input, 'a\u{1F389}b');
  assert.equal(P.cursor, 1, 'P caret on the emoji start, not mid-pair (2)');

  const r = type(st('abcd'), '2r\u{1F389}'); // replace 'a','b' with two emoji
  assert.equal(r.input, '\u{1F389}\u{1F389}cd');
  assert.equal(r.cursor, 2, 'caret on the 2nd emoji start, not mid-pair (1)');
});

test('V7: dw from the last word of a line stops at the break (never eats the newline)', () => {
  const s = type(st('ab\ncd'), 'dw');
  assert.equal(s.input, '\ncd', 'the newline survives');
  assert.equal(s.register, 'ab');
  const t = type(st('ab \ncd'), 'dw');
  assert.equal(t.input, '\ncd', 'trailing space goes too, but not the break');
  const u = type(st('one two three'), 'dw');
  assert.equal(u.input, 'two three', 'dw within a line is unchanged');
});

test('V8: a count-find with too few matches does not move (no partial landing)', () => {
  // HELLOWORLD has l at 2, 3, 9 — only three. 5fl must NOT move the caret.
  const s = type(st(HELLOWORLD), '5fl');
  assert.equal(s.cursor, 0, 'partial matches never land the caret');
  assert.equal(s.pendingOp, '');
  assert.equal(s.count, 0);
  // Exactly-enough still reaches the Nth match.
  assert.equal(type(st(HELLOWORLD), '3fl').cursor, 9, '3 matches → lands on the 3rd');
});
