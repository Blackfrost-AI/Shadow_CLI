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
// Exported: the streaming committer (extractCommittableUnits in tui.tsx) must use the EXACT same
// line classifications as this parser — re-implemented copies drifted (looser fence opens, trimmed
// list tests) and made streamed output disagree with the non-streamed render of the same text.
export const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
/** Classify a line as a legal markdown code-fence marker, or null if it is not one.
 *  A fence line requires ≤3 leading spaces and ≥3 identical ticks (`` ` `` or `~`). */
export function matchFence(line) {
    const m = FENCE_LINE.exec(line);
    if (!m)
        return null;
    const marker = m[1];
    return { char: marker[0], width: marker.length, lang: m[2] ?? '' };
}
/** CommonMark fence-close rule: a line closes a fence only if it is a fence of the SAME marker
 *  char with width ≥ the opener's width. A 4-tick fence therefore cannot be closed by a 3-tick
 *  line inside it (exactly what frontier models emit when writing about nested markdown), and a
 *  ``` inside a ~~~ block (or vice versa) is literal content. */
export function closesFence(line, open) {
    const m = matchFence(line);
    return m !== null && m.char === open.char && m.width >= open.width;
}
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
export const QUOTE = /^\s*>/;
export const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const LIST_ORDERED = /^\s*\d+[.)]\s+/;
function isBlockStart(line) {
    return (FENCE.test(line) ||
        HEADING.test(line) ||
        HR.test(line) ||
        QUOTE.test(line) ||
        LIST_ITEM.test(line));
}
/** Parse inline emphasis/code/links within a single logical text run. */
export function parseInline(text) {
    const spans = [];
    const push = (t, fmt = {}) => {
        if (t)
            spans.push({ text: t, ...fmt });
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
        if (m.index > 0)
            push(rest.slice(0, m.index));
        if (m[1])
            push(m[2], { code: true });
        else if (m[3])
            push(m[4], { bold: true });
        else if (m[5])
            push(m[6], { italic: true });
        else {
            push(m[7], { linkLabel: true, url: m[8] }); // link label — link accent; url carried for OSC 8
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
export function wrapSpans(spans, width) {
    if (!Number.isFinite(width) || width <= 0)
        return [spans];
    const lines = [];
    let line = [];
    let w = 0;
    const dropTrailingSpace = () => {
        if (line.length && line[line.length - 1].text === ' ')
            line.pop();
    };
    for (const span of spans) {
        const fmt = { bold: span.bold, italic: span.italic, code: span.code };
        for (const tok of span.text.split(/(\s+)/)) {
            if (tok === '')
                continue;
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
export function parseMarkdown(src) {
    // Normalize CRLF: a trailing \r defeated the anchored block regexes (HEADING's `(.*)$` cannot
    // cross \r), so CRLF answers rendered headings/rules as literal paragraph text.
    const lines = src.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const openFence = matchFence(line);
        if (openFence) {
            const lang = openFence.lang;
            const code = [];
            i++;
            let closed = false;
            while (i < lines.length) {
                const l = lines[i];
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
            blocks.push({ type: 'heading', level: h[1].length, spans: parseInline(h[2].trim()) });
            i++;
            continue;
        }
        if (HR.test(line)) {
            blocks.push({ type: 'rule' });
            i++;
            continue;
        }
        if (QUOTE.test(line)) {
            const q = [];
            while (i < lines.length && QUOTE.test(lines[i])) {
                q.push(lines[i].replace(/^\s*>\s?/, ''));
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
            const start = ordered ? parseInt(/\d+/.exec(line)[0], 10) : undefined;
            const items = [];
            const depths = [];
            while (i < lines.length && LIST_ITEM.test(lines[i])) {
                const raw = lines[i];
                // Nesting depth from leading indentation (2 spaces per level, capped) — so `  - sub` renders
                // one level in from `- top` instead of collapsing to the same margin.
                const indent = raw.length - raw.replace(/^\s*/, '').length;
                depths.push(Math.min(4, Math.floor(indent / 2)));
                items.push(parseInline(raw.replace(LIST_ITEM, '')));
                i++;
            }
            const nested = depths.some((d) => d > 0);
            blocks.push({
                type: 'list',
                ordered,
                items,
                ...(start !== undefined && start !== 1 ? { start } : {}),
                ...(nested ? { depths } : {}),
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
        const para = [];
        while (i < lines.length &&
            lines[i].trim() !== '' &&
            !isBlockStart(lines[i]) &&
            !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))) {
            para.push(lines[i]);
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
            para.push(lines[i]); // degenerate: pipe line with a separator-looking next line but no table
            i++;
        }
        blocks.push({ type: 'paragraph', spans: parseInline(para.join('\n')) });
    }
    return blocks;
}
// ── GFM tables ────────────────────────────────────────────────────────────────
/** Split a `| a | b |` row into trimmed cells, honoring `\|` escapes. */
function splitTableRow(line) {
    const placeholder = ' PIPE ';
    const unescaped = line.replace(/\\\|/g, placeholder);
    let inner = unescaped.trim();
    // Strip one leading + one trailing pipe if present.
    inner = inner.replace(/^\|/, '').replace(/\|$/, '');
    return inner
        .split('|')
        .map((c) => c.replace(new RegExp(placeholder, 'g'), '|').trim());
}
/** A GFM separator cell: dashes, optionally flanked by colons for alignment. */
function alignOf(cell) {
    const m = /^(:?)(-+)(:?)$/.exec(cell.trim());
    if (!m)
        return null;
    if (m[1] && m[3])
        return 'center';
    if (m[3])
        return 'right';
    if (m[1])
        return 'left'; // explicit `:---`
    return 'auto'; // bare `---` — numeric columns right-align at render time
}
export function isTableSeparator(line) {
    // A separator must actually LOOK like a table row — contain a pipe. Without this, any
    // pipe-bearing prose line ("run a | grep b") directly followed by a plain '---' rule was
    // misread as a 2-column table header + one-cell separator, fabricating a phantom table.
    if (!line.includes('|'))
        return false;
    const cells = splitTableRow(line);
    if (cells.length < 1)
        return false;
    return cells.every((c) => /^:?-+:?$/.test(c.trim()) && c.includes('-'));
}
/** Plain text of a span list (for column-width measurement + vertical fallback). */
export function spanText(spans) {
    return spans.map((s) => s.text).join('');
}
/**
 * Parse a GFM table starting at line index `i`. Returns the block and the index
 * past the last consumed line, or null if lines[i] is not a table header followed
 * by a separator. Streaming-safe: a header with no separator yet (the separator is
 * still streaming) returns null so it renders as a paragraph until it completes.
 */
function tryParseTable(lines, i) {
    const headerLine = lines[i];
    if (!headerLine.includes('|'))
        return null;
    if (i + 1 >= lines.length)
        return null; // separator still streaming
    if (!isTableSeparator(lines[i + 1]))
        return null;
    const headerCells = splitTableRow(headerLine);
    const sepCells = splitTableRow(lines[i + 1]);
    const colCount = Math.max(headerCells.length, sepCells.length);
    const align = [];
    for (let c = 0; c < colCount; c++) {
        align.push(alignOf(sepCells[c] ?? '') ?? 'auto');
    }
    // Pad the header to colCount so a separator with more columns than the header
    // doesn't render a short header row misaligned with the body.
    while (headerCells.length < colCount)
        headerCells.push('');
    const header = headerCells.map((c) => parseInline(c));
    const rows = [];
    let j = i + 2;
    while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === '' || isBlockStart(l))
            break;
        if (!l.includes('|'))
            break; // a table row without a pipe ends the table
        const cells = splitTableRow(l);
        while (cells.length < colCount)
            cells.push('');
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
function padCell(text, width, align) {
    const gap = Math.max(0, width - displayWidth(text));
    if (align === 'right')
        return ' '.repeat(gap) + text;
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
 *  (grapheme-safe via chunksByWidth — never splits a ZWJ run or surrogate pair). Always ≥1 line. */
function wrapCellText(text, w) {
    const lines = [];
    let cur = '';
    let curW = 0;
    for (const word of text.split(/\s+/).filter(Boolean)) {
        const parts = displayWidth(word) > w ? chunksByWidth(word, w) : [word];
        for (const part of parts) {
            const pw = displayWidth(part);
            if (curW === 0) {
                cur = part;
                curW = pw;
            }
            else if (curW + 1 + pw <= w) {
                cur += ' ' + part;
                curW += 1 + pw;
            }
            else {
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
 * Render a parsed table to plain text lines (bordered box-drawing chrome). Falls back to a
 * vertical key:value layout when the table would exceed `maxWidth` columns, so a
 * wide table never wraps mid-cell on a narrow terminal. Pure + testable.
 */
export function renderTableLines(table, maxWidth = 100) {
    const colCount = table.align.length;
    const headerText = table.header.map(spanText);
    const rowsText = table.rows.map((r) => r.map(spanText));
    // Resolve 'auto' alignment (bare `---` separators): a column whose every non-empty BODY
    // cell is numeric right-aligns like a ledger — 1,024 sits under 512, not ragged-left.
    // Any explicit `:---`/`---:` marker was honored upstream and never reaches this branch.
    const align = table.align.map((a, c) => {
        if (a !== 'auto')
            return a;
        const cells = rowsText.map((r) => (r[c] ?? '').trim()).filter((t) => t !== '');
        return cells.length > 0 && cells.every((t) => NUMERIC_CELL.test(t)) ? 'right' : 'left';
    });
    const natural = new Array(colCount).fill(0);
    for (let c = 0; c < colCount; c++) {
        natural[c] = Math.max(natural[c], displayWidth(headerText[c] ?? ''));
    }
    for (const row of rowsText) {
        for (let c = 0; c < colCount; c++) {
            natural[c] = Math.max(natural[c], displayWidth(row[c] ?? ''));
        }
    }
    // `│ cell │` chrome: 3 cols per column (`│ ` + ` `) plus the closing `│`.
    const chrome = 3 * colCount + 1;
    const budget = maxWidth - chrome;
    const MIN_COL = 5;
    let widths = natural.slice();
    const naturalSum = natural.reduce((a, w) => a + w, 0);
    if (naturalSum > budget) {
        // Too wide at natural size → WRAP THE CELLS, don't give up on the grid. Columns shrink
        // proportionally to their natural width (floor MIN_COL, never wider than natural), then any
        // leftover budget goes to the neediest column. The old behavior jumped straight to the
        // "— row N — / key: value" fallback, so every 3-column table on a normal terminal rendered
        // as a wall of labeled lines instead of a table.
        if (budget >= colCount * MIN_COL && naturalSum > 0) {
            widths = natural.map((n) => Math.max(MIN_COL, Math.min(n, Math.floor((n * budget) / naturalSum))));
            let leftover = budget - widths.reduce((a, w) => a + w, 0);
            while (leftover > 0) {
                let best = -1;
                let deficit = 0;
                for (let c = 0; c < colCount; c++) {
                    const d = natural[c] - widths[c];
                    if (d > deficit) {
                        deficit = d;
                        best = c;
                    }
                }
                if (best < 0)
                    break;
                widths[best]++;
                leftover--;
            }
        }
        if (widths.reduce((a, w) => a + w, 0) > budget || colCount === 0) {
            // GENUINELY impossible (tiny terminal / too many columns) → vertical key:value fallback.
            const out = [];
            table.rows.forEach((row, ri) => {
                if (table.rows.length > 1)
                    out.push(`— row ${ri + 1} —`);
                for (let c = 0; c < colCount; c++) {
                    const key = headerText[c] ?? `col ${c + 1}`;
                    const val = rowsText[ri]?.[c] ?? '';
                    out.push(`${key}: ${val}`);
                }
            });
            return out;
        }
    }
    // Box-drawing borders (╭─┬─╮ … │ … ├─┼─┤ … ╰─┴─╯) — the clean grid the reference client draws, not
    // ASCII |/-, with ROUNDED corners matching the code-block and finding-card chrome so every
    // container in the transcript shares one visual family. Each column segment is width+2 to match
    // `' ' + paddedCell + ' '`, so every line is the same length and the verticals line up.
    // Alignment is applied by padCell (no :---: markers). Cells WRAP within their column: a logical
    // row renders as `height` terminal lines.
    const rule = (l, m, r) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
    const renderRow = (texts) => {
        const cells = texts.map((t, c) => wrapCellText(t ?? '', widths[c]));
        const height = Math.max(1, ...cells.map((cl) => cl.length));
        const lines = [];
        for (let li = 0; li < height; li++) {
            lines.push('│' + cells.map((cl, c) => ' ' + padCell(cl[li] ?? '', widths[c], align[c]) + ' ').join('│') + '│');
        }
        return lines;
    };
    const headerLines = renderRow(headerText);
    const bodyBlocks = rowsText.map(renderRow);
    // When any row wraps to multiple lines, separate the body rows with rules so rows stay legible;
    // a fully single-line table keeps the tight border-free body it always had.
    const multiline = headerLines.length > 1 || bodyBlocks.some((b) => b.length > 1);
    const out = [rule('╭', '┬', '╮'), ...headerLines, rule('├', '┼', '┤')];
    bodyBlocks.forEach((b, i) => {
        if (i > 0 && multiline)
            out.push(rule('├', '┼', '┤'));
        out.push(...b);
    });
    out.push(rule('╰', '┴', '╯'));
    return out;
}
