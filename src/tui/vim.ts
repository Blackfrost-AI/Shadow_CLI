/**
 * F03-02 — the pure vim NORMAL-mode reducer, fully unit-testable and zero ink dependencies.
 *
 * The composer supports multi-line drafts (Shift+Enter / a trailing backslash), so vim keys
 * operate on the caret's HARD line — lineStart/lineEnd come straight from the composer module
 * (F03-06) so `0`, `$`, `I`, `A`, `D`, `x`, `dd` never cross a `\n`. `j`/`k` move between
 * WRAPPED visual rows via the composer's moveCursorVertical (the caller passes the live
 * composer inner width). Word classification is the composer's own isWordChar — one charClass
 * for the whole editor, so vim and emacs motions agree on where words are.
 *
 * F08-08 depth: `f`/`F`/`t`/`T` find-in-line with `;`/`,` repeat, numeric counts (3w, d2w, 2dd…),
 * `y`/`p`/`P` with an unnamed register (deletes fill it too, exactly like vim), `o`/`O` open
 * line, `r` replace, and `J` join. Text objects and visual mode stay deferred. The find target
 * and the register/count live in `VimExtra` — the caller threads them through between keys, so
 * the reducer itself stays pure.
 *
 * `vimNormalKey(input, cursor, pendingOp, ch, innerWidth?, extra?)` returns the new
 * { input, cursor, mode, pendingOp, lastFind, count, register } (or the unchanged state for
 * unknown keys). The only impure glue left in tui.tsx is reading key.isRepeat / rendering the
 * MODE badge; commits go through applyEdit so vim kills are undoable with Ctrl+Z like every
 * other composer edit.
 *
 * Cursor semantics (NORMAL mode): the caret sits ON a character — never past the last cell of
 * a line — so h/l clamp against the hard-line ends and '$' lands on the line's final cluster.
 * All motions step whole grapheme clusters, never halves of a surrogate pair.
 */
import {
  lineStart,
  lineEnd,
  isWordChar,
  moveCursorVertical,
  prevGrapheme,
  nextGrapheme,
} from './composer.js';

export type VimMode = 'normal' | 'insert';

/** The last successful f/F/t/T — `;` repeats it, `,` repeats it backwards. */
export interface VimFind {
  target: string;
  dir: 1 | -1;
  till: boolean;
}

/** Cross-keypress vim state the caller threads through (all optional; defaults are neutral). */
export interface VimExtra {
  lastFind?: VimFind | null;
  /** Pending numeric prefix (0 = none). */
  count?: number;
  /** The unnamed register — last yank or delete, for p/P. */
  register?: string;
}

export interface VimNormalResult {
  input: string;
  cursor: number;
  mode: VimMode;
  pendingOp: string; // '' or 'd'/'c'/'y'/'r' (or 'd'+find char awaiting its target)
  /** false ONLY for unrecognized keys — the state is untouched and nothing was consumed. */
  consumed: boolean;
  lastFind: VimFind | null;
  /** Pending numeric prefix after this key (0 = consumed or none). */
  count: number;
  register: string;
}

/** Word classes, aligned with the composer: 0 = whitespace, 1 = word (\p{L}\p{N}_), 2 = everything else. */
function charClass(c: string): number {
  return /\s/.test(c) ? 0 : isWordChar(c) ? 1 : 2;
}

/** Index where the next word starts (a `w` motion). */
export function nextWordStart(s: string, cursor: number): number {
  const n = s.length;
  if (cursor >= n) return n;
  const k = charClass(s[cursor]);
  let i = cursor;
  while (i < n && charClass(s[i]) === k) i++; // skip the current word
  while (i < n && charClass(s[i]) === 0) i++; // skip whitespace
  return i;
}

/** Index where the previous word starts (a `b` motion). */
export function prevWordStart(s: string, cursor: number): number {
  if (cursor <= 0) return 0;
  let i = cursor - 1;
  while (i >= 0 && charClass(s[i]) === 0) i--; // back over whitespace
  if (i < 0) return 0;
  const k = charClass(s[i]);
  while (i > 0 && charClass(s[i - 1]) === k) i--; // back over the word
  return i;
}

/** Index of the last char of the current/next word (an `e` motion). */
export function wordEnd(s: string, cursor: number): number {
  const n = s.length;
  if (n === 0) return 0;
  let i = cursor + 1;
  while (i < n && charClass(s[i]) === 0) i++; // forward over whitespace
  if (i >= n) return n - 1;
  const k = charClass(s[i]);
  while (i < n && charClass(s[i]) === k) i++;
  return i - 1;
}

