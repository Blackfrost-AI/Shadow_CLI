// src/tui/flatten.ts — Flatten Shadow's TranscriptItems into styled display lines.
//
// Each TranscriptItem is rendered to an array of ViewportLines (1 terminal row each), preserving
// the stock TranscriptRow's styling (markdown spans, code highlighting, tables, tool tags, reasoning
// toggles, finding cards). The stock FlatItem renderer maps these lines to Ink <Text> rows inside
// <Static>, so they scroll into native scrollback and are never repainted.
//
// Design informed by parity research; implementation is original.

import { parseMarkdown, renderTableLines } from '../util/markdown.js';
import { highlight } from '../util/highlight.js';
import type { CodeRole } from '../util/highlight.js';
import type { MdSpan, MdBlock } from '../util/markdown.js';
import { segmentTableLine, TABLE_COLLAPSE_THRESHOLD } from '../util/tableStyle.js';
import { CHART_LANGS, parseChartSpec, renderChart } from '../util/chart.js';
import type { ChartSpan } from '../util/chart.js';
import { hyperlink, supportsHyperlinks } from '../util/hyperlinks.js';
import { inlineImageEsc, formatBytes, supportsInlineImages } from '../util/termImage.js';
import { renderBrand, renderToolResult, renderToolChild, renderReasoning, renderToolStack } from './rows.js';
import type { BrandInfo, ToolInfo, ToolRun } from './rows.js';

export { TABLE_COLLAPSE_THRESHOLD };

// the reference client vocabulary: the ⏺ turn bullet + the warm brand orange it's drawn in.
const ASSISTANT_DOT = process.platform === 'darwin' ? '⏺' : '●';
const CLAUDE_ORANGE = '#d97757';
// OSC 8 hyperlinks: stable for the process (env-derived), so resolve once at module load.
const LINKS = supportsHyperlinks();
// Inline images: likewise TTY+terminal-derived and stable. Gated so image escapes never leak into
// piped/redirected output (only emit when stdout is a real TTY on a capable terminal).
const IMG = supportsInlineImages();

/** Tool/blocked bodies longer than this fold by default (Ctrl-O expands). 1–3 lines stay inline. */
export const TOOL_BODY_COLLAPSE_THRESHOLD = 3;
/**
 * Hard cap on lines painted when a body is expanded. Scrollback stays usable even if a tool
 * returned thousands of lines; a dim note reports how many were elided.
 */
export const TOOL_BODY_EXPAND_CAP = 80;

type BodyLine = { text: string; color?: string; dimColor?: boolean; bold?: boolean };

/** Label for the one-row fold (`⌄ output N lines · ^O` / `⌄ diff N lines · ^O` / `⌄ answer N lines · ^O`). */
function toolBodyLabel(meta: string | undefined): string {
  if (meta === 'diff') return 'diff';
  if (meta === 'answer') return 'answer'; // a sub-agent's answer body (agent tool) reads as "answer", not "output"
  if (meta === 'output') return 'output';
  return 'output';
}

/**
 * Append a tool/blocked child body under a ⏺ header (or as a standalone child item).
 * Collapsed (default for >threshold lines): exactly ONE row via renderToolChild.
 * Expanded / short: ⎿-branched content, hard-capped at TOOL_BODY_EXPAND_CAP.
 */
function appendToolBody(
  out: ViewportLine[],
  kp: string,
  body: BodyLine[],
  collapsed: boolean,
  theme: ViewportTheme,
  cols: number,
  color: string | undefined,
  meta: string | undefined,
): void {
  if (body.length === 0) return;
  const collapsible = body.length > TOOL_BODY_COLLAPSE_THRESHOLD;
  if (collapsible && collapsed) {
    out.push({
      key: `${kp}fold`,
      spans: truncateSpans(renderToolChild(toolBodyLabel(meta), body.length, theme), cols),
    });
    return;
  }
  // Expanded (or short enough to stay inline): ⎿ branch, hard-capped so a huge body can't
  // flood native scrollback even after Ctrl-O. Keep the TAIL — the ingest cap (capTranscriptBody)
  // tail-prefers for the same reason: the end of a build/test run is usually the signal.
  const over = body.length > TOOL_BODY_EXPAND_CAP;
  const shown = over ? body.slice(-TOOL_BODY_EXPAND_CAP) : body;
  if (over) {
    const hidden = body.length - TOOL_BODY_EXPAND_CAP;
    out.push({
      key: `${kp}cap`,
      spans: truncateSpans(
        [
          { text: '  ⎿ ', color: theme.dim },
          { text: `… +${hidden} earlier ${hidden === 1 ? 'line' : 'lines'} elided`, color: theme.dim },
        ],
        cols,
      ),
    });
  }
  shown.forEach((l, i) => {
    const gutter: StyledSpan = i === 0 && !over ? { text: '  ⎿ ', color: theme.dim } : { text: '    ' };
    out.push({
      key: `${kp}l${i}`,
      spans: truncateSpans(
        [gutter, { text: l.text ?? '', color: l.color ?? color, dim: l.dimColor, bold: l.bold }],
        cols,
      ),
    });
  });
}

