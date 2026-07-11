// src/tui/rows.ts — Shadow TUI v2 visual language: PURE transcript-row renderers.
//
// These build the redesigned transcript rows (brand mark, tool results, reasoning) as StyledSpan
// rows — no Ink, no ANSI, no wrapping. flattenItem() calls them and handles wrapping; the stock
// FlatItem renderer maps the spans to Ink <Text> children. Because they're pure and unwrapped, the
// golden tests assert the exact span structure (the "parity oracle").
//
// Design law (TUI-REDESIGN.md): dim-first hierarchy, ONE glyph carries state, no boxes, 2-space
// child indent. Quiet text uses the EXPLICIT `theme.dim` gray — never the faint SGR-2 attribute,
// which the ADA pass banned as unreadable.

import type { StyledSpan, ViewportTheme } from './flatten.js';

/** The dot separator used throughout the chrome + meta rows. */
const SEP = ' · ';

// ── brand mark (replaces the bordered welcome card) ───────────────────────────

export interface BrandInfo {
  version: string;
  /** "provider/model", e.g. "openai/LUMIX-35B". */
  providerModel: string;
  /** Workspace root — shown verbatim (may be long; wrapping is fine). */
  workspace: string;
  /** Slash-hint line, e.g. "/help · /model · Shift+Tab mode". */
  help: string;
  /** Bypass/YOLO active → a bright warning row. */
  yolo?: boolean;
  /** ASCII wordmark lines. Rendered borderless when it fits `cols`; else the compact ✦ form. */
  art?: string[];
}

/**
 * The brand mark that opens a session. When the terminal is wide enough, the SHADOW wordmark is
 * rendered BORDERLESS (the box is what broke on every renderer swap) in a two-tone cyan for depth,
 * followed by a ✦ meta line; on a narrow terminal it degrades to the compact ✦ name form. Either
 * way it scrolls off into history like any other transcript block. A yellow YOLO row when active.
 */
export function renderBrand(b: BrandInfo, theme: ViewportTheme, cols: number): StyledSpan[][] {
  const rows: StyledSpan[][] = [];
  const width = (spans: StyledSpan[]): number => spans.reduce((n, s) => n + s.text.length, 0);
  const art = b.art ?? [];
  const artW = art.length ? Math.max(...art.map((l) => l.length)) : 0;

  // The meta block: version, model, workspace, hints, and (when active) the YOLO warning.
  const meta: StyledSpan[][] = [
    [
      { text: '✦ ', color: theme.cyan, bold: true },
      { text: `v${b.version}`, color: theme.fg, bold: true },
    ],
    [{ text: b.providerModel, color: theme.dim }],
    [{ text: b.workspace, color: theme.dim }],
    [{ text: b.help, color: theme.dim }],
  ];
  if (b.yolo) meta.push([{ text: '⚠ yolo — all permission checks disabled', color: theme.yellow, bold: true }]);
  const metaW = Math.max(...meta.map(width));
  const GAP = 4;

  // Two-column: wordmark hard-left, meta block right-aligned to the terminal edge. The meta sits as
  // one left-aligned block whose right side hugs `cols`, so the header spans the full current width.
  if (art.length && artW + GAP + metaW <= cols) {
    const pad = cols - metaW - artW; // constant → meta left edge is a clean column, not ragged
    const n = Math.max(art.length, meta.length);
    for (let i = 0; i < n; i++) {
      const line: StyledSpan[] = [];
      const hasArt = i < art.length;
      if (hasArt) {
        const t = art.length > 1 ? i / (art.length - 1) : 0;
        line.push({ text: art[i]!.padEnd(artW), color: t < 0.5 ? theme.cyan : theme.dim, bold: t < 0.5 });
      } else {
        line.push({ text: ' '.repeat(artW) });
      }
      if (meta[i]) line.push({ text: ' '.repeat(pad) }, ...meta[i]!);
      rows.push(line);
    }
    return rows;
  }

  // Stacked: wordmark fits width but not beside the meta → wordmark, then meta below.
  if (art.length && artW + 2 <= cols) {
    art.forEach((l, i) => {
      const t = art.length > 1 ? i / (art.length - 1) : 0;
      rows.push([{ text: l, color: t < 0.5 ? theme.cyan : theme.dim, bold: t < 0.5 }]);
    });
    rows.push([{ text: '' }]);
    rows.push(...meta.map((spans, i) => (i === 0 ? spans : [{ text: '  ' }, ...spans])));
    return rows;
  }

  // Compact: too narrow for the wordmark at all → the ✦ name form. The meta joins onto ONE line
  // only when it fits; otherwise each segment gets its own row — word-wrap would split the
  // workspace PATH mid-token ("…/shad / ow-cli"), the ugliest possible header.
  rows.push([
    { text: '✦ ', color: theme.cyan, bold: true },
    { text: 'shadow', color: theme.fg, bold: true },
    { text: `  v${b.version}`, color: theme.dim },
  ]);
  const joined = `  ${b.providerModel}${SEP}${b.workspace}${SEP}${b.help}`;
  if (joined.length <= cols) {
    rows.push([{ text: joined, color: theme.dim }]);
  } else {
    for (const seg of [b.providerModel, b.workspace, b.help]) {
      rows.push([{ text: `  ${seg}`, color: theme.dim }]);
    }
  }
  if (b.yolo) rows.push([{ text: '  ⚠ yolo — all permission checks disabled', color: theme.yellow, bold: true }]);
  return rows;
}

