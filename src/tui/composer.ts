// Pure composer-input helpers, split out of tui.tsx so they can be unit-tested without booting Ink.
import { existsSync } from 'node:fs';
import { displayWidth, nextCluster } from '../util/width.js';

// Re-exported: the composer was the first caller of displayWidth and every existing import points
// here. The implementation now lives in width.ts so the transcript flattener measures identically —
// two independent width tables is exactly how the CJK truncation bug survived.
export { displayWidth };

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

/** Cap on the session paste registry (F02-06). Chip contents park here until submit, and entries
 *  whose chip was DELETED from the draft used to linger for the rest of the session — a slow
 *  memory leak in long sessions. Pruning drops only UNREFERENCED entries, and only above the cap. */
export const PASTE_CAP = 64;

/** True when any of `texts` still carries the chip for paste entry `id` (`[Pasted text #N …]`). */
export function pasteChipReferenced(id: number, ...texts: string[]): boolean {
  const needle = `[Pasted text #${id} `;
  return texts.some((t) => t.includes(needle));
}

/** F02-06: above `cap`, drop paste entries no draft/queue text references. Referenced entries are
 *  ALWAYS kept (their content is owed at submit), so the cap is soft by exactly the number of live
 *  chips — the leak was the unreferenced tail, and that is what this removes. */
export function prunePastes<T extends { id: number }>(
  pastes: T[],
  texts: ReadonlyArray<string>,
  cap: number = PASTE_CAP,
): T[] {
  if (pastes.length <= cap) return pastes;
  return pastes.filter((p) => pasteChipReferenced(p.id, ...texts));
}

/** F02-06: after a task was spliced via expandPastes, drop the entries the SUBMITTED text carried —
 *  they are consumed; keeping them would re-leak exactly what submit just spent. */
export function dropConsumedPastes<T extends { id: number }>(pastes: T[], submitted: string): T[] {
  if (!submitted.includes('[Pasted text #')) return pastes;
  return pastes.filter((p) => !pasteChipReferenced(p.id, submitted));
}