// ── types ────────────────────────────────────────────────────────────────────

/** A styled text run within a single terminal row. */
export interface StyledSpan {
  text: string;
  color?: string;
  /** Background fill (hex). Used for the inline-code "chip" — a non-color cue so code is legible
   *  even where the foreground hue isn't perceptible (WCAG 1.4.1). */
  bg?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
}

/** One terminal row of the flattened transcript. */
export interface ViewportLine {
  key: string;
  spans: StyledSpan[];
}

/** Color roles the flattener needs (passed from the active theme's `C` palette). */
export interface ViewportTheme {
  fg: string;
  /** Explicit low-contrast gray (#b6bcc3, AA+) for quiet text. NEVER the faint SGR-2 attribute —
   *  the ADA pass banned it as unreadable, so v2 rows use this hue for all de-emphasis. */
  dim: string;
  green: string;
  cyan: string;
  yellow: string;
  red: string;
  purple: string;
  /** Subtle fill behind inline code (the "chip"). Optional — falls back to color-only if unset. */
  codeBg?: string;
  /** Bright white for BOLD text only. Body text uses the softer `fg`, so bold visibly pops —
   *  truecolor #ffffff body rendered heavy/bloomy in Terminal.app and blended with bold. */
  bright?: string;
  /** The ▌ gutter bar on every line of a user turn. Optional — falls back to `green`. Paired with
   *  `accent` per-theme so user vs assistant stays distinguishable under color-vision deficiency. */
  user?: string;
  /** The ⏺ assistant-turn bullet. Optional — falls back to the reference client's warm orange. */
  accent?: string;
}

// ── wrapping ─────────────────────────────────────────────────────────────────

/**
 * Wrap a list of styled spans into rows of at most `cols` characters. Char-based (1 char = 1 col);
 * a documented approximation for double-width/CJK characters (the cell fork's stringWidth is not
 * available under "no jacking"). Newlines within span text start new rows.
 */
export function wrapSpans(spans: StyledSpan[], cols: number): StyledSpan[][] {
  const w = Math.max(1, cols);
  const rows: StyledSpan[][] = [];
  let cur: StyledSpan[] = [];
  let curLen = 0;

  const flush = (): void => {
    rows.push(cur);
    cur = [];
    curLen = 0;
  };

  for (const sp of spans) {
    const parts = sp.text.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) flush(); // newline → new row
      let text = parts[p]!;
      while (text.length > 0) {
        const room = w - curLen;
        if (room <= 0) {
          flush();
          continue;
        }
        if (text.length <= room) {
          cur.push({ ...sp, text });
          curLen += text.length;
          text = '';
        } else {
          cur.push({ ...sp, text: text.slice(0, room) });
          text = text.slice(room);
          flush();
        }
      }
    }
  }
  if (cur.length > 0 || rows.length === 0) flush();
  return rows;
}

/**
 * Word-aware wrap: break at spaces (dropping the space at the wrap point) so prose never splits
 * mid-word — the char-based wrapper made paragraphs read like DOS output, snapping "sciencedaily"
 * into "sci / encedaily" at the terminal edge. A single token wider than the width still
 * hard-splits (URLs/code tokens can exceed any measure). Newlines start new rows. Styles are
 * preserved per token.
 */
