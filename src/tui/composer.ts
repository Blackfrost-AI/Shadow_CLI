// Pure composer-input helpers, split out of tui.tsx so they can be unit-tested without booting Ink.
import { existsSync } from 'node:fs';

/** True if a path exists on disk — lets us tell a real dir/file (/tmp, /etc/hosts) a user pasted or
 *  typed from a genuinely mistyped slash command. Never throws. */
export function pathExistsSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** A leading-'/' token that is a filesystem PATH (a nested '/' or a dot), not a command name — so a
 *  pasted/typed directory like /Users/craigmac/… or /etc/hosts is sent as a message, not rejected as
 *  an "unknown command". A bare /word (/tmp) is disambiguated by an on-disk check at the call site. */
export function isPathLikeSlashToken(token: string): boolean {
  return token.indexOf('/', 1) !== -1 || token.includes('.');
}

/**
 * A paste big enough to condense into a chip rather than dump inline.
 * Multi-line drafts (a few paragraphs) stay editable in the composer; only huge blobs chip.
 * (Was 3 lines / 300 chars — too aggressive for multi-row editing.)
 */
export function isBigPaste(s: string): boolean {
  return (s.match(/\n/g)?.length ?? 0) >= 40 || s.length > 8_000;
}

/** Replace `[Pasted text #N …]` chips with their stored content (the session paste registry), so the
 *  composer stays compact but the model receives the full pasted text on submit. Unmatched chips (a
 *  paste that was cleared) are left as-is. */
export function expandPastes(text: string, pastes: ReadonlyArray<{ id: number; content: string }>): string {
  if (!pastes.length || !text.includes('[Pasted text #')) return text;
  return text.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (m, idStr: string) => {
    const p = pastes.find((x) => x.id === Number(idStr));
    return p ? p.content : m;
  });
}

// ── Multi-row layout / caret ─────────────────────────────────────────────────

/** Max visual rows the composer shows before scrolling the window around the caret. */
export const COMPOSER_MAX_VISIBLE_ROWS = 8;
/** Prefix width of the `❯ ` gutter on the first visual line (continuation lines indent 2). */
export const COMPOSER_GUTTER = 2;

export interface ComposerLayout {
  /** Soft-wrapped visual lines (hard `\n` always breaks). */
  lines: string[];
  /** Source index of the first char of each visual line (length = lines.length + 1 sentinel = text.length). */
  starts: number[];
}

/**
 * Layout `text` into visual rows of at most `innerWidth` columns.
 * Hard newlines always break; long lines soft-wrap at `innerWidth` (char cells, not grapheme-aware).
 */
export function layoutComposer(text: string, innerWidth: number): ComposerLayout {
  const w = Math.max(1, innerWidth | 0);
  const lines: string[] = [];
  const starts: number[] = [];
  // Walk the source, producing visual lines.
  let i = 0;
  const n = text.length;
  if (n === 0) {
    return { lines: [''], starts: [0, 0] };
  }
  while (i < n) {
    starts.push(i);
    // Hard break at \n
    let j = i;
    while (j < n && text[j] !== '\n' && j - i < w) j++;
    if (j < n && text[j] === '\n') {
      // Line is text[i..j) then consume the newline (empty line after is next start)
      lines.push(text.slice(i, j));
      i = j + 1;
      continue;
    }
    if (j - i >= w) {
      // Soft wrap at w (or earlier space if we want word-wrap — char wrap is simpler for caret math)
      lines.push(text.slice(i, i + w));
      i = i + w;
      continue;
    }
    // Rest of buffer (no trailing newline)
    lines.push(text.slice(i, j));
    i = j;
  }
  // Trailing newline → extra empty visual line (caret can sit on it)
  if (n > 0 && text[n - 1] === '\n') {
    starts.push(n);
    lines.push('');
  }
  starts.push(n); // sentinel
  return { lines, starts };
}

/** Map a source cursor index to a visual (row, col) within the layout. */
export function cursorToRowCol(text: string, cursor: number, innerWidth: number): { row: number; col: number } {
  const c = Math.max(0, Math.min(text.length, cursor));
  const { lines, starts } = layoutComposer(text, innerWidth);
  // Find last start <= c
  let row = 0;
  for (let r = 0; r < lines.length; r++) {
    if (starts[r]! <= c) row = r;
    else break;
  }
  return { row, col: c - starts[row]! };
}

/** Map a visual (row, col) back to a source cursor index. */
export function rowColToCursor(text: string, row: number, col: number, innerWidth: number): number {
  const { lines, starts } = layoutComposer(text, innerWidth);
  if (lines.length === 0) return 0;
  const r = Math.max(0, Math.min(lines.length - 1, row));
  const lineLen = lines[r]!.length;
  const c = Math.max(0, Math.min(lineLen, col));
  return starts[r]! + c;
}

