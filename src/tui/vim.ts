/**
 * Minimal vim NORMAL-mode reducer for the composer (enabled via `/vim`).
 *
 * Pure and self-contained so it can be unit-tested without rendering: given the
 * current line, cursor, and pending operator, plus a typed character, it returns
 * the next line/cursor/mode. The composer owns INSERT mode (default behavior) and
 * the ESC→NORMAL transition; this module only interprets NORMAL-mode keys.
 *
 * Supported: motions h l 0 $ w b e; insert switches i a I A; edits x s D C;
 * operators d/c with motions (w b e $ 0 h l) and the doubled forms dd/cc.
 * Counts, registers, marks, visual mode, and multiline ops are intentionally out
 * of scope — the composer is a single editable line.
 */

export type VimMode = 'normal' | 'insert';

export interface VimNormalResult {
  input: string;
  cursor: number;
  mode: VimMode;
  pendingOp: string;
  /** False when `ch` is not a recognized NORMAL-mode key (caller still swallows it). */
  consumed: boolean;
}

// Character class for word motions: 0 = whitespace, 1 = word char, 2 = punctuation.
const charClass = (c: string): 0 | 1 | 2 => (/\s/.test(c) ? 0 : /\w/.test(c) ? 1 : 2);

/** Start of the next word at or after `c` (vim `w`). */
export function nextWordStart(s: string, c: number): number {
  const n = s.length;
  let i = c;
  if (i >= n) return n;
  const k = charClass(s[i]!);
  if (k !== 0) while (i < n && charClass(s[i]!) === k) i++; // skip rest of current token
  while (i < n && charClass(s[i]!) === 0) i++; // skip whitespace
  return i;
}

/** Start of the word before `c` (vim `b`). */
export function prevWordStart(s: string, c: number): number {
  let i = c - 1;
  while (i > 0 && charClass(s[i]!) === 0) i--; // skip whitespace left
  if (i <= 0) return 0;
  const k = charClass(s[i]!);
  while (i > 0 && charClass(s[i - 1]!) === k) i--; // to start of this token
  return Math.max(0, i);
}

/** End of the word at or after `c` (vim `e`). */
export function wordEnd(s: string, c: number): number {
  const n = s.length;
  let i = c + 1;
  while (i < n && charClass(s[i]!) === 0) i++; // skip whitespace
  if (i >= n) return Math.max(c, n - 1);
  const k = charClass(s[i]!);
  while (i + 1 < n && charClass(s[i + 1]!) === k) i++; // to end of this token
  return i;
}

/**
 * Apply one NORMAL-mode character. Special keys (Escape, Enter, arrows, Backspace)
 * are handled by the composer, not here.
 */
export function vimNormalKey(input: string, cursor: number, pendingOp: string, ch: string): VimNormalResult {
  const n = input.length;
  const clamp = (c: number): number => Math.max(0, Math.min(input.length, c));
  const ok = (o: Partial<VimNormalResult>): VimNormalResult => ({
    input,
    cursor: clamp(cursor),
    mode: 'normal',
    pendingOp: '',
    consumed: true,
    ...o,
  });

  // Operator pending (d / c): treat `ch` as a motion and act on the spanned range.
  if (pendingOp === 'd' || pendingOp === 'c') {
    const toInsert = pendingOp === 'c';
    if (ch === pendingOp) return ok({ input: '', cursor: 0, mode: toInsert ? 'insert' : 'normal' }); // dd / cc → whole line
    let from = cursor;
    let to = cursor;
    switch (ch) {
      case 'w': to = nextWordStart(input, cursor); break;
      case 'e': to = wordEnd(input, cursor) + 1; break;
      case 'b': from = prevWordStart(input, cursor); break;
      case '$': to = n; break;
      case '0': from = 0; break;
      case 'l': to = clamp(cursor + 1); break;
      case 'h': from = clamp(cursor - 1); break;
      default:
        return ok({ pendingOp: '' }); // unknown motion cancels the operator
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    return ok({ input: input.slice(0, lo) + input.slice(hi), cursor: lo, mode: toInsert ? 'insert' : 'normal' });
  }

  switch (ch) {
    // Enter INSERT mode.
    case 'i': return ok({ mode: 'insert' });
    case 'a': return ok({ mode: 'insert', cursor: clamp(cursor + 1) });
    case 'I': return ok({ mode: 'insert', cursor: 0 });
    case 'A': return ok({ mode: 'insert', cursor: n });
    // Motions.
    case 'h': return ok({ cursor: clamp(cursor - 1) });
    case 'l': return ok({ cursor: clamp(cursor + 1) });
    case '0': return ok({ cursor: 0 });
    case '$': return ok({ cursor: Math.max(0, n - 1) });
    case 'w': return ok({ cursor: nextWordStart(input, cursor) });
    case 'b': return ok({ cursor: prevWordStart(input, cursor) });
    case 'e': return ok({ cursor: wordEnd(input, cursor) });
    // Edits.
    case 'x': return ok({ input: input.slice(0, cursor) + input.slice(cursor + 1) });
    case 's': return ok({ input: input.slice(0, cursor) + input.slice(cursor + 1), mode: 'insert' });
    case 'D': return ok({ input: input.slice(0, cursor) });
    case 'C': return ok({ input: input.slice(0, cursor), mode: 'insert' });
    // Operators (await a motion).
    case 'd': return ok({ pendingOp: 'd' });
    case 'c': return ok({ pendingOp: 'c' });
    default:
      return { input, cursor, mode: 'normal', pendingOp, consumed: false };
  }
}