export function wrapSpansWord(spans: StyledSpan[], cols: number): StyledSpan[][] {
  const w = Math.max(1, cols);
  const rows: StyledSpan[][] = [];
  let cur: StyledSpan[] = [];
  let curLen = 0;
  const flush = (): void => {
    rows.push(cur);
    cur = [];
    curLen = 0;
  };
  // True until the first WORD of the current LOGICAL line is emitted. Leading whitespace at a
  // logical-line start is INDENTATION (nested bullets, user-typed alignment) and must be kept;
  // only the space at a WRAP point (row start mid-line) is droppable. The old unconditional
  // "never lead a row with space" ate every nested list's indent.
  let atLineStart = true;
  for (const sp of spans) {
    const parts = sp.text.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        flush();
        atLineStart = true; // an explicit newline starts a new logical line
      }
      // Tokenize into word / whitespace runs, styling each with the span's format.
      for (const tok of parts[p]!.split(/(\s+)/)) {
        if (tok === '') continue;
        const isSpace = /^\s+$/.test(tok);
        if (isSpace) {
          if (curLen === 0 && !atLineStart) continue; // drop only the wrap-point space
          if (curLen + tok.length <= w) {
            cur.push({ ...sp, text: tok });
            curLen += tok.length;
          } else if (atLineStart) {
            // Indentation wider than the measure — hard-split like an over-wide token.
            let rest = tok;
            while (rest.length > w - curLen) {
              cur.push({ ...sp, text: rest.slice(0, w - curLen) });
              rest = rest.slice(w - curLen);
              flush();
            }
            if (rest) { cur.push({ ...sp, text: rest }); curLen += rest.length; }
          } else {
            flush(); // the space IS the wrap point
          }
          continue;
        }
        atLineStart = false;
        if (curLen + tok.length <= w) {
          cur.push({ ...sp, text: tok });
          curLen += tok.length;
          continue;
        }
        // Doesn't fit. If the row so far is ONLY indentation, keep it and split the word right
        // after it (popping it would erase the indent and flush a bogus empty row). Otherwise
        // start a fresh row (dropping the trailing wrap space), then hard-split an over-wide token.
        if (curLen > 0 && curLen < w && cur.every((s) => /^\s+$/.test(s.text))) {
          let rest = tok;
          cur.push({ ...sp, text: rest.slice(0, w - curLen) });
          rest = rest.slice(w - curLen);
          flush();
          while (rest.length > w) {
            cur.push({ ...sp, text: rest.slice(0, w) });
            rest = rest.slice(w);
            flush();
          }
          if (rest) {
            cur.push({ ...sp, text: rest });
            curLen = rest.length;
          }
          continue;
        }
        if (curLen > 0) {
          if (cur.length && /^\s+$/.test(cur[cur.length - 1]!.text)) cur.pop();
          flush();
        }
        let rest = tok;
        while (rest.length > w) {
          cur.push({ ...sp, text: rest.slice(0, w) });
          rest = rest.slice(w);
          flush();
        }
        if (rest) {
          cur.push({ ...sp, text: rest });
          curLen = rest.length;
        }
      }
    }
  }
  if (cur.length && /^\s+$/.test(cur[cur.length - 1]!.text)) cur.pop();
  if (cur.length > 0 || rows.length === 0) flush();
  return rows;
}

/** One row, truncated to `cols` with a dim ellipsis — for rows that must NEVER wrap (tool results). */
export function truncateSpans(spans: StyledSpan[], cols: number): StyledSpan[] {
  const w = Math.max(4, cols);
  const out: StyledSpan[] = [];
  let len = 0;
  for (const sp of spans) {
    if (len + sp.text.length <= w) {
      out.push(sp);
      len += sp.text.length;
      continue;
    }
    // Doesn't fit → an ellipsis must be appended, so guarantee room for it: trim already-emitted
    // spans back until there's a free column (a span that filled EXACTLY to `w` would otherwise let
    // the row reach w+1 and wrap — the one thing this function exists to prevent).
    const room = w - 1 - len;
    if (room > 0) out.push({ ...sp, text: sp.text.slice(0, room) });
    else {
      while (out.length && len >= w) {
        const last = out[out.length - 1]!;
        if (last.text.length <= 1) { out.pop(); len -= last.text.length; }
        else { const cut = len - (w - 1); out[out.length - 1] = { ...last, text: last.text.slice(0, last.text.length - cut) }; len -= cut; }
      }
    }
    out.push({ text: '…', ...(sp.color !== undefined ? { color: sp.color } : {}) });
    return out;
  }
  return out;
}

/** Convert a single logical line (spans) into ViewportLines. Word-wrapped by default; pass
 *  'char' for content where exact columns matter (code — spaces are indentation, not wrap points). */
function wrapLine(keyPrefix: string, spans: StyledSpan[], cols: number, mode: 'word' | 'char' = 'word'): ViewportLine[] {
  const wrapped = mode === 'char' ? wrapSpans(spans, cols) : wrapSpansWord(spans, cols);
  return wrapped.map((rowSpans, i) => ({
    key: `${keyPrefix}.${i}`,
    spans: rowSpans,
  }));
}

/**
 * Wrap `body` with a HANGING prefix: the first row carries `first` (bullet/quote-bar/etc.), every
 * continuation row carries `cont` (alignment spaces, or the repeated quote bar). Both prefixes must
 * render at the same width so wrapped rows align under the text, not under the marker — the wrapped
 * "second line of a bullet" flushing left was the single most un-clean thing in transcript prose.
 */
function wrapHanging(
  keyPrefix: string,
  first: StyledSpan[],
  cont: StyledSpan[],
  body: StyledSpan[],
  cols: number,
): ViewportLine[] {
  const prefixW = first.reduce((n, s) => n + s.text.length, 0);
  const inner = Math.max(4, cols - prefixW);
  return wrapSpansWord(body, inner).map((rowSpans, i) => ({
    key: `${keyPrefix}.${i}`,
    spans: [...(i === 0 ? first : cont), ...rowSpans],
  }));
}

// ── code role → color ─────────────────────────────────────────────────────────