/** Move the caret up/down one visual row, preserving column when possible. */
export function moveCursorVertical(
  text: string,
  cursor: number,
  dir: -1 | 1,
  innerWidth: number,
): number {
  const { row, col } = cursorToRowCol(text, cursor, innerWidth);
  const { lines } = layoutComposer(text, innerWidth);
  const next = row + dir;
  if (next < 0 || next >= lines.length) return cursor; // no move (caller may do history)
  return rowColToCursor(text, next, col, innerWidth);
}

/** True when the caret is on the first visual row (↑ may fall through to history). */
export function cursorOnFirstRow(text: string, cursor: number, innerWidth: number): boolean {
  return cursorToRowCol(text, cursor, innerWidth).row === 0;
}

/** True when the caret is on the last visual row (↓ may fall through to history). */
export function cursorOnLastRow(text: string, cursor: number, innerWidth: number): boolean {
  const { row } = cursorToRowCol(text, cursor, innerWidth);
  const { lines } = layoutComposer(text, innerWidth);
  return row >= lines.length - 1;
}

/**
 * Which slice of visual lines to paint when the draft is taller than maxVisible.
 * Always keeps the caret row on-screen.
 */
export function visibleComposerWindow(
  text: string,
  cursor: number,
  innerWidth: number,
  maxVisible: number = COMPOSER_MAX_VISIBLE_ROWS,
): { lines: string[]; starts: number[]; offset: number; caretRow: number; caretCol: number } {
  const layout = layoutComposer(text, innerWidth);
  const { row, col } = cursorToRowCol(text, cursor, innerWidth);
  const total = layout.lines.length;
  const maxV = Math.max(1, maxVisible);
  let offset = 0;
  if (total > maxV) {
    // Center-ish: keep caret in window
    offset = Math.min(Math.max(0, row - Math.floor(maxV / 2)), total - maxV);
  }
  const end = Math.min(total, offset + maxV);
  return {
    lines: layout.lines.slice(offset, end),
    starts: layout.starts.slice(offset, end + 1),
    offset,
    caretRow: row - offset,
    caretCol: col,
  };
}

/**
 * Map a click in the composer paint box to a source cursor.
 * `localRow` / `localCol` are 0-based inside the multi-line field (col is after the gutter on every row).
 * `windowOffset` is the first visible visual row index.
 */
export function clickToCursor(
  text: string,
  localRow: number,
  localCol: number,
  innerWidth: number,
  windowOffset = 0,
): number {
  const absRow = windowOffset + Math.max(0, localRow);
  return rowColToCursor(text, absRow, Math.max(0, localCol), innerWidth);
}

/**
 * Parse an SGR mouse event (CSI < Pb ; Px ; Py M/m). Returns null if `raw` is not one.
 * Coordinates are 1-based cell positions as reported by the terminal.
 *
 * NOTE the leading ESC is OPTIONAL: Ink strips a chunk-leading \x1b before the handler sees it
 * (use-input.js), so a click that arrives in its own stdin read reads as `[<0;12;30M`. Matching
 * only the ESC form is what made click-to-caret dead code for the whole 3.x line.
 */
export function parseSgrMouse(raw: string): { button: number; x: number; y: number; press: boolean } | null {
  // May be embedded in a longer paste/batch — find the last complete event.
  const re = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(raw)) !== null) last = m;
  if (!last) return null;
  return {
    button: Number(last[1]),
    x: Number(last[2]),
    y: Number(last[3]),
    press: last[4] === 'M',
  };
}

