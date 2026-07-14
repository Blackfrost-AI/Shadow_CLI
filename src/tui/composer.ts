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
 */
export function parseSgrMouse(raw: string): { button: number; x: number; y: number; press: boolean } | null {
  // May be embedded in a longer paste/batch — find the last complete event.
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
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