function codeStyle(role: CodeRole, theme: ViewportTheme): { color: string; dim: boolean } {
  switch (role) {
    case 'keyword': return { color: theme.purple, dim: false };
    case 'string': return { color: theme.green, dim: false };
    case 'comment': return { color: theme.dim, dim: false };
    case 'number': return { color: theme.cyan, dim: false };
    default: return { color: theme.fg, dim: false };
  }
}

// ── markdown block → styled spans ─────────────────────────────────────────────

function mdSpanToStyled(s: MdSpan, theme: ViewportTheme): StyledSpan {
  // Inline code → cyan on a subtle chip (the bg is the non-color cue). Link LABEL → cyan (it must
  // read as a link, not blend into prose); the " (url)" tail → dim so the address recedes.
  // Bold gets the BRIGHT tier so it pops against the softer body gray (weight + brightness).
  if (s.code) return { text: s.text, color: theme.cyan, bg: theme.codeBg, italic: s.italic };
  if (s.linkLabel) {
    // When the terminal renders OSC 8 hyperlinks, wrap the label as a real clickable link (the URL
    // becomes the click target / hover) and DROP the dim " (url)" tail below — no duplication.
    // Ink passes the raw escape through <Text> unsanitized (see syncOutput's DEC-2026 wrapping), so
    // embedding it in span text reaches the terminal. The click modifier is the terminal's binding
    // (⌘ on macOS iTerm2/Terminal, Ctrl on Linux).
    if (LINKS && s.url) return { text: hyperlink(s.text, s.url), color: theme.cyan, italic: s.italic };
    return { text: s.text, color: theme.cyan, italic: s.italic };
  }
  if (s.link) {
    // The dim URL tail is only shown when we are NOT hyperlinking the label (fallback for terminals
    // without OSC 8, or a link that somehow lost its url). Otherwise it's empty — the label carries it.
    if (LINKS) return { text: '', color: theme.dim };
    return { text: s.text, color: theme.dim, italic: s.italic };
  }
  if (s.bold) return { text: s.text, color: theme.bright ?? theme.fg, bold: true, italic: s.italic };
  return { text: s.text, color: theme.fg, italic: s.italic };
}

/** Map a chart span role to theme styling: title→bright bold, label→fg, bar→cyan
 *  (the single series hue — labels/values never wear it), value/axis→dim. */
function chartSpanToStyled(s: ChartSpan, theme: ViewportTheme): StyledSpan {
  switch (s.role) {
    case 'title':
      return { text: s.text, color: theme.bright ?? theme.fg, bold: true };
    case 'label':
      return { text: s.text, color: theme.fg };
    case 'bar':
      return { text: s.text, color: theme.cyan };
    default:
      return { text: s.text, color: theme.dim };
  }
}

/**
 * Paint one rendered table line: box-drawing chrome in dim, header cell text bold+bright,
 * body cell text in fg. Vertical-fallback lines stay plain fg (or dim for `— row N —`).
 */
function tableLineSpans(line: string, theme: ViewportTheme, isHeader: boolean): StyledSpan[] {
  if (line.startsWith('—')) return [{ text: line, color: theme.dim }];
  const segs = segmentTableLine(line);
  return segs.map((seg) => {
    if (seg.kind === 'border') return { text: seg.text, color: theme.dim };
    return {
      text: seg.text,
      color: isHeader ? (theme.bright ?? theme.fg) : theme.fg,
      bold: isHeader,
    };
  });
}

