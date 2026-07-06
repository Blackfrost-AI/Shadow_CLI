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
import { renderBrand, renderToolResult, renderToolChild, renderReasoning } from './rows.js';
import type { BrandInfo, ToolInfo } from './rows.js';

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
  for (const sp of spans) {
    const parts = sp.text.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) flush();
      // Tokenize into word / whitespace runs, styling each with the span's format.
      for (const tok of parts[p]!.split(/(\s+)/)) {
        if (tok === '') continue;
        const isSpace = /^\s+$/.test(tok);
        if (isSpace) {
          if (curLen === 0) continue; // never lead a row with the wrap-point space
          if (curLen + tok.length <= w) {
            cur.push({ ...sp, text: tok });
            curLen += tok.length;
          } else {
            flush(); // the space IS the wrap point
          }
          continue;
        }
        if (curLen + tok.length <= w) {
          cur.push({ ...sp, text: tok });
          curLen += tok.length;
          continue;
        }
        // Doesn't fit. Start a fresh row (dropping any trailing space), then hard-split if the
        // token alone is wider than the measure.
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
  // Inline code → cyan on a subtle chip (the bg is the non-color cue). Link URL tail → dim.
  // Bold gets the BRIGHT tier so it pops against the softer body gray (weight + brightness).
  if (s.code) return { text: s.text, color: theme.cyan, bg: theme.codeBg, italic: s.italic };
  if (s.link) return { text: s.text, color: theme.dim, italic: s.italic };
  if (s.bold) return { text: s.text, color: theme.bright ?? theme.fg, bold: true, italic: s.italic };
  return { text: s.text, color: theme.fg, italic: s.italic };
}

function blockToLines(block: MdBlock, cols: number, theme: ViewportTheme, keyPrefix: string): ViewportLine[] {
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
        const spans: StyledSpan[] = [
          { text: indent + marker, color: theme.fg },
          ...itemSpans.map(s => mdSpanToStyled(s, theme)),
        ];
        out.push(...wrapLine(`${keyPrefix}l${j}`, spans, cols));
      });
      break;
    }
    case 'quote': {
      const spans: StyledSpan[] = [
        { text: '│ ', color: theme.yellow },
        ...block.spans.map(s => ({ text: s.text, color: theme.dim, italic: s.italic })),
      ];
      out.push(...wrapLine(`${keyPrefix}q`, spans, cols));
      break;
    }
    case 'code': {
      const codeSpans = highlight(block.code || ' ', block.lang);
      // A contained code block: a labeled top rule, a dim left gutter on each line, and a closing
      // rule — so code is visually bounded (like Claude Code's boxed blocks) instead of blending
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
      const lines = renderTableLines(block, cols);
      lines.forEach((l, j) => {
        // Wrap each table line at cols — the wide-table vertical fallback ("key: <long value>") can
        // exceed the width, and an unwrapped over-long line gets hard-char-wrapped by the terminal
        // (the mid-word DOS look the redesign killed everywhere else).
        out.push(...wrapLine(`${keyPrefix}t${j}`, [{ text: l, color: j === 0 ? theme.bright ?? theme.fg : theme.fg, bold: j === 0 }], cols, 'char'));
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
    case 'user': return theme.green;
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
): ViewportLine[] {
  const kp = `i${item.id}`;
  const out: ViewportLine[] = [];
  const color = item.color ?? kindColor(item.kind, theme);
  const gap = item.tight
    ? 0
    : item.kind === 'user' || item.kind === 'assistant' || item.kind === 'reasoning' || item.kind === 'finding'
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

  // ── tool result (v2: one calm row, glyph carries status) ──
  if (item.kind === 'tool' && item.tool) {
    // ONE row, always: a tool line that wraps to 2-3 rows (long URLs) is the single biggest
    // source of transcript noise. Truncate with an ellipsis; Ctrl-O children carry the detail.
    out.push({ key: `${kp}tool`, spans: truncateSpans(renderToolResult(item.tool, theme), cols) });
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

  // ── reasoning (v2: ✻ summary row + expandable body) ──
  if (item.kind === 'reasoning') {
    renderReasoning(item.text, collapsed, theme).forEach((spans, i) =>
      out.push(...wrapLine(`${kp}r${i}`, spans, cols)),
    );
    return out;
  }

  // ── assistant (markdown) ──
  if (item.kind === 'assistant' && !item.lines) {
    const blocks = parseMarkdown(item.text);
    blocks.forEach((b, bi) => {
      // One blank line between blocks — the block-boundary rhythm (matches the streamed committer's
      // pad spacing, so a fully-rendered item reads the same as one streamed unit-by-unit).
      if (bi > 0) out.push({ key: `${kp}bg${bi}`, spans: [{ text: '' }] });
      out.push(...blockToLines(b, cols, theme, `${kp}b${bi}`));
    });
    return out;
  }

  // ── tool / blocked / system / banner / user / error (line-array items) ──
  const body = item.lines ?? [{ text: item.text, color, dimColor: item.dimColor, bold: item.bold }];
  const tag = (item.kind === 'tool' || item.kind === 'blocked') && item.meta ? `⎿ ${item.meta} ` : '';

  if (collapsed && (item.kind === 'tool' || item.kind === 'blocked')) {
    const label = item.meta ?? 'output';
    out.push({ key: `${kp}c`, spans: renderToolChild(label, body.length, theme) });
    return out;
  }

  body.forEach((l, i) => {
    const prefix = i === 0 ? tag : '';
    out.push(...wrapLine(`${kp}l${i}`, [{ text: prefix + (l.text ?? ''), color: l.color ?? color, dim: l.dimColor, bold: l.bold }], cols));
  });
  return out;
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
    const isCollapsible =
      item.kind === 'reasoning' ||
      ((item.kind === 'tool' || item.kind === 'blocked') &&
        (item.lines?.length ?? (item.text?.split('\n').length ?? 1)) > 8);
    const collapsed = isCollapsible && collapsedIds.has(item.id);
    all.push(...flattenItem(item, cols, collapsed, theme));
  }
  return all;
}