/**
 * F08-08: find `target` in the caret's hard line, starting one cell away from `cursor`.
 * Returns the LANDING cell (f: on the char; t: the cell before it; mirrored for F/T), or null
 * when nothing matches. A till-landing that would not actually move (target adjacent to the
 * caret) keeps searching further, so `;` repeats never stick on the same cell.
 */
export function findInLine(
  input: string,
  cursor: number,
  ls: number,
  le: number,
  target: string,
  dir: 1 | -1,
  till: boolean,
): number | null {
  if (!target) return null;
  if (dir === 1) {
    let i = nextGrapheme(input, cursor);
    while (i < le) {
      if (input.startsWith(target, i)) {
        // t lands on the cluster BEFORE the match — code-unit `i - 1` could land mid-pair
        // when the preceding cluster is multi-unit (the caret would sit on a lone surrogate).
        const pos = till ? prevGrapheme(input, i) : i;
        if (pos > cursor) return pos;
      }
      i = nextGrapheme(input, i);
    }
    return null;
  }
  let i = prevGrapheme(input, cursor);
  while (i >= ls) {
    if (input.startsWith(target, i)) {
      const pos = till ? i + target.length : i;
      if (pos < cursor) return pos;
    }
    // prevGrapheme STALLS at 0 (composer), so a backward scan that reaches the start of the
    // FIRST hard line without a match would otherwise loop forever — break after checking 0.
    if (i === 0) break;
    i = prevGrapheme(input, i);
  }
  return null;
}

/**
 * Handle one keypress while in NORMAL mode. Unknown keys return the unchanged state
 * with consumed:false so the caller can decide (they must never insert text).
 *
 * innerWidth is the composer's live inner width in columns; j/k use it to land on the right
 * wrapped visual row. When omitted (pure unit tests) it defaults to a width no draft ever
 * reaches, so rows never wrap and j/k move between hard lines — still correct, just coarser.
 * (Not Infinity: layoutComposer coerces with `|0`, which would turn it into width 1.)
 *
 * extra carries the cross-keypress state (last f/F/t/T target, numeric prefix, register); the
 * result carries the updated state for the caller to thread into the next key.
 */