function blockToLines(
  block: MdBlock,
  cols: number,
  theme: ViewportTheme,
  keyPrefix: string,
  /** When true, GFM tables with more than TABLE_COLLAPSE_THRESHOLD body rows fold to one line. */
  foldLargeTables = false,
): ViewportLine[] {
  const out: ViewportLine[] = [];
  switch (block.type) {
    case 'heading': {
      // Hierarchy: EVERY heading is bold, so it reads as a heading without relying on color (WCAG
      // 1.4.1); the level is then tinted (H1 purple, H2 cyan, H3+ fg) and H1 gets a full-width
      // underline rule for a strong top-level break.
      const hue = block.level <= 1 ? theme.purple : block.level === 2 ? theme.cyan : theme.bright ?? theme.fg;
      const spans = block.spans.map(s => ({ text: s.text, color: hue, bold: true, italic: s.italic }));
      out.push(...wrapLine(`${keyPrefix}h`, spans, cols));
      if (block.level <= 1) {
        out.push({ key: `${keyPrefix}hu`, spans: [{ text: '─'.repeat(Math.max(1, cols)), color: theme.dim }] });
      }
      break;
    }
    case 'paragraph': {
      const spans = block.spans.map(s => mdSpanToStyled(s, theme));
      out.push(...wrapLine(`${keyPrefix}p`, spans, cols));
      break;
    }
    case 'list': {
      const bullets = ['•', '◦', '▪', '‣'];
      // Number ONLY top-level ordered items, with a dedicated counter — using the global item index
      // `j` made a nested sub-bullet inflate the next top-level number (1. / ◦ sub / 3.).
      let ordinal = block.start ?? 1;
      block.items.forEach((itemSpans, j) => {
        const depth = block.depths?.[j] ?? 0;
        const indent = '  '.repeat(depth);
        const marker =
          block.ordered && depth === 0
            ? `${ordinal++}. `
            : `${bullets[Math.min(depth, bullets.length - 1)]} `;
        // Hanging wrap: continuation rows align under the TEXT (not the bullet), and the nested
        // indent survives because it lives in the prefix, not in wrappable body spans.
        out.push(
          ...wrapHanging(
            `${keyPrefix}l${j}`,
            [{ text: indent + marker, color: theme.fg }],
            [{ text: ' '.repeat(indent.length + marker.length) }],
            itemSpans.map(s => mdSpanToStyled(s, theme)),
            cols,
          ),
        );
      });
      break;
    }
    case 'quote': {
      // The │ bar repeats on EVERY wrapped row — a quote whose second line loses the bar just reads
      // as a stray dim paragraph.
      out.push(
        ...wrapHanging(
          `${keyPrefix}q`,
          [{ text: '│ ', color: theme.yellow }],
          [{ text: '│ ', color: theme.yellow }],
          block.spans.map(s => ({ text: s.text, color: theme.dim, italic: s.italic })),
          cols,
        ),
      );
      break;
    }
    case 'code': {
      // Fenced ```chart|graph|spark blocks render as REAL unicode charts (bars /
      // braille lines / sparklines) once the fence closes; while still streaming —
      // or when the spec doesn't parse — they stay an ordinary code block, so a
      // sloppy model can never crash the canvas or paint half a chart.
      if (block.closed && CHART_LANGS.has((block.lang || '').toLowerCase())) {
        try {
          const spec = parseChartSpec(block.code);
          if (spec) {
            renderChart(spec, Math.min(cols, 72)).forEach((spans, ci) => {
              out.push({
                key: `${keyPrefix}ch${ci}`,
                spans: truncateSpans(
                  spans.map((s) => chartSpanToStyled(s, theme)),
                  cols,
                ),
              });
            });
            break;
          }
        } catch {
          // parseChartSpec is strict (ambiguous specs return null and render as a code block), so a
          // throw here means a pathological VALID spec hit an edge in the geometry math. A model's
          // chart must never crash the whole canvas — fall through to the plain code block below.
        }
      }
      const codeSpans = highlight(block.code || ' ', block.lang);
      // A contained code block: a labeled top rule, a dim left gutter on each line, and a closing
      // rule — so code is visually bounded (like the reference client's boxed blocks) instead of blending
      // into prose. The gutter also makes wrapped code lines obvious.
      const label = block.lang || 'code';
      out.push({ key: `${keyPrefix}ctop`, spans: [{ text: `╭─ ${label} `, color: theme.dim }] });
      const styled = codeSpans.map(cs => ({ text: cs.text, color: codeStyle(cs.role, theme).color }));
      wrapSpans(styled, Math.max(1, cols - 2)).forEach((row, ri) => {
        out.push({ key: `${keyPrefix}c${ri}`, spans: [{ text: '│ ', color: theme.dim }, ...row] });
      });
      out.push({ key: `${keyPrefix}cbot`, spans: [{ text: '╰─', color: theme.dim }] });
      break;
    }
    case 'table': {
      const bodyRows = block.rows.length;
      // Large tables fold by default (same language as tool output). Ctrl-O / showAllExpanded
      // sets foldLargeTables=false so the full grid paints.
      if (foldLargeTables && bodyRows > TABLE_COLLAPSE_THRESHOLD) {
        const colsN = block.align.length;
        const n = `${bodyRows}×${colsN}`;
        out.push({
          key: `${keyPrefix}tfold`,
          spans: [{ text: `  ⌄ table ${n} · ^O`, color: theme.dim }],
        });
        break;
      }
      const lines = renderTableLines(block, cols);
      // Grid form: HEADER TEXT is every line between the ╭─╮ top border and the first ├─┼─┤
      // separator (wrapped header cells span several lines). Borders/│ stay dim; cells are fg.
      const isGrid = /^[╭┌]/.test(lines[0] ?? '');
      const sepIdx = isGrid ? lines.findIndex((l) => l.startsWith('├')) : -1;
      lines.forEach((l, j) => {
        const isHeader = isGrid && j > 0 && (sepIdx < 0 || j < sepIdx);
        // Char-wrap: wide vertical-fallback lines must not terminal-hard-wrap mid-word.
        out.push(...wrapLine(`${keyPrefix}t${j}`, tableLineSpans(l, theme, isHeader), cols, 'char'));
      });
      break;
    }
    case 'rule': {
      out.push({ key: `${keyPrefix}r`, spans: [{ text: '─'.repeat(Math.max(1, cols)), color: theme.dim }] });
      break;
    }
  }
  return out;
}

