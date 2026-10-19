/**
 * Streaming-aware markdown → block AST for the chat canvas. Pure (no Ink): the TUI
 * maps these blocks to Ink elements, and tests assert the AST directly. Designed to
 * be re-run on a GROWING buffer each stream flush, so it tolerates a partial tail —
 * notably an unterminated code fence renders as an open code block (closed: false)
 * rather than swallowing the rest of the answer.
 *
 * Scope is deliberately the 90% of what chat models emit: headings, paragraphs,
 * bold/italic/inline-code, links, bullet/ordered lists, blockquotes, fenced code,
 * and horizontal rules. Tables fall through to paragraphs for now.
 */

// F05-07: width measurement lives in ONE table (util/width.ts). The local charWidth/visibleWidth
// copies that used to sit here had drifted (no Ext-B wide, no ZWSP, no grapheme clustering) and
// made table borders disagree with the transcript's own row measurement.
import { chunksByWidth, displayWidth } from './width.js';

export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** The " (url)" tail of a link — rendered dim so the URL recedes behind the label. */
  link?: boolean;
  /** The [label] of a link — rendered in the link accent so it reads as a link, not prose. */
  linkLabel?: boolean;
  /** The link target URL (on the label span). Lets the renderer wrap the label as an OSC 8
   *  hyperlink when the terminal supports it — the URL is then the click target, not shown text. */
  url?: string;
}

export type MdBlock =
  | { type: 'heading'; level: number; spans: MdSpan[] }
  | { type: 'paragraph'; spans: MdSpan[] }
  | { type: 'code'; lang: string; code: string; closed: boolean }
  | {
      type: 'list';
      ordered: boolean;
      items: MdSpan[][];
      start?: number;
      depths?: number[];
      /** Per-item orderedness. A list block is a FLAT array of items with a parallel `depths`,
       *  so one block-level `ordered` flag cannot describe a numbered sub-list inside an
       *  unordered one. Present only when it differs from `ordered` or the list is nested. */
      orderedItems?: boolean[];
      /** Per-item display ordinal (0 for bullets), so nested ordered items keep their numbers. */
      ordinals?: number[];
    }
  | { type: 'quote'; spans: MdSpan[] }
  | { type: 'table'; align: TableAlign[]; header: MdSpan[][]; rows: MdSpan[][][] }
  | { type: 'rule' };

/** `auto` = bare `---` separator (no colons): resolved at render time — numeric columns
 *  right-align like a ledger, text columns stay left. Explicit `:---`/`---:`/`:--:` win. */
export type TableAlign = 'left' | 'center' | 'right' | 'auto';

// Exported: the streaming committer (extractCommittableUnits in tui.tsx) must use the EXACT same
// line classifications as this parser — re-implemented copies drifted (looser fence opens, trimmed
// list tests) and made streamed output disagree with the non-streamed render of the same text.
export const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
// CommonMark fence classification (P1A-13) — the SINGLE shared implementation that every
// open/close decision in the streaming pipeline must use so none of them can drift. Unlike the
// legacy `FENCE` above (which matches with ANY leading spaces), a legal fence opener is indented
// at most 3 spaces — a ≥4-space-indented line is an indented code block, not a fence.
export interface FenceMarker {
  char: '`' | '~';
  width: number;
  lang: string;
}
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
/** Classify a line as a legal markdown code-fence marker, or null if it is not one.
 *  A fence line requires ≤3 leading spaces and ≥3 identical ticks (`` ` `` or `~`). */
export function matchFence(line: string): FenceMarker | null {
  const m = FENCE_LINE.exec(line);
  if (!m) return null;
  const marker = m[1]!;
  return { char: marker[0]! as '`' | '~', width: marker.length, lang: m[2] ?? '' };
}
/** CommonMark fence-close rule: a line closes a fence only if it is a fence of the SAME marker
 *  char with width ≥ the opener's width. A 4-tick fence therefore cannot be closed by a 3-tick
 *  line inside it (exactly what frontier models emit when writing about nested markdown), and a
 *  ``` inside a ~~~ block (or vice versa) is literal content. */