export function vimNormalKey(
  input: string,
  cursor: number,
  pendingOp: string,
  ch: string,
  innerWidth: number = 1_000_000,
  extra?: VimExtra,
): VimNormalResult {
  const n = input.length;
  const clamp = (c: number): number => Math.max(0, Math.min(n, c));
  // The caret's hard line: every line-bound key stops at these, never at the buffer ends.
  const ls = lineStart(input, cursor);
  const le = lineEnd(input, cursor);
  // 0 = no digits typed yet. A typed '0' only EXTENDS once a count has started, so a BARE 0
  // still falls through to the line-start motion while '10l' accumulates to ten.
  const pendingCount = extra?.count ?? 0;
  const count = pendingCount === 0 ? 1 : pendingCount;
  // Unchanged-state base — unknown keys return the buffer untouched, and `ok` only overrides
  // the fields a key actually changes. Count/find/register/pendingOp PERSIST across
  // non-terminal keys (vim keeps a typed count across an unrecognized key — `d2w` needs the
  // 'd' to survive the '2'; a failed motion does not forget the register). Terminal paths
  // clear pendingOp explicitly.
  const base: VimNormalResult = {
    input,
    cursor,
    mode: 'normal',
    pendingOp,
    consumed: true,
    lastFind: extra?.lastFind ?? null,
    count: pendingCount, // the PENDING digits (0 = none), not the effective multiplier
    register: extra?.register ?? '',
  };
  const ok = (r: Partial<VimNormalResult>): VimNormalResult => ({ ...base, ...r });

  // r — the NEXT key is the replacement char, taken literally (even a digit).
  if (pendingOp === 'r') {
    if (n === 0 || cursor >= n || input[cursor] === '\n') return ok({ pendingOp: '', count: 0 });
    let to = cursor;
    let cells = 0;
    while (cells < count && to < le && to < n && input[to] !== '\n') {
      const nx = nextGrapheme(input, to);
      if (nx === to) break;
      to = Math.min(nx, le);
      cells++;
    }
    if (cells === 0) return ok({ pendingOp: '', count: 0});
    const result = input.slice(0, cursor) + ch.repeat(cells) + input.slice(to);
    // Caret on the START of the last replaced cluster — code-unit `cursor + cells - 1` lands
    // mid-pair when the replacement char itself is multi-unit (2r😀).
    return ok({ input: result, cursor: cursor + ch.length * (cells - 1), pendingOp: '', count: 0});
  }

  // Numeric prefix: 1-9 start it, 0 extends it (a BARE 0 falls through to the line-start
  // motion / operator motion). Skipped while a find-operator awaits its target char.
  if (pendingOp === '' || pendingOp === 'd' || pendingOp === 'c' || pendingOp === 'y') {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57 && ch.length === 1) {
      const d = code - 48;
      if (d > 0 || pendingCount > 0) {
        const next = pendingCount * 10 + d;
        return ok({ count: next > 9999 ? 9999 : next });
      }
    }
  }

  // A bare f/F/t/T is pending — this key is the target char, whatever it is (including letters
  // that are themselves motions, like `fw`, or digits). Handled before the switch so the target
  // is never reinterpreted as a command.
  if (/^[fFtT]$/.test(pendingOp)) {
    const dir: 1 | -1 = pendingOp === 'f' || pendingOp === 't' ? 1 : -1;
    const till = pendingOp === 't' || pendingOp === 'T';
    let pos: number | null = null;
    let c = cursor;
    let found = 0;
    for (let k = 0; k < count; k++) {
      pos = findInLine(input, c, ls, le, ch, dir, till);
      if (pos === null) break;
      found++;
      c = pos;
    }
    // Fewer than `count` matches — vim beeps and does NOT move (moving to the last partial
    // match silently lands somewhere the count never asked for). lastFind stays unchanged.
    if (found < count) return ok({ pendingOp: '', count: 0});
    return ok({ cursor: pos!, pendingOp: '', lastFind: { target: ch, dir, till }, count: 0});
  }

  // An operator is pending — the next key is its motion.
  if (pendingOp === 'd' || pendingOp === 'c' || pendingOp === 'y') {
    const op = pendingOp;
    const toInsert = op === 'c';
    if (ch === 'f' || ch === 'F' || ch === 't' || ch === 'T') {
      return ok({ pendingOp: op + ch }); // the key AFTER next is the target char
    }
    if (ch === op) {
      // dd/cc/yy — the caret's hard line (not the whole buffer), `count` lines of them. Swallow
      // one adjacent newline so an inner line disappears cleanly: the line's own '\n' when there
      // is one, otherwise the one before it (last line) — vim's line-wise semantics.
      let from = ls;
      let to = le;
      for (let k = 1; k < count; k++) {
        if (to < n) to = lineEnd(input, to + 1);
        else break;
      }
      if (to < n) to += 1;
      else if (from > 0) from -= 1;
      const removed = input.slice(from, to);
      if (op === 'y') return ok({ register: removed, pendingOp: '', count: 0}); // yank never moves the caret
      const result = input.slice(0, from) + input.slice(to);
      return ok({
        input: result,
        cursor: Math.min(from, Math.max(0, result.length - 1)),
        mode: toInsert ? 'insert' : 'normal',
        pendingOp: '',
        register: removed,
        count: 0,
      });
    }
    let from = cursor;
    let to = cursor;
    switch (ch) {
      case 'w':
        // dw never crosses the line break — vim's dw-to-EOL exception. (`w` AS A MOTION still
        // crosses lines; only the operator RANGE stops at the hard-line end.)
        for (let k = 0; k < count; k++) to = Math.min(nextWordStart(input, to), le);
        break;
      case 'e':
        for (let k = 0; k < count; k++) to = wordEnd(input, to) + 1;
        break;
      case 'b':
        for (let k = 0; k < count; k++) from = prevWordStart(input, from);
        break;
      case '$':
        to = le;
        break;
      case '0':
        from = ls;
        break;
      case 'l':
        for (let k = 0; k < count; k++) to = clamp(Math.min(nextGrapheme(input, to), le));
        break;
      case 'h':
        for (let k = 0; k < count; k++) from = clamp(Math.max(ls, prevGrapheme(input, from)));
        break;
      default:
        return ok({ pendingOp: '', count: 0}); // unknown motion — cancel the operator, touch nothing
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const removed = input.slice(lo, hi);
    if (op === 'y') return ok({ register: removed, pendingOp: '', count: 0, cursor: lo });
    const result = input.slice(0, lo) + input.slice(hi);
    // If the delete consumed the line's LAST cell the caret lands on the '\n' (or at
    // end-of-buffer) — heal it back onto the line's new final cell (NORMAL mode parks ON a
    // char). c/insert mode keeps lo — the caret may sit at the line end while typing.
    const caret = toInsert ? lo : Math.max(ls, Math.min(lo, le - (hi - lo) - 1));
    return ok({
      input: result,
      cursor: caret,
      mode: toInsert ? 'insert' : 'normal',
      pendingOp: '',
      register: removed,
      count: 0,
    });
  }

  // A find-operator (df/dF/dt/dT/cf/…) is pending — this key is the target char.
  if (/^[dcy][fFtT]$/.test(pendingOp)) {
    const op = pendingOp[0]!;
    const fch = pendingOp[1]!;
    const dir: 1 | -1 = fch === 'f' || fch === 't' ? 1 : -1;
    const till = fch === 't' || fch === 'T';
    // The count-th match, like the standalone motions.
    let pos: number | null = null;
    let c = cursor;
    let found = 0;
    for (let k = 0; k < count; k++) {
      pos = findInLine(input, c, ls, le, ch, dir, till);
      if (pos === null) break;
      found++;
      c = pos;
    }
    // Fewer than `count` matches (incl. zero) — cancel, touch nothing (vim beeps, no partial).
    if (found < count) return ok({ pendingOp: '', count: 0});
    let from = cursor;
    let to = cursor;
    if (dir === 1) {
      // f deletes THROUGH the WHOLE target (a surrogate pair is 2 code units — pos+1 would
      // slice it and orphan a half); t deletes up to the target's first cell. A forward till
      // pos is the cluster before the match, so the next cluster boundary IS the match start.
      to = clamp(till ? nextGrapheme(input, pos!) : pos! + ch.length);
    } else from = pos!;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const removed = input.slice(lo, hi);
    if (op === 'y') return ok({ register: removed, pendingOp: '', count: 0, cursor: lo });
    const result = input.slice(0, lo) + input.slice(hi);
    // Heal the caret onto the line's new final cell when the delete consumed it (see op-motions).
    const caret = op === 'c' ? lo : Math.max(ls, Math.min(lo, le - (hi - lo) - 1));
    return ok({
      input: result,
      cursor: caret,
      mode: op === 'c' ? 'insert' : 'normal',
      pendingOp: '',
      register: removed,
      count: 0,
    });
  }

  switch (ch) {
    case 'i':
      return ok({ mode: 'insert', count: 0});
    case 'a':
      return ok({ mode: 'insert', cursor: clamp(cursor + 1), count: 0});
    case 'I':
      return ok({ mode: 'insert', cursor: ls, count: 0});
    case 'A':
      return ok({ mode: 'insert', cursor: le, count: 0});
    case 'o': {
      // Open a line BELOW the caret's hard line and drop into INSERT on it.
      const result = input.slice(0, le) + '\n' + input.slice(le);
      return ok({ input: result, cursor: le + 1, mode: 'insert', count: 0});
    }
    case 'O': {
      const result = input.slice(0, ls) + '\n' + input.slice(ls);
      return ok({ input: result, cursor: ls, mode: 'insert', count: 0});
    }
    case 'h': {
      let c = cursor;
      for (let k = 0; k < count; k++) c = clamp(Math.max(ls, prevGrapheme(input, c)));
      return ok({ cursor: c, count: 0});
    }
    case 'l': {
      // NORMAL mode parks the caret ON a character, so the stop is the line's last cell
      // (which also heals a caret transiently sitting on the '\n').
      const stop = Math.max(ls, le - 1);
      let c = cursor;
      for (let k = 0; k < count; k++) c = clamp(Math.min(stop, nextGrapheme(input, c)));
      return ok({ cursor: c, count: 0});
    }
    case '0':
      return ok({ cursor: ls, count: 0});
    case '$':
      return ok({ cursor: Math.max(ls, le - 1), count: 0});
    case 'w': {
      let c = cursor;
      for (let k = 0; k < count; k++) c = nextWordStart(input, c);
      return ok({ cursor: c, count: 0});
    }
    case 'b': {
      let c = cursor;
      for (let k = 0; k < count; k++) c = prevWordStart(input, c);
      return ok({ cursor: c, count: 0});
    }
    case 'e': {
      let c = cursor;
      for (let k = 0; k < count; k++) c = wordEnd(input, c);
      return ok({ cursor: c, count: 0});
    }
    case 'j': {
      let c = cursor;
      for (let k = 0; k < count; k++) c = moveCursorVertical(input, c, 1, innerWidth);
      return ok({ cursor: c, count: 0});
    }
    case 'k': {
      let c = cursor;
      for (let k = 0; k < count; k++) c = moveCursorVertical(input, c, -1, innerWidth);
      return ok({ cursor: c, count: 0});
    }
    case 'f':
    case 'F':
    case 't':
    case 'T':
      // The target is the NEXT key — park the find char as the pending marker (handled above).
      return ok({ pendingOp: ch });
    case ';':
    case ',': {
      const lf = base.lastFind;
      if (!lf) return ok({ count: 0});
      const dir = (ch === ';' ? lf.dir : -lf.dir) as 1 | -1;
      let c = cursor;
      for (let k = 0; k < count; k++) {
        const nxt = findInLine(input, c, ls, le, lf.target, dir, lf.till);
        if (nxt === null || nxt === c) break;
        c = nxt;
      }
      return ok({ cursor: c, count: 0});
    }
    case 'x': {
      // Delete `count` clusters under the caret — never the line break. Fills the register.
      let to = cursor;
      for (let k = 0; k < count && to < le && to < n; k++) to = Math.min(nextGrapheme(input, to), le);
      if (to === cursor) return ok({ count: 0});
      const result = input.slice(0, cursor) + input.slice(to);
      // Deleting the line's final cell would leave the caret on the '\n' (or past the last
      // cell of the last line) — pull it back onto the new last cell of the line.
      const newLe = le - (to - cursor);
      return ok({
        input: result,
        cursor: Math.max(ls, Math.min(cursor, newLe - 1)),
        register: input.slice(cursor, to),
        count: 0,
      });
    }
    case 's': {
      let to = cursor;
      for (let k = 0; k < count && to < le && to < n; k++) to = Math.min(nextGrapheme(input, to), le);
      if (to === cursor) return ok({ mode: 'insert', count: 0});
      return ok({
        input: input.slice(0, cursor) + input.slice(to),
        register: input.slice(cursor, to),
        mode: 'insert',
        count: 0,
      });
    }
    case 'D':
      return ok({ input: input.slice(0, cursor) + input.slice(le), register: input.slice(cursor, le), count: 0});
    case 'C':
      return ok({
        input: input.slice(0, cursor) + input.slice(le),
        register: input.slice(cursor, le),
        mode: 'insert',
        count: 0,
      });
    case 'd':
      return ok({ pendingOp: 'd' });
    case 'c':
      return ok({ pendingOp: 'c' });
    case 'y':
      return ok({ pendingOp: 'y' });
    case 'r':
      return ok({ pendingOp: 'r' });
    case 'p':
    case 'P': {
      const reg = base.register;
      if (!reg) return ok({ count: 0});
      const body = reg.repeat(count);
      if (reg.endsWith('\n')) {
        // Line-wise: paste as whole new lines below (p) or above (P) the caret's line.
        if (ch === 'p') {
          const at = le < n ? le + 1 : le; // after the line's '\n' when it has one
          const result = input.slice(0, at) + body + input.slice(at);
          return ok({ input: result, cursor: Math.min(at, Math.max(0, result.length - 1)), count: 0});
        }
        const result = input.slice(0, ls) + body + input.slice(ls);
        return ok({ input: result, cursor: ls, count: 0});
      }
      if (ch === 'p') {
        // Char-wise: after the cell under the caret (never across the line break).
        const at = clamp(Math.min(nextGrapheme(input, cursor), le));
        const result = input.slice(0, at) + body + input.slice(at);
        // Caret on the START of the last pasted cluster — code-unit `at + len - 1` lands
        // mid-pair for a multi-unit register (p 🎉).
        return ok({ input: result, cursor: prevGrapheme(result, at + body.length), count: 0});
      }
      const result = input.slice(0, cursor) + body + input.slice(cursor);
      return ok({ input: result, cursor: prevGrapheme(result, cursor + body.length), count: 0});
    }
    case 'J': {
      // Join the line below into the caret's line: drop the break + the indent, one space
      // between the halves (vim semantics). `count` joins that many lines.
      // A caret ON a '\n' cell is ambiguous (empty line vs the line's terminator) — vim's
      // empty-line join is benign, so refuse rather than risk splicing the WRONG two lines
      // (le used to read "everything before the caret is the left half" and swallowed both
      // breaks around an empty line).
      if (input[cursor] === '\n') return ok({ count: 0});
      if (le >= n) return ok({ count: 0});
      let buf = input;
      let c = cursor;
      for (let k = 0; k < count; k++) {
        const le2 = lineEnd(buf, c);
        if (le2 >= buf.length) break;
        const left = buf.slice(0, le2).replace(/\s+$/, '');
        let j = le2 + 1;
        while (j < buf.length && (buf[j] === ' ' || buf[j] === '\t')) j++;
        const right = buf.slice(j);
        const joiner = left.length > 0 && right.length > 0 ? ' ' : '';
        buf = left + joiner + right;
        c = Math.min(left.length, Math.max(0, buf.length - 1));
      }
      return ok({ input: buf, cursor: c, count: 0});
    }
    default:
      return ok({ consumed: false }); // unknown key — state untouched
  }
}