/** True when `raw` carries an SGR mouse report (with or without Ink's stripped leading ESC). */
export function hasSgrMouse(raw: string): boolean {
  return /\x1b?\[<\d+;\d+;\d+[Mm]/.test(raw);
}

/** Strip every SGR mouse report out of a chunk, so a report glued to typed text can't insert garbage. */
export function stripSgrMouse(raw: string): string {
  return raw.replace(/\x1b?\[<\d+;\d+;\d+[Mm]/g, '');
}

// ── Word / line motion + kills (readline + macOS Option-key semantics) ────────
//
// One shared definition of a "word" for every motion and kill, so Option+←, Option+Delete and
// Ctrl+W all agree: a run of word chars (letters/digits/_) OR a run of punctuation, with any
// whitespace on the leading side absorbed. That is what makes `src/tui/composer.ts` peel off as
// `ts` → `.` → `composer` → `/` … the way it does in every native macOS text field.

const WS = /\s/;
const WORD = /[\p{L}\p{N}_]/u;

/** True for a "word" character (letter, digit or underscore — Unicode-aware). */
export function isWordChar(c: string | undefined): boolean {
  return !!c && WORD.test(c);
}

const clampIdx = (text: string, i: number): number => Math.max(0, Math.min(text.length, i | 0));

/** Start of the word to the LEFT of the caret (Option/Alt+←, Ctrl+W target). */
export function wordLeft(text: string, cursor: number): number {
  let i = clampIdx(text, cursor);
  while (i > 0 && WS.test(text[i - 1]!)) i--; // absorb whitespace before the word
  if (i === 0) return 0;
  const inWord = isWordChar(text[i - 1]);
  while (i > 0 && !WS.test(text[i - 1]!) && isWordChar(text[i - 1]) === inWord) i--;
  return i;
}

/** End of the word to the RIGHT of the caret (Option/Alt+→, Option+D target). */
export function wordRight(text: string, cursor: number): number {
  const n = text.length;
  let i = clampIdx(text, cursor);
  while (i < n && WS.test(text[i]!)) i++;
  if (i >= n) return n;
  const inWord = isWordChar(text[i]);
  while (i < n && !WS.test(text[i]!) && isWordChar(text[i]) === inWord) i++;
  return i;
}

/** Index of the first char of the caret's HARD line (Ctrl+A / Home). */
export function lineStart(text: string, cursor: number): number {
  const i = clampIdx(text, cursor);
  // Guard i === 0 explicitly: lastIndexOf clamps a negative fromIndex to 0, so on a draft that
  // BEGINS with a newline it would find that newline and report line start 1 for cursor 0.
  if (i === 0) return 0;
  return text.lastIndexOf('\n', i - 1) + 1;
}

/** Index just past the last char of the caret's HARD line (Ctrl+E / End). */
export function lineEnd(text: string, cursor: number): number {
  const i = clampIdx(text, cursor);
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl;
}

/** Result of an editing operation: the new buffer, the new caret, and what was removed (kill ring). */
export interface EditResult {
  text: string;
  cursor: number;
  /** Removed text, for the Ctrl+Y kill ring. Empty when the edit was a no-op. */
  killed: string;
}

const cut = (text: string, from: number, to: number): EditResult => {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  return { text: text.slice(0, a) + text.slice(b), cursor: a, killed: text.slice(a, b) };
};

/** Option/Alt+Delete, Ctrl+W — delete the word before the caret. */
export function deleteWordLeft(text: string, cursor: number): EditResult {
  const c = clampIdx(text, cursor);
  return cut(text, wordLeft(text, c), c);
}

/** Option/Alt+D, Ctrl+Delete — delete the word after the caret. */
export function deleteWordRight(text: string, cursor: number): EditResult {
  const c = clampIdx(text, cursor);
  return cut(text, c, wordRight(text, c));
}

/** Ctrl+K — kill from the caret to the end of the line (or, at a line end, the newline itself). */
export function killToLineEnd(text: string, cursor: number): EditResult {
  const c = clampIdx(text, cursor);
  const e = lineEnd(text, c);
  return cut(text, c, e === c && text[c] === '\n' ? c + 1 : e);
}

/** Ctrl+U — kill from the start of the line to the caret. */
export function killToLineStart(text: string, cursor: number): EditResult {
  const c = clampIdx(text, cursor);
  return cut(text, lineStart(text, c), c);
}

// ── Grapheme-safe single-character motion ────────────────────────────────────
// Indexing by UTF-16 code unit splits an emoji (or a flag, or an accented cluster) in half: one
// Backspace after 😀 left a LONE SURROGATE in the draft, which paints as a replacement glyph,
// shifts every later caret index, and gets sent to the provider on submit. Intl.Segmenter is in
// Node 18+ with no dependency; the code-unit path stays as the fallback.

const segmenter: { segment(s: string): Iterable<{ index: number; segment: string }> } | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new (Intl as unknown as { Segmenter: new (l?: string, o?: object) => never }).Segmenter(undefined, {
        granularity: 'grapheme',
      })
    : null;

/** Index of the start of the grapheme cluster ending at `cursor` (one visual char to the left). */
export function prevGrapheme(text: string, cursor: number): number {
  const c = clampIdx(text, cursor);
  if (c === 0) return 0;
  if (!segmenter) return c - 1;
  let start = c - 1;
  for (const g of segmenter.segment(text.slice(0, c))) {
    if (g.index < c) start = g.index;
  }
  return start;
}

/** Index just past the grapheme cluster starting at `cursor` (one visual char to the right). */
export function nextGrapheme(text: string, cursor: number): number {
  const c = clampIdx(text, cursor);
  if (c >= text.length) return text.length;
  if (!segmenter) return c + 1;
  for (const g of segmenter.segment(text.slice(c))) {
    return c + g.segment.length; // the first cluster from the caret
  }
  return c + 1;
}

/** Backspace — delete the visual character before the caret (never half an emoji). */
export function deleteCharLeft(text: string, cursor: number): EditResult {
  const c = clampIdx(text, cursor);
  return c === 0 ? { text, cursor: c, killed: '' } : cut(text, prevGrapheme(text, c), c);
}

/** Ctrl+D / forward-delete — delete the visual character after the caret. */
export function deleteCharRight(text: string, cursor: number): EditResult {
  const c = clampIdx(text, cursor);
  return c >= text.length ? { text, cursor: c, killed: '' } : cut(text, c, nextGrapheme(text, c));
}