// ── Multi-row layout / caret ─────────────────────────────────────────────────
//
// Wrapping by UTF-16 code unit made every CJK/emoji row overrun the box: `layoutComposer('你好…', 10)`
// returned rows of 10 CHARACTERS = 20 terminal columns, so Ink truncated them and the caret drifted
// by up to 2× across the row. Measurement lives in `./width.js`.

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
 * Layout `text` into visual rows of at most `innerWidth` COLUMNS (not characters).
 *
 * Hard newlines always break; long lines soft-wrap when the next grapheme cluster would exceed
 * the width. Wrapping used to count UTF-16 code units, so a CJK row carried `innerWidth`
 * characters = 2× that many columns, overran the box, and got truncated by Ink while the caret
 * drifted. `starts` remains a list of SOURCE indices, so every caller that maps a cursor through
 * this layout is unaffected.
 *
 * Word-aware (the "world-class entry bar" pass): when a cluster overflows mid-word, the row backs
 * off to just past the last space that fits, so prose breaks at spaces exactly like the transcript
 * (flatten's wrapSpansWord) instead of splitting `multimedia` into `multim/edia`. The break space
 * stays at the end of the earlier row (invisible when painted) so `starts` stay plain source
 * indices and cursor mapping is unchanged. No space behind → hard-split as before; a row that is
 * entirely indentation also hard-splits (a wrap point must not eat the indent); a single cluster
 * wider than the whole row is still emitted alone.
 */
export function layoutComposer(text: string, innerWidth: number): ComposerLayout {
  const w = Math.max(1, innerWidth | 0);
  const lines: string[] = [];
  const starts: number[] = [];
  const n = text.length;
  if (n === 0) return { lines: [''], starts: [0, 0] };

  let i = 0;
  while (i < n) {
    starts.push(i);
    let width = 0;
    let j = i;
    let lastBreak = -1; // absolute index just past the last space run that FITS — a legal wrap point
    while (j < n && text[j] !== '\n') {
      // Advance a whole grapheme cluster at a time — a wrap must never land inside one.
      const cluster = nextCluster(text, j);
      const cw = displayWidth(cluster);
      if (width + cw > w && j > i) {
        // The cluster would overflow. Break after the last space instead of inside the word —
        // unless everything before it is whitespace (that "space" is indentation, not a wrap point).
        if (lastBreak > i && !/^\s+$/.test(text.slice(i, lastBreak))) j = lastBreak;
        break;
      }
      width += cw;
      j += cluster.length;
      if (/\s/.test(cluster)) lastBreak = j;
      if (width >= w) {
        // Exactly full. If the row CONTINUES with a word char, this break lands mid-word — the
        // cluster after the margin belongs to the word we just finished. Back off to the last
        // space (same guard as the overflow branch: an all-space prefix is indent, not a point).
        const nx = j < n ? text[j] : '';
        if (nx && nx !== '\n' && !/\s/.test(nx) && lastBreak > i && !/^\s+$/.test(text.slice(i, lastBreak))) {
          j = lastBreak;
        }
        break;
      }
    }
    if (j < n && text[j] === '\n') {
      lines.push(text.slice(i, j));
      i = j + 1;
      continue;
    }
    lines.push(text.slice(i, j));
    i = j;
  }
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

/** Move the caret up/down one visual row, preserving column when possible. `goalCol` (optional,
 *  source-unit column) overrides the caret's own column — the goal-column memory behind a run of
 *  ↑/↓ keys: passing over a SHORT row clamps the caret, and without the memory the next move
 *  would aim from the clamp instead of the column the run started from (readline semantics). */
export function moveCursorVertical(
  text: string,
  cursor: number,
  dir: -1 | 1,
  innerWidth: number,
  goalCol?: number,
): number {
  const { row, col } = cursorToRowCol(text, cursor, innerWidth);
  const { lines } = layoutComposer(text, innerWidth);
  const next = row + dir;
  if (next < 0 || next >= lines.length) return cursor; // no move (caller may do history)
  return rowColToCursor(text, next, goalCol ?? col, innerWidth);
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

/** True when the inverse caret cell cannot paint INLINE at the caret position: the caret row
 *  exactly fills the width, so the cell would sit one column past the box's last column — and
 *  Ink's `wrap="truncate"` cuts from the RIGHT, meaning the cell it deletes is the caret itself.
 *  That was "type a full row and the caret vanishes". Instead the row paints plain and the caret
 *  gets its own row below (see composerPaintRows, which yields the window row for it). */
export function caretNeedsOwnRow(line: string, caretCol: number, innerWidth: number): boolean {
  return caretCol >= line.length && displayWidth(line) >= innerWidth;
}

/** Rows of composer input that will actually PAINT for this draft — the shared number behind both
 *  the Composer component and the caller's frame budget (fitHud's composerInputRows), so what the
 *  layout counts is what lands on screen. Normally the visible window (min(maxRows, total rows)).
 *  When the caret needs its own row: below the cap the caret row rides on top (window + 1, still
 *  ≤ maxRows); AT the cap the window yields one row to host it, so the height never exceeds
 *  maxRows. The Composer component's shrink condition (window at cap) mirrors this exactly. */
export function composerPaintRows(
  text: string,
  cursor: number,
  innerWidth: number,
  maxRows: number,
): number {
  const { lines } = layoutComposer(text, innerWidth);
  const total = Math.max(1, lines.length);
  const cap = Math.max(1, maxRows);
  const win = Math.min(cap, total);
  const { row, col } = cursorToRowCol(text, cursor, innerWidth);
  const line = lines[Math.min(row, total - 1)] ?? '';
  if (!caretNeedsOwnRow(line, col, innerWidth)) return win;
  if (win === cap && win > 1) return win; // window yields one row for the caret → net unchanged
  return win + 1; // floor (win 1) or uncapped (total < maxRows): caret row painted on top
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
  const { lines, starts } = layoutComposer(text, innerWidth);
  if (!lines.length) return 0;
  const r = Math.max(0, Math.min(lines.length - 1, absRow));
  // A click reports a DISPLAY column; `starts` are SOURCE indices. On an ASCII row those are the
  // same number, which is why this was invisible — but one wide character ahead of the click and
  // the caret lands a cell late for every column after it. Walk the row by cluster, accumulating
  // width, and stop at the first cluster that reaches the clicked column.
  const line = lines[r]!;
  const want = Math.max(0, localCol);
  let width = 0;
  let off = 0;
  while (off < line.length && width < want) {
    const cluster = nextCluster(line, off);
    const cw = displayWidth(cluster);
    if (width + cw > want) break; // the click landed on the LEFT half of a wide cluster
    width += cw;
    off += cluster.length;
  }
  return starts[r]! + off;
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

/**
 * End index (exclusive) of the ESC-led sequence at the START of `s` (s[0] === ESC), or -1 when
 * the sequence is incomplete/garbage. CSI runs params (0x20–0x3f) to a final byte (0x40–0x7e);
 * OSC runs to BEL or ESC\; SS3 (ESC O letter) is three bytes; anything else is ESC + one byte.
 */
function keySeqEnd(s: string): number {
  if (s.length === 1) return 1; // bare ESC
  const second = s.charCodeAt(1);
  if (second === 0x1b) return 1; // ESC ESC — a bare ESC; the next sequence starts at the second one
  if (second === 0x5b /* [ — CSI */) {
    for (let i = 2; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i + 1; // final byte closes the sequence
      if (c >= 0x20 && c <= 0x3f) continue; // parameter / intermediate byte
      return -1; // a byte that belongs to no CSI sequence — treat the rest as garbage
    }
    return -1; // incomplete CSI
  }
  if (second === 0x5d /* ] — OSC */) {
    const bel = s.indexOf('\x07', 2);
    const st = s.indexOf('\x1b\\', 2);
    if (bel >= 0 && (st < 0 || bel < st)) return bel + 1;
    if (st >= 0) return st + 2;
    return -1; // incomplete OSC
  }
  if (second === 0x4f || second === 0x4e /* O/N — SS3 */) return Math.min(3, s.length); // ESC O <letter>
  if (second >= 0x20 && second <= 0x2f) {
    // ESC <intermediate bytes> <final byte> — e.g. the charset designator ESC ( B.
    let i = 2;
    while (i < s.length && s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x2f) i++;
    if (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x7e) return i + 1;
    return -1; // incomplete designator
  }
  return Math.min(2, s.length); // two-byte sequence (ESC =, ESC \x7f, …)
}

/**
 * F03-05 — the raw keypress tap sees WHOLE stdin chunks, and terminals batch keypresses into one
 * read (a held arrow repeats as '\x1b[D\x1b[D\x1b[D'; Home lands in the same read as the key
 * pressed right after it). Ink's parser dispatches the FIRST keypress of a merged chunk and drops
 * the rest, while the composer's raw-sequence tests (HOME_KEYS, END_KEYS, FORWARD_DELETE,
 * SHIFT_ENTER, DSR_REPLY_EXACT) are ^…$ anchored and only match a chunk holding EXACTLY one
 * sequence — so any batch silently killed those keys. Split the chunk on ESC boundaries and
 * return the LAST complete ESC-led sequence (trimmed of trailing plain text belonging to the
 * next, already-dropped keypress), or the chunk itself when it carries no ESC, so the most
 * recent key is the one the disambiguation tests see. Pure and total — never throws.
 */
export function lastKeySequence(raw: string): string {
  let last = '';
  let i = raw.indexOf('\x1b');
  while (i >= 0) {
    const seq = raw.slice(i);
    const end = keySeqEnd(seq);
    if (end <= 0) return seq; // incomplete tail — keep it as-is (matches nothing, hurts nothing)
    last = seq.slice(0, end);
    i = raw.indexOf('\x1b', i + end); // the walk consumes an OSC's ESC-\ terminator whole
  }
  return last || raw;
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

// ── Reverse history search (Ctrl+R) ──────────────────────────────────────────

export interface HistorySearchState {
  /** What the user has typed into the search prompt. */
  query: string;
  /** Index into `history` of the current hit, or -1 when nothing matches. */
  index: number;
  /** The draft that was on screen when the search opened — restored on Esc. */
  saved: string;
}

/**
 * Find the most recent history entry at or before `from` containing `query` (case-insensitive).
 * Returns -1 when there is no match. Searching BACKWARDS is the readline contract: Ctrl+R walks
 * from newest to oldest, and pressing it again steps to the next older hit.
 */
export function searchHistoryBack(history: readonly string[], query: string, from: number): number {
  if (!query) return -1;
  const q = query.toLowerCase();
  for (let i = Math.min(from, history.length - 1); i >= 0; i--) {
    if ((history[i] ?? '').toLowerCase().includes(q)) return i;
  }
  return -1;
}

/** The prompt line shown while a reverse search is open — mirrors bash/readline. */
export function historySearchPrompt(st: HistorySearchState, history: readonly string[]): string {
  const hit = st.index >= 0 ? (history[st.index] ?? '') : '';
  const failed = st.query && st.index < 0 ? 'failed ' : '';
  return `(${failed}reverse-i-search)\`${st.query}': ${hit}`;
}