export function closesFence(line: string, open: Pick<FenceMarker, 'char' | 'width'>): boolean {
  const m = matchFence(line);
  return m !== null && m.char === open.char && m.width >= open.width;
}
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
export const QUOTE = /^\s*>/;
export const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const LIST_ORDERED = /^\s*\d+[.)]\s+/;

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line)
  );
}

/** Parse inline emphasis/code/links within a single logical text run. */
export function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  const push = (t: string, fmt: Partial<MdSpan> = {}): void => {
    if (t) spans.push({ text: t, ...fmt });
  };
  // code first (so ** inside `code` is literal), then bold, then italic, then links. Links are kept
  // as a span pair — the label (styled normally) + a dim " (url)" tail — instead of being flattened
  // to plain "label (url)" text, so the URL can recede visually.
  const re = /(`+)([\s\S]+?)\1|(\*\*|__)([\s\S]+?)\3|(\*|_)([\s\S]+?)\5|\[([^\]]+)\]\(([^)\s]+)\)/;
  let rest = text;
  for (;;) {
    const m = re.exec(rest);
    if (!m) {
      push(rest);
      break;
    }
    if (m.index > 0) push(rest.slice(0, m.index));
    if (m[1]) push(m[2]!, { code: true });
    else if (m[3]) push(m[4]!, { bold: true });
    else if (m[5]) push(m[6]!, { italic: true });
    else {
      push(m[7]!, { linkLabel: true, url: m[8] }); // link label — link accent; url carried for OSC 8
      push(` (${m[8]})`, { link: true }); // dim URL tail
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return spans.length ? spans : [{ text: '' }];
}

/**
 * Word-wrap a span array to `width` visible columns, TRIMMING the whitespace at each wrap point so
 * every wrapped line renders flush-left. We can't lean on Ink's own wrapping: Ink 5 calls wrap-ansi
 * with `trim:false`, which leaks the wrap-point space onto the next line (the "not flush" look).
 * Whitespace (including source newlines) collapses to a single space, so a hard-wrapped paragraph
 * reflows like the reference client. Inline formatting is preserved per word; a single word wider than `width`
 * is emitted whole rather than split (so URLs / code tokens aren't mangled). Always returns ≥ 1 line.
 */
export function wrapSpans(spans: MdSpan[], width: number): MdSpan[][] {
  if (!Number.isFinite(width) || width <= 0) return [spans];
  const lines: MdSpan[][] = [];
  let line: MdSpan[] = [];
  let w = 0;
  const dropTrailingSpace = (): void => {
    if (line.length && line[line.length - 1]!.text === ' ') line.pop();
  };
  for (const span of spans) {
    const fmt = { bold: span.bold, italic: span.italic, code: span.code };
    for (const tok of span.text.split(/(\s+)/)) {
      if (tok === '') continue;
      if (/^\s+$/.test(tok)) {
        if (w > 0) {
          line.push({ text: ' ', ...fmt }); // collapse any run to one space; never at line start
          w += 1;
        }
        continue;
      }
      const tw = displayWidth(tok);
      if (w > 0 && w + tw > width) {
        dropTrailingSpace();
        lines.push(line);
        line = [];
        w = 0;
      }
      line.push({ text: tok, ...fmt });
      w += tw;
    }
  }
  dropTrailingSpace();
  lines.push(line);
  return lines;
}

/** Parse a (possibly still-streaming) markdown string into a block list. */
export function parseMarkdown(src: string): MdBlock[] {
  // Normalize CRLF: a trailing \r defeated the anchored block regexes (HEADING's `(.*)$` cannot
  // cross \r), so CRLF answers rendered headings/rules as literal paragraph text.
  const lines = src.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    const openFence = matchFence(line);
    if (openFence) {
      const lang = openFence.lang;
      const code: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i]!;
        if (closesFence(l, openFence)) {
          closed = true;
          i++;
          break;
        }
        code.push(l);
        i++;
      }
      blocks.push({ type: 'code', lang, code: code.join('\n'), closed });
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1]!.length, spans: parseInline(h[2]!.trim()) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const q: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        q.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', spans: parseInline(q.join('\n')) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const ordered = LIST_ORDERED.test(line);
      // Preserve the SOURCE start number: models often blank-separate numbered steps, which
      // parses each step as its own list — renumbering every block from 1 turned "1. 2. 3." into
      // "1. 1. 1." in the transcript. GFM renderers honor the first item's number; so do we.
      const start = ordered ? parseInt(/\d+/.exec(line)![0]!, 10) : undefined;
      const items: MdSpan[][] = [];
      const depths: number[] = [];
      // Per-item marker info. The block-level `ordered` flag comes from the FIRST item only, so a
      // numbered sub-list nested inside a bullet list (or vice versa) was unrepresentable: every
      // depth>0 item rendered as a bullet and the source numbering `1. 2.` was thrown away. A
      // numbered procedure therefore read as a plain bulleted list.
      const orderedItems: boolean[] = [];
      const ordinals: number[] = [];
      // Counters per depth, so each nested level numbers independently (1,2,3 at depth 1 while
      // the parent is at 5).
      const counters = new Map<number, number>();
      while (i < lines.length && LIST_ITEM.test(lines[i]!)) {
        const raw = lines[i]!;
        // Nesting depth from leading indentation (2 spaces per level, capped) — so `  - sub` renders
        // one level in from `- top` instead of collapsing to the same margin.
        const indent = raw.length - raw.replace(/^\s*/, '').length;
        const depth = Math.min(4, Math.floor(indent / 2));
        depths.push(depth);
        const isOrdered = LIST_ORDERED.test(raw);
        orderedItems.push(isOrdered);
        if (isOrdered) {
          const n = parseInt(/\d+/.exec(raw)![0]!, 10);
          // Trust an explicit start number the first time a depth is seen (GFM behavior), then
          // increment. Models do write `3.` to continue a list after an interrupting block.
          counters.set(depth, counters.has(depth) && n === 1 ? counters.get(depth)! + 1 : n);
          ordinals.push(counters.get(depth)!);
        } else {
          ordinals.push(0);
        }
        items.push(parseInline(raw.replace(LIST_ITEM, '')));
        i++;
      }
      const nested = depths.some((d) => d > 0);
      // Only carry the per-item arrays when they actually differ from the block-level default —
      // keeps the common flat-list AST identical to before (and cheap to compare in tests).
      const mixedMarkers = orderedItems.some((o) => o !== ordered);
      blocks.push({
        type: 'list',
        ordered,
        items,
        ...(start !== undefined && start !== 1 ? { start } : {}),
        ...(nested ? { depths } : {}),
        ...(nested || mixedMarkers ? { orderedItems } : {}),
        ...(nested || mixedMarkers ? { ordinals } : {}),
      });
      continue;
    }

    // GFM table: a header row of `|`-separated cells immediately followed by a
    // `|---|---|` separator line. Cells may contain inline markdown; escaped pipes
    // `\|` are honored so a literal pipe in a cell doesn't split it.
    const table = tryParseTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    // Paragraph: gather consecutive lines until a blank line, a new block start, or a TABLE header
    // (a pipe line whose NEXT line is a separator — without this lookahead, "Here are the results:"
    // directly followed by a table swallowed the whole table into the paragraph as literal pipes).
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !isBlockStart(lines[i]!) &&
      !(lines[i]!.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!))
    ) {
      para.push(lines[i]!);
      i++;
    }
    if (para.length === 0) {
      // The very first line is a table header (lookahead hit immediately) — parse it as a table.
      const t = tryParseTable(lines, i);
      if (t) {
        blocks.push(t.block);
        i = t.next;
        continue;
      }
      para.push(lines[i]!); // degenerate: pipe line with a separator-looking next line but no table
      i++;
    }
    blocks.push({ type: 'paragraph', spans: parseInline(para.join('\n')) });
  }

  return blocks;
}

// ── GFM tables ────────────────────────────────────────────────────────────────

/** Split a `| a | b |` row into trimmed cells, honoring `\|` escapes and backtick code spans. */
function splitTableRow(line: string): string[] {
  const placeholder = '\u0000PIPE\u0000';
  const unescaped = line.replace(/\\\|/g, placeholder);
  let inner = unescaped.trim();
  // Strip one leading + one trailing pipe if present.
  inner = inner.replace(/^\|/, '').replace(/\|$/, '');
  // A pipe inside a code span is DATA, not a cell boundary: GFM does not split on it, and models
  // emit shell commands in tables constantly. Without this, | `ls | wc -l` | became two cells
  // (`ls` and `wc -l\``), shifting every later column left and corrupting the row. Protect the
  // span contents with a different sentinel before splitting, then restore.
  const codePlaceholder = '\u0000CODE\u0000';
  const codeSpans: string[] = [];
  const guarded = inner.replace(/`[^`]*`/g, (m) => {
    codeSpans.push(m);
    return `${codePlaceholder}${codeSpans.length - 1}${codePlaceholder}`;
  });
  return guarded
    .split('|')
    .map((c) =>
      c
        .trim()
        .replace(new RegExp(`${codePlaceholder}(\\d+)${codePlaceholder}`, 'g'), (_, n) => codeSpans[Number(n)]!)
        .replace(new RegExp(placeholder, 'g'), '|'),
    );
}

/** A GFM separator cell: dashes, optionally flanked by colons for alignment. */
function alignOf(cell: string): TableAlign | null {
  const m = /^(:?)(-+)(:?)$/.exec(cell.trim());
  if (!m) return null;
  if (m[1] && m[3]) return 'center';
  if (m[3]) return 'right';
  if (m[1]) return 'left'; // explicit `:---`
  return 'auto'; // bare `---` — numeric columns right-align at render time
}

export function isTableSeparator(line: string): boolean {
  // A separator must actually LOOK like a table row — contain a pipe. Without this, any
  // pipe-bearing prose line ("run a | grep b") directly followed by a plain '---' rule was
  // misread as a 2-column table header + one-cell separator, fabricating a phantom table.
  if (!line.includes('|')) return false;
  const cells = splitTableRow(line);
  if (cells.length < 1) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim()) && c.includes('-'));
}

/** Plain text of a span list (for column-width measurement + vertical fallback). */
export function spanText(spans: MdSpan[]): string {
  return spans.map((s) => s.text).join('');
}

/**
 * Cell text for measurement AND printing, minus the dim ` (url)` tail that follows a link label.
 *
 * In prose a link renders as `label` + a dim ` (url)` tail (or, with OSC 8, just the label —
 * the URL is the click target). In a table the tail was measured at full width and printed, so
 * `[docs](https://example.com/a/very/long/path/index.html)` demanded 54 columns and squeezed
 * every other column. Columns are the scarcest resource in a table, and a table cell has no room
 * for a URL a user cannot click. Dropping the tail keeps the label (the human-meaningful part),
 * matches the OSC 8 prose behavior, and stops one link from dictating the layout of the table
 * it appears in.
 */
function cellText(spans: MdSpan[]): string {
  const kept = spans.filter((s) => !s.link);
  return (kept.length ? kept : spans).map((s) => s.text).join('').trim();
}

/**
 * Parse a GFM table starting at line index `i`. Returns the block and the index
 * past the last consumed line, or null if lines[i] is not a table header followed
 * by a separator. Streaming-safe: a header with no separator yet (the separator is
 * still streaming) returns null so it renders as a paragraph until it completes.
 */
function tryParseTable(lines: string[], i: number): { block: MdBlock; next: number } | null {
  const headerLine = lines[i]!;
  if (!headerLine.includes('|')) return null;
  if (i + 1 >= lines.length) return null; // separator still streaming
  if (!isTableSeparator(lines[i + 1]!)) return null;

  const headerCells = splitTableRow(headerLine);
  const sepCells = splitTableRow(lines[i + 1]!);
  const colCount = Math.max(headerCells.length, sepCells.length);
  const align: TableAlign[] = [];
  for (let c = 0; c < colCount; c++) {
    align.push(alignOf(sepCells[c] ?? '') ?? 'auto');
  }
  // Pad the header to colCount so a separator with more columns than the header
  // doesn't render a short header row misaligned with the body.
  while (headerCells.length < colCount) headerCells.push('');
  const header = headerCells.map((c) => parseInline(c));

  const rows: MdSpan[][][] = [];
  let j = i + 2;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.trim() === '' || isBlockStart(l)) break;
    if (!l.includes('|')) break; // a table row without a pipe ends the table
    const cells = splitTableRow(l);
    while (cells.length < colCount) cells.push('');
    rows.push(cells.slice(0, colCount).map((c) => parseInline(c)));
    j++;
  }
  return {
    block: { type: 'table', align, header, rows },
    next: j,
  };
}