// ── item kind → color ─────────────────────────────────────────────────────────

function kindColor(kind: string, theme: ViewportTheme): string | undefined {
  switch (kind) {
    case 'user': return theme.user ?? theme.green;
    case 'assistant': return theme.fg;
    case 'tool': return theme.cyan;
    case 'blocked': return theme.yellow;
    case 'error': return theme.red;
    default: return undefined;
  }
}

// ── the main flattener ────────────────────────────────────────────────────────

export interface FlattenItem {
  id: number | string;
  kind: string;
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
  meta?: string;
  tight?: boolean;
  title?: string;
  severity?: string;
  lines?: { text: string; color?: string; dimColor?: boolean; bold?: boolean }[];
  /** v2 structured payloads (pinned/cell path). When present, the row renderer owns all styling
   *  and `text`/`lines` are the plain fallback used only by the stock Ink components. */
  brand?: BrandInfo;
  tool?: ToolInfo;
  /** Inline image (a `/image` echo, a `view_image` result, or a fetched markdown `![](url)`).
   *  Rendered as a durable text placeholder + the terminal's inline-image escape when supported. */
  image?: { bytes: string; mediaType: string; alt?: string; source?: string };
  /** Reasoning wall-clock (ms), when known — drives `thought for Ns` in the fold header. */
  durationMs?: number;
  /** Collaboration Mode: which model produced this assistant turn. When set, the ⏺ bullet becomes a
   *  colored `⏺ handle  provider/model` header (drawn once per turn) and the body indents under it. */
  speaker?: { handle: string; color: string; model: string };
}

/**
 * Flatten a single TranscriptItem into ViewportLines (1 terminal row each), wrapped at `cols`.
 * `collapsed` controls whether collapsible items (reasoning, large tool output) show a summary
 * or full content. P3 (collapsible blocks) drives this flag.
 */