// ── tool result (one calm row, glyph carries status) ──────────────────────────

export interface ToolInfo {
  /** Tool name, e.g. "run_shell". */
  name: string;
  /** One-line input preview, e.g. "npm test" (optional). */
  arg?: string;
  ok: boolean;
  durationMs: number;
  /** One-line result summary, e.g. "630 pass". */
  summary: string;
}

/** Elapsed as "(10.2s)"; sub-100ms calls omit it (noise, and rounds to 0.0s). */
function elapsed(durationMs: number): string {
  if (durationMs < 100) return '';
  const s = durationMs / 1000;
  return s >= 60 ? ` (${Math.floor(s / 60)}m ${Math.round(s % 60)}s)` : ` (${s.toFixed(1)}s)`;
}

/** Display form of a tool arg: protocol stripped (URLs read as domain/path, the reference client way)
 *  and middle-truncated so one arg can never flood the row. */
function shortArg(arg: string, max = 56): string {
  let a = arg.replace(/^https?:\/\//, '');
  if (a.length > max) a = `${a.slice(0, Math.ceil(max * 0.62))}…${a.slice(a.length - Math.floor(max * 0.34))}`;
  return a;
}

/** Escape a string for use as a literal inside a RegExp. */
function reEsc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** De-noise a tool summary: drop any repetition of the arg/URL the row already shows. web_fetch
 *  summaries read "Fetched <same url> (HTTP 200…)" — the URL printed twice wrapped every row. The
 *  removal is TOKEN-anchored (whitespace/edges), so it never eats the arg out of a larger word —
 *  arg "error" must not turn "terror and errors" into "t and s". */
function shortSummary(summary: string, arg: string | undefined, max = 90): string {
  let s = summary;
  if (arg) {
    for (const token of [arg, arg.replace(/^https?:\/\//, '')]) {
      if (!token) continue;
      // Only strip the token when it stands alone (bounded by whitespace/start/end/punctuation),
      // not when it's a substring of another word.
      s = s.replace(new RegExp(`(^|[\\s(])${reEsc(token)}(?=$|[\\s).,;:—–-])`, 'g'), '$1').replace(/\s{2,}/g, ' ').trim();
    }
  }
  s = s.replace(/^[-—–:,.]\s*/, '').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/**
 * One-row tool result: `✓ run_shell npm test — 630 pass (10.2s)`. The glyph (green ✓ / red ✗) is the
 * ONLY color — name, arg, summary and timing all sit in the quiet gray so a wall of tool calls reads
 * as texture, not noise. The name is printed exactly once.
 */
/** The signature bullet: ⏺ on macOS, ● elsewhere (the reference client figures.ts). */
const TOOL_DOT = process.platform === 'darwin' ? '⏺' : '●';

export function renderToolResult(t: ToolInfo, theme: ViewportTheme): StyledSpan[] {
  // A single ⏺ dot whose COLOR carries state (green ok / red error) — not a ✓/✗ shape swap. Bold
  // tool name, args in parens 'Name(args)', summary + elapsed as a dim tail. (the reference client vocabulary.)
  const spans: StyledSpan[] = [
    { text: `${TOOL_DOT} `, color: t.ok ? theme.green : theme.red },
    { text: t.name, color: theme.bright ?? theme.fg, bold: true },
  ];
  if (t.arg) spans.push({ text: `(${shortArg(t.arg)})`, color: theme.dim });
  const s = t.summary ? shortSummary(t.summary, t.arg) : '';
  if (s) spans.push({ text: ` — ${s}`, color: theme.dim });
  const e = elapsed(t.durationMs);
  if (e) spans.push({ text: e, color: theme.dim });
  return spans;
}

/** Collapsed child of a tool call (output / diff): `  ⌄ output 29 lines · ^O`, +2 indent, dim. */
export function renderToolChild(label: string, lineCount: number, theme: ViewportTheme): StyledSpan[] {
  const n = lineCount === 1 ? '1 line' : `${lineCount} lines`;
  return [{ text: `  ⌄ ${label} ${n} · ^O`, color: theme.dim }];
}

// ── reasoning (one summary row + expandable body) ─────────────────────────────

/**
 * ✻ reasoning: collapsed → a single quiet row with the line count; expanded → a header plus the
 * full thought in gray italic (+2 indent). The star matches the "thinking" spinner glyph. Raw
 * thought never streams into the transcript live — it commits here, after the fact.
 */
export function renderReasoning(_text: string, collapsed: boolean, theme: ViewportTheme): StyledSpan[][] {
  // The ∴ Thinking HEADER only. Same glyph + label in both states (the reference client parity); collapsed
  // adds a dim '(ctrl+o to expand)' hint, expanded shows just the header and flattenItem renders the
  // thought body as dim markdown below it. (Was '✻ thought · N lines · ^O' — three inconsistent forms.)
  const header: StyledSpan[] = [
    { text: '∴ ', color: theme.cyan },
    { text: 'Thinking', color: theme.dim, italic: true },
  ];
  if (collapsed) return [[...header, { text: '  (ctrl+o to expand)', color: theme.dim }]];
  return [header];
}