/** Pad a cell string to `width`, applying column alignment ('auto' is resolved before here;
 *  defensively treated as left). */
function padCell(text: string, width: number, align: TableAlign): string {
  const gap = Math.max(0, width - displayWidth(text));
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  }
  return text + ' '.repeat(gap);
}

/** A cell that reads as a number for auto-alignment: optional sign/currency, digits with
 *  separators, optional decimal, optional trailing %. Conservative on purpose — "10.2s"
 *  or "3 files" stay text (left). */
const NUMERIC_CELL = /^[+\-−]?[$€£¥]?\d[\d,. ]*%?$/;

/** Word-wrap plain cell text to `w` display columns; an over-wide token hard-splits
 *  (grapheme-safe via chunksByWidth — never splits a ZWJ run or surrogate pair). Always ≥1 line. */function wrapCellText(text: string, w: number): string[] {
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const parts = displayWidth(word) > w ? chunksByWidth(word, w) : [word];
    for (const part of parts) {
      const pw = displayWidth(part);
      if (curW === 0) {
        cur = part;
        curW = pw;
      } else if (curW + 1 + pw <= w) {
        cur += ' ' + part;
        curW += 1 + pw;
      } else {
        lines.push(cur);
        cur = part;
        curW = pw;
      }
    }
  }
  lines.push(cur);
  return lines;
}