export function flattenItem(
  item: FlattenItem,
  cols: number,
  collapsed: boolean,
  theme: ViewportTheme,
  /** True when this assistant item CONTINUES the same turn (a previous assistant item precedes it):
   *  the ⏺ turn bullet is drawn ONCE per contiguous run, so continuations get the 2-col indent only. */
  continuation = false,
  /**
   * Fold GFM tables with more than TABLE_COLLAPSE_THRESHOLD body rows to one summary line.
   * Callers pass true when global folds are collapsed (!showAllExpanded); Ctrl-O expands tables too.
   */
  foldLargeTables = false,
  /** Tool-call stacking: when this tool item is part of a run of ≥2 consecutive tools, the run
   *  collapses to one header row (pos 0 draws it; pos>0 is absorbed). Undefined = render normally. */
  toolRun?: ToolRun,
): ViewportLine[] {
  const kp = `i${item.id}`;
  const out: ViewportLine[] = [];
  const color = item.color ?? kindColor(item.kind, theme);
  // Spacing: user turns ALWAYS open with a blank line (new question = air), even if `tight` is set —
  // that's what keeps the transcript from reading as one continuous gray column. Assistant /
  // reasoning / finding respect `tight` so multi-block answers can still hug.
  const gap =
    item.kind === 'user'
      ? 1
      : item.tight
        ? 0
        : item.kind === 'assistant' || item.kind === 'reasoning' || item.kind === 'finding'
          ? 1
          : 0;
  // Gap blank line
  if (gap > 0) out.push({ key: `${kp}gap`, spans: [{ text: '' }] });

  // ── brand mark (v2: ✦ sparkle, replaces the bordered card) ──
  // No leading gap (it opens the session) and no trailing blank — the following turn's own leading
  // gap is the single separator, so we never stack two blanks (design law: one blank = block boundary).
  if (item.kind === 'banner' && item.brand) {
    renderBrand(item.brand, theme, cols).forEach((spans, i) => out.push(...wrapLine(`${kp}br${i}`, spans, cols)));
    return out;
  }

  // ── inline image (durable placeholder + terminal-native pixels when supported) ──
  // Models can't emit images; these come from /image echoes, view_image results, or fetched
  // markdown ![](url). The placeholder is text — it survives scroll-up (inline pixels usually
  // DON'T on iTerm2/Kitty), so the image is never truly lost. When the terminal supports inline
  // images, the escape paints the real pixels on the row below the placeholder.
  if (item.kind === 'image' && item.image) {
    const bytes = Buffer.from(item.image.bytes, 'base64');
    const alt = item.image.alt || 'image';
    const type = (item.image.mediaType || 'image').replace(/^image\//, '');
    out.push({
      key: `${kp}imglabel`,
      spans: truncateSpans([{ text: `🖼 ${alt} · ${type} ${formatBytes(bytes.length)}`, color: theme.dim }], cols),
    });
    const esc = IMG ? inlineImageEsc(bytes, { cols: Math.max(8, cols - 4), name: alt }) : null;
    if (esc) out.push({ key: `${kp}imgpix`, spans: [{ text: esc, color: theme.dim }] });
    return out;
  }

  // ── tool result (v2: one calm row + optional nested body) ──
  // Header is always exactly one truncated row. When `lines` are nested on the same item
  // (shell stdout / edit diff from tool_end), they render as a child: folded to one
  // `⌄ output N lines · ^O` row by default, or under a ⎿ branch when expanded / short.
  if (item.kind === 'tool' && item.tool) {
    // Tool-call stacking: a run of ≥2 consecutive tools collapses to ONE summary header so a long
    // tool-heavy turn can't flood scrollback. pos 0 draws the header; pos>0 is absorbed (no rows)
    // when collapsed. Expanded (Ctrl-O) draws the header as a summary, then every tool's own row.
    if (toolRun) {
      if (toolRun.pos > 0) {
        if (toolRun.collapsed) return out; // absorbed into the run header — emits zero rows
      } else {
        out.push({ key: `${kp}stack`, spans: truncateSpans(renderToolStack(toolRun, theme), cols) });
        if (toolRun.collapsed) return out; // collapsed: the header is the whole run
      }
    }
    out.push({ key: `${kp}tool`, spans: truncateSpans(renderToolResult(item.tool, theme), cols) });
    if (item.lines && item.lines.length > 0) {
      appendToolBody(out, kp, item.lines, collapsed, theme, cols, color, item.meta);
    }
    return out;
  }

  // ── finding (bordered card) ──
  if (item.kind === 'finding') {
    const sev = item.severity ?? 'info';
    const bColor = sev === 'error' ? theme.red : sev === 'warn' ? theme.yellow : theme.cyan;
    out.push({ key: `${kp}ft`, spans: [{ text: `╭─ ${item.title ?? 'Finding'} ─`, color: bColor }] });
    for (const line of (item.text || '').split('\n')) {
      out.push(...wrapLine(`${kp}fb`, [{ text: line, color: theme.fg }], cols - 2));
    }
    out.push({ key: `${kp}fb2`, spans: [{ text: '╰──', color: bColor }] });
    return out;
  }

  // ── reasoning (v2: ∴ thought for Ns + fold child / expanded body) ──
  if (item.kind === 'reasoning') {
    // Collapsed: header + `⌄ N lines · ^O`. Expanded: header only here; body is dim markdown below.
    renderReasoning(item.text, collapsed, theme, item.durationMs ?? 0).forEach((spans, i) =>
      out.push(...wrapLine(`${kp}rh${i}`, spans, cols)),
    );
    if (!collapsed && item.text) {
      out.push({ key: `${kp}rgap`, spans: [{ text: '' }] });
      parseMarkdown(item.text).forEach((b, bi) => {
        if (bi > 0) out.push({ key: `${kp}rbgap${bi}`, spans: [{ text: '' }] });
        for (const ln of blockToLines(b, cols - 2, theme, `${kp}rb${bi}`, foldLargeTables)) {
          out.push({ key: ln.key, spans: [{ text: '  ' }, ...ln.spans.map((s) => ({ ...s, color: theme.dim, bold: false }))] });
        }
      });
    }
    return out;
  }

  // ── user prompt (▌ bar gutter + bright body) ──
  // Hierarchy: a ▌ bar runs down EVERY line of the user turn — the first-line-only ❯ left
  // multi-line prompts indistinguishable from answer prose from row 2 on, which is exactly the
  // "user entry and answers blend together" failure. The bar is a SHAPE cue (WCAG 1.4.1: works
  // in mono/grayscale and under any color-vision deficiency), tinted theme.user so sighted users
  // get the color reinforcement too. Body is theme.fg — the same readable tier as answers, NOT
  // dim meta. Text is verbatim (no markdown pass); the bar repeats on soft-wrapped rows.
  if (item.kind === 'user' && !item.lines) {
    // Both push sites bake '❯ ' into `text` (it must survive in the plain-text fallback);
    // strip it here so the styled gutter below is the only marker.
    const userC = theme.user ?? theme.green;
    const raw = item.text.startsWith('❯ ') ? item.text.slice(2) : item.text;
    raw.split('\n').forEach((ln, i) => {
      out.push(
        ...wrapHanging(
          `${kp}u${i}`,
          [{ text: '▌ ', color: userC, bold: true }],
          [{ text: '▌ ', color: userC, bold: true }],
          [{ text: ln, color: theme.fg }],
          cols,
        ),
      );
    });
    return out;
  }

  // ── assistant (markdown) ──
  if (item.kind === 'assistant' && !item.lines) {
    // the reference client vocabulary: a ⏺ bullet in a 2-col left gutter marks the assistant turn; the body
    // aligns under it (continuation rows indented 2). This is what visually distinguishes an answer
    // from a tool/system row and anchors the turn.
    const bodyLines: ViewportLine[] = [];
    parseMarkdown(item.text).forEach((b, bi) => {
      if (bi > 0) bodyLines.push({ key: `${kp}bg${bi}`, spans: [{ text: '' }] }); // one blank between blocks
      bodyLines.push(...blockToLines(b, cols - 2, theme, `${kp}b${bi}`, foldLargeTables));
    });
    // Collaboration Mode: a seat's turn opens with a colored `⏺ handle  provider/model` header row
    // (once per turn — `!continuation`), then the body indents under it with no orange bullet, so a
    // multi-model transcript reads as a legible group chat with unambiguous per-model attribution.
    const spk = item.speaker;
    if (spk && !continuation) {
      out.push({
        key: `${kp}spk`,
        spans: [
          { text: `${ASSISTANT_DOT} `, color: spk.color },
          { text: spk.handle, color: spk.color, bold: true },
          { text: `  ${spk.model}`, color: theme.dim },
        ],
      });
    }
    bodyLines.forEach((ln, i) => {
      // ⏺ on the first line of a NEW turn only; continuation items (same turn) align under it. A
      // speaker turn already drew its header, so its body always indents (no second bullet).
      const gutter: StyledSpan = i === 0 && !continuation && !spk ? { text: `${ASSISTANT_DOT} `, color: theme.accent ?? CLAUDE_ORANGE } : { text: '  ' };
      out.push({ key: ln.key, spans: [gutter, ...ln.spans] });
    });
    return out;
  }

  // ── tool / blocked / system / banner / user / error (line-array items) ──
  const body = item.lines ?? [{ text: item.text, color, dimColor: item.dimColor, bold: item.bold }];

  // Standalone tool/blocked child (legacy sibling body, or a diff pushed without a ToolInfo
  // header). Same fold rules as the nested path: one-row ⌄ summary when collapsed.
  if ((item.kind === 'tool' || item.kind === 'blocked') && item.meta) {
    appendToolBody(out, kp, body, collapsed, theme, cols, color, item.meta);
    return out;
  }

  body.forEach((l, i) => {
    out.push(...wrapLine(`${kp}l${i}`, [{ text: l.text ?? '', color: l.color ?? color, dim: l.dimColor, bold: l.bold }], cols));
  });
  return out;
}

/**
 * Group consecutive `kind:'tool'` items into runs for tool-call stacking. Returns a map keyed by
 * item index → the run descriptor, but ONLY for items in a run of ≥2 (single tools render normally).
 * `allExpanded` (Ctrl-O) flips every run's `collapsed` false at once. One pass, O(n).
 */
export function computeToolRuns(items: FlattenItem[], allExpanded: boolean): Map<number, ToolRun> {
  const runs = new Map<number, ToolRun>();
  let i = 0;
  while (i < items.length) {
    if (items[i]!.kind !== 'tool') {
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && items[j]!.kind === 'tool') j++;
    const len = j - i;
    if (len >= 2) {
      let okCount = 0;
      let failCount = 0;
      let totalMs = 0;
      for (let k = i; k < j; k++) {
        const t = items[k]!.tool;
        if (t) {
          if (t.ok) okCount++;
          else failCount++;
          totalMs += t.durationMs;
        }
      }
      for (let k = i; k < j; k++) {
        runs.set(k, { pos: k - i, len, okCount, failCount, totalMs, collapsed: !allExpanded });
      }
    }
    i = j;
  }
  return runs;
}

/** True when this item has a foldable body (reasoning always; tool bodies over the threshold). */
export function itemIsCollapsible(item: {
  kind: string;
  lines?: unknown[];
  text?: string;
  tool?: unknown;
}): boolean {
  if (item.kind === 'reasoning') return true;
  if (item.kind === 'tool' || item.kind === 'blocked') {
    const n = item.lines?.length
      ?? (typeof item.text === 'string' && item.text ? item.text.split('\n').length : 0);
    // Header-only tool rows (tool info, no body) are never collapsible.
    if (n === 0) return false;
    return n > TOOL_BODY_COLLAPSE_THRESHOLD;
  }
  return false;
}

/**
 * Flatten the entire committed transcript into ViewportLines. `collapsedIds` controls which
 * collapsible items are collapsed. Memoizable per (items, cols, collapsedIds).
 */
export function flattenTranscript(
  items: FlattenItem[],
  cols: number,
  collapsedIds: Set<string | number>,
  theme: ViewportTheme,
): ViewportLine[] {
  const all: ViewportLine[] = [];
  for (const item of items) {
    const collapsed = itemIsCollapsible(item) && collapsedIds.has(item.id);
    // Large tables fold by default in the calm transcript view (same as the stock FlatItem path
    // with !showAllExpanded). Callers that want full grids pass foldLargeTables=false via flattenItem.
    all.push(...flattenItem(item, cols, collapsed, theme, false, true));
  }
  return all;
}