/**
 * Render a table as a vertical `key: value` list — the shape used when the terminal is genuinely
 * too narrow for a grid (tiny pane, too many columns). Each value is WRAPPED to `maxWidth` with
 * continuation lines indented under the value, so the fallback never emits a line wider than the
 * terminal. Before, the fallback stacked raw `key: value` strings and a 30-col pane got an
 * 88-col line — the one shape where "we gave up on the grid" also meant "we gave up on fitting".
 */
function renderVerticalFallback(
  headerText: string[],
  rowsText: string[][],
  maxWidth: number,
): string[] {
  const out: string[] = [];
  const multi = rowsText.length > 1;
  /** Push a label line, hard-wrapping it if the label itself is wider than the pane. */
  const pushLabel = (label: string): void => {
    out.push(...wrapCellText(label, Math.max(1, maxWidth)));
  };
  rowsText.forEach((row, ri) => {
    if (multi) pushLabel(`— row ${ri + 1} —`);
    for (let c = 0; c < headerText.length; c++) {
      const key = headerText[c] || `col ${c + 1}`;
      const val = row[c] ?? '';
      const prefix = `${key}: `;
      const prefixW = displayWidth(prefix);
      // Keep continuations aligned under the value ONLY while that leaves the value room — a
      // 16-col `Responsibility: ` prefix in a 20-col pane aligned continuations to 16 and starved
      // the value to 4 cols (`Norm`/`aliz`/`es`). Align when the prefix fits comfortably, or when
      // the value lands on one line anyway (`alpha: x` in an 8-col pane is exact, not starved);
      // otherwise put the key on its own line and hang the value 2 cols in.
      const valW = displayWidth(val);
      const aligned =
        prefixW < maxWidth && (prefixW <= Math.floor(maxWidth / 2) || valW <= maxWidth - prefixW);
      // The continuation indent can never push a line over the pane. In a 1-3 col pane even a
      // 2-col hang leaves no room for a double-width glyph (日, 👍), so the indent collapses to
      // zero there — a bare glyph that just fits beats an indented one that overflows.
      const maxPad = maxWidth <= 3 ? 0 : maxWidth - 1;
      const padW = aligned ? Math.min(prefixW, maxPad) : Math.min(2, maxPad);
      const avail = Math.max(1, maxWidth - padW);
      const chunks = wrapCellText(val, avail);
      if (aligned) out.push(prefix + chunks[0]!);
      else pushLabel(`${key}:`);
      for (const chunk of chunks.slice(aligned ? 1 : 0)) {
        out.push(' '.repeat(padW) + chunk);
      }
    }
  });
  return out;
}

/**
 * Render a parsed table to plain text lines (bordered box-drawing chrome). Falls back to a
 * vertical key:value layout when the table would exceed `maxWidth` columns, so a
 * wide table never wraps mid-cell on a narrow terminal. Pure + testable.
 */
export function renderTableLines(table: Extract<MdBlock, { type: 'table' }>, maxWidth = 100): string[] {
  const colCount = table.align.length;
  const headerText = table.header.map(cellText);
  const rowsText = table.rows.map((r) => r.map(cellText));

  // Resolve 'auto' alignment (bare `---` separators): a column whose every non-empty BODY
  // cell is numeric right-aligns like a ledger — 1,024 sits under 512, not ragged-left.
  // Any explicit `:---`/`---:` marker was honored upstream and never reaches this branch.
  const align: TableAlign[] = table.align.map((a, c) => {
    if (a !== 'auto') return a;
    const cells = rowsText.map((r) => (r[c] ?? '').trim()).filter((t) => t !== '');
    return cells.length > 0 && cells.every((t) => NUMERIC_CELL.test(t)) ? 'right' : 'left';
  });

  const natural: number[] = new Array(colCount).fill(0);
  for (let c = 0; c < colCount; c++) {
    natural[c] = Math.max(natural[c], displayWidth(headerText[c] ?? ''));
  }
  for (const row of rowsText) {
    for (let c = 0; c < colCount; c++) {
      natural[c] = Math.max(natural[c], displayWidth(row[c] ?? ''));
    }
  }

  // The width each column needs so that NO token is carved in half: the longest single word in
  // that column (header included). A column holding `src/safety/classifier.ts` needs 24 cols —
  // giving it 12 renders `src/safety/c` + `lassifier.ts`, and in a CLI where paths are the thing
  // the user is about to open, a split path is worse than no path. Same for `classifier` in
  // prose: `classifie` + `r` reads as a typo, not a wrap.
  const wordMax: number[] = new Array(colCount).fill(0);
  for (let c = 0; c < colCount; c++) {
    for (const cell of [headerText[c] ?? '', ...rowsText.map((r) => r[c] ?? '')]) {
      for (const word of cell.split(/\s+/).filter(Boolean)) {
        const w = displayWidth(word);
        if (w > wordMax[c]!) wordMax[c] = w;
      }
    }
  }

  // `│ cell │` chrome: 3 cols per column (`│ ` + ` `) plus the closing `│`.
  const chrome = 3 * colCount + 1;
  const budget = maxWidth - chrome;
  let widths = natural.slice();
  const naturalSum = natural.reduce((a, w) => a + w, 0);

  if (naturalSum > budget && colCount > 0) {
    // Too wide at natural size → WRAP THE CELLS, don't give up on the grid. The old behavior
    // jumped straight to the "— row N — / key: value" fallback, so every 3-column table on a
    // normal terminal rendered as a wall of labeled lines instead of a table.
    //
    // Allocation is WORD-AWARE. `wordMax[c]` is the width column c needs to wrap between words
    // without ever carving a token in half, so it is the real minimum for a legible column —
    // not an arbitrary floor.
    //   • Σ wordMax fits → every column gets at least its word width: zero split tokens.
    //   • Σ wordMax does NOT fit → shrink the word widths proportionally. Splitting is then
    //     unavoidable, so spend it where it costs least: a column whose longest token is 8
    //     chars keeps ~8, while the 72-char prose column absorbs the wrap. Proportional-to-
    //     natural instead did the opposite — it starved `Files` (a 24-char path) down to 12 and
    //     rendered `src/safety/c` + `lassifier.ts` while `Responsibility` still had 37 cols.
    const wordMaxSum = wordMax.reduce((a, w) => a + w, 0);
    const wordFits = wordMaxSum <= budget;
    // A grid of 1-2 char columns is unreadable — at that point the key:value fallback genuinely
    // is the better shape. MIN_COL is the floor below which we stop calling it a table.
    const MIN_COL = 5;
    const tooNarrow = budget < colCount * MIN_COL;

    if (tooNarrow) {
      // GENUINELY impossible (tiny terminal / too many columns) → vertical key:value fallback.
      return renderVerticalFallback(headerText, rowsText, maxWidth);
    }

    if (wordFits) {
      // Start every column at its no-split floor, then hand the remainder out by
      // (natural − floor) so prose columns absorb the slack and no token is ever carved.
      widths = wordMax.map((w, c) => Math.max(1, Math.min(natural[c]!, Math.max(MIN_COL, w))));
      const slack = widths.map((w, c) => Math.max(0, natural[c]! - w));
      const slackSum = slack.reduce((a, w) => a + w, 0);
      let extra = budget - widths.reduce((a, w) => a + w, 0);
      if (slackSum > 0 && extra > 0) {
        const share = slack.map((s) => Math.floor((s * extra) / slackSum));
        for (let c = 0; c < colCount; c++) {
          const add = Math.min(share[c]!, slack[c]!);
          widths[c]! += add;
          extra -= add;
        }
      }
      // Floor rounding leaves crumbs; give them to the column with the widest gap.
      while (extra > 0) {
        let best = -1;
        let gap = 0;
        for (let c = 0; c < colCount; c++) {
          const g = natural[c]! - widths[c]!;
          if (g > gap) {
            gap = g;
            best = c;
          }
        }
        if (best < 0) break;
        widths[best]!++;
        extra--;
      }
    } else {
      // Splitting is unavoidable here. Share the budget proportionally to wordMax so the
      // columns holding long tokens (paths, identifiers) keep the most, never exceeding natural.
      const basisSum = wordMaxSum > 0 ? wordMaxSum : colCount;
      widths = wordMax.map((w, c) =>
        Math.max(1, Math.min(natural[c]!, Math.floor(((w || 1) * budget) / basisSum))),
      );
      let extra = budget - widths.reduce((a, w) => a + w, 0);
      while (extra > 0) {
        let best = -1;
        let gap = 0;
        for (let c = 0; c < colCount; c++) {
          const g = Math.min(natural[c]!, wordMax[c]!) - widths[c]!;
          if (g > gap) {
            gap = g;
            best = c;
          }
        }
        if (best < 0) break;
        widths[best]!++;
        extra--;
      }
    }

    // A floor can push the total back OVER the budget, which used to fall straight into the
    // "genuinely impossible" vertical fallback: a 4-column table on an 82-84 col terminal
    // degraded to a `— row N —` key:value wall at widths where its 78 and 88 col neighbours
    // rendered a perfect grid. Non-monotonic, so it read as random breakage. Shrink the widest
    // column (never below 1) until the grid actually fits; only give up when nothing can give.
    let surplus = widths.reduce((a, w) => a + w, 0) - budget;
    while (surplus > 0) {
      let widest = -1;
      for (let c = 0; c < colCount; c++) {
        if (widths[c]! > 1 && (widest < 0 || widths[c]! > widths[widest]!)) widest = c;
      }
      if (widest < 0) break;
      widths[widest]!--;
      surplus--;
    }

    if (widths.reduce((a, w) => a + w, 0) > budget) {
      // Extremely pathological fallback: no column could give back enough. Same key:value shape.
      return renderVerticalFallback(headerText, rowsText, maxWidth);
    }

    // A column narrower than a word it must hold carves that word in half — at 65 cols this
    // 4-column table drew `src/safety/classifier.t` + `s` and `mediu` + `m`. Column NAMES are what
    // make a grid legible, and a split path reads as corruption rather than as a wrap. So the grid
    // may not carve a token it had room to hold: every token wider than its own column must ALSO
    // be wider than any column this terminal could give, or it was avoidable and the labeled
    // key:value fallback reads better. A token wider than `maxWidth` itself is different — nothing
    // can draw it whole and the fallback hard-splits it identically, so there we keep the grid.
    // Checked AFTER allocation, because only the final widths reveal the carve.
    const widestPossible = Math.max(1, maxWidth - chrome);
    const carvesToken = (() => {
      for (let c = 0; c < colCount; c++) {
        for (const cell of [headerText[c] ?? '', ...rowsText.map((r) => r[c] ?? '')]) {
          for (const word of cell.split(/\s+/).filter(Boolean)) {
            const w = displayWidth(word);
            if (w <= widths[c]! || w > widestPossible) continue;
            return true;
          }
        }
      }
      return false;
    })();
    if (carvesToken) return renderVerticalFallback(headerText, rowsText, maxWidth);
  } else if (colCount === 0) {
    widths = [];
  }

  // Box-drawing borders (╭─┬─╮ … │ … ├─┼─┤ … ╰─┴─╯) — the clean grid the reference client draws, not
  // ASCII |/-, with ROUNDED corners matching the code-block and finding-card chrome so every
  // container in the transcript shares one visual family. Each column segment is width+2 to match
  // `' ' + paddedCell + ' '`, so every line is the same length and the verticals line up.
  // Alignment is applied by padCell (no :---: markers). Cells WRAP within their column: a logical
  // row renders as `height` terminal lines.
  const rule = (l: string, m: string, r: string): string =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const renderRow = (texts: string[]): string[] => {
    const cells = texts.map((t, c) => wrapCellText(t ?? '', widths[c]!));
    const height = Math.max(1, ...cells.map((cl) => cl.length));
    const lines: string[] = [];
    for (let li = 0; li < height; li++) {
      lines.push('│' + cells.map((cl, c) => ' ' + padCell(cl[li] ?? '', widths[c]!, align[c]!) + ' ').join('│') + '│');
    }
    return lines;
  };

  const headerLines = renderRow(headerText);
  const bodyBlocks = rowsText.map(renderRow);
  // Separate body rows with rules when the table actually wraps — but only on the boundaries that
  // NEED it. The old rule dropped a `├─┼─┤` after every row as soon as any single row wrapped,
  // which on a 4-row wrapped table meant 6 rules to 9 data lines: 40% of the vertical space spent
  // on chrome, and the table read as five stacked boxes instead of one table. A rule is only doing
  // work at a boundary where it separates a wrapped row from its neighbour; between two
  // single-line rows the row break is already obvious.
  const multiline = headerLines.length > 1 || bodyBlocks.some((b) => b.length > 1);
  const out = [rule('╭', '┬', '╮'), ...headerLines, rule('├', '┼', '┤')];
  bodyBlocks.forEach((b, i) => {
    if (i > 0 && multiline && (b.length > 1 || bodyBlocks[i - 1]!.length > 1)) {
      out.push(rule('├', '┼', '┤'));
    }
    out.push(...b);
  });
  out.push(rule('╰', '┴', '╯'));
  return out;
}
