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
import { displayWidth } from '../util/width.js';
import {
  displayToolArg,
  displayToolName,
  formatReconSummary,
  type CollapseKind,
} from './toolDisplay.js';

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
  // Measure in DISPLAY COLUMNS (.length miscounts CJK/emoji meta — a wide model name made the
  // right-aligned meta block overflow the terminal edge).
  const width = (spans: StyledSpan[]): number => spans.reduce((n, s) => n + displayWidth(s.text), 0);
  const art = b.art ?? [];
  const artW = art.length ? Math.max(...art.map((l) => displayWidth(l))) : 0;

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
  /** Subagent (`agent` tool) attribution — rendered distinctly (▸ type · description) so a
   *  delegated sub-agent is visible at a glance instead of an anonymous `agent(prompt)` row. */
  agent?: { subagentType?: string; description?: string };
}

/** A run of consecutive COLLAPSIBLE tools (reads/searches) folded into ONE row.
 *  Writes/edits/shell never join a run — they always render as their own row so you can
 *  see when the agent is mutating the workspace. `collapsed` is the run-level state —
 *  Ctrl-O (show-all-expanded) flips it for every run at once. */
export interface ToolRun {
  /** This item's 0-based position within the run. */
  pos: number;
  /** Run length (≥ 2; single tools never stack). */
  len: number;
  okCount: number;
  failCount: number;
  totalMs: number;
  collapsed: boolean;
  /** Per-kind counts for the Claude-style summary (`Read 3 files, Grep 2 patterns`). */
  kinds: Partial<Record<CollapseKind, number>>;
  /** Optional last path/pattern shown as a dim hint on the collapsed line. */
  hint?: string;
}

/** Elapsed as "(10.2s)"; sub-100ms calls omit it (noise, and rounds to 0.0s). */
function elapsed(durationMs: number): string {
  if (durationMs < 100) return '';
  const s = durationMs / 1000;
  return s >= 60 ? ` (${Math.floor(s / 60)}m ${Math.round(s % 60)}s)` : ` (${s.toFixed(1)}s)`;
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
    const cleaned = displayToolArg(arg, 200);
    for (const token of [arg, cleaned, arg.replace(/^https?:\/\//, ''), arg.replace(/^\$\s+/, '')]) {
      if (!token || token.length < 2) continue;
      // Only strip the token when it stands alone (bounded by whitespace/start/end/punctuation),
      // not when it's a substring of another word.
      s = s.replace(new RegExp(`(^|[\\s(])${reEsc(token)}(?=$|[\\s).,;:—–-])`, 'g'), '$1').replace(/\s{2,}/g, ' ').trim();
    }
  }
  // Drop the model-facing "Edited \"path\" — replaced N…" prefix once the row already shows
  // Update(path) + a +N −M tail — leaves just the stats or a short remainder.
  s = s
    .replace(/^(?:Edited|Wrote|Created|Updated)\s+(?:"[^"]*"|'[^']*'|\S+)\s*[—–-]\s*/i, '')
    .replace(/^replaced\s+\d+\s+occurrence\(s\)\.?\s*/i, '')
    .replace(/^[-—–:,.]\s*/, '')
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

/**
 * One-row tool result: `⏺ Update(src/tui.tsx) — +12 −3 (0.4s)`. The glyph (green ⏺ / red ✗) is the
 * ONLY color — name, arg, summary and timing all sit in the quiet gray so a wall of tool calls reads
 * as texture, not noise. Display names are human verbs (Read/Update/Bash), never snake_case.
 */
/** The signature bullet: ⏺ on macOS, ● elsewhere (the reference client figures.ts). */
const TOOL_DOT = process.platform === 'darwin' ? '⏺' : '●';

export function renderToolResult(t: ToolInfo, theme: ViewportTheme): StyledSpan[] {
  // Success keeps the calm ⏺ dot; FAILURE swaps the shape to a bold ✗ (WCAG 1.4.1: green-vs-red
  // on an identical glyph is invisible to red-green CVD and in mono — the state must survive
  // with color removed). Failures are rare, so the shape change is signal, not noise. Bold tool
  // name, args in parens 'Name(args)', summary + elapsed as a dim tail. (the reference client vocabulary.)
  const spans: StyledSpan[] = [
    t.ok
      ? { text: `${TOOL_DOT} `, color: theme.green }
      : { text: '✗ ', color: theme.red, bold: true },
  ];
  // Subagent calls render distinctly: `▸ <type> · <description>` instead of the anonymous
  // `agent(prompt)`, so a delegated sub-agent is visible at a glance. The ▸ marker signals
  // delegation; the type (explore / reviewer / …) and the caller-supplied description name the
  // work. Falls back to the generic `name(arg)` form when agent attribution is absent.
  if (t.name === 'agent' && t.agent) {
    const type = t.agent.subagentType ?? 'subagent';
    const desc = t.agent.description ?? (t.arg ? displayToolArg(t.arg) : '');
    spans.push(
      { text: '▸ ', color: theme.cyan },
      { text: type, color: theme.bright ?? theme.fg, bold: true },
    );
    if (desc) spans.push({ text: ` · ${desc}`, color: theme.dim });
  } else {
    const label = displayToolName(t.name);
    const arg = displayToolArg(t.arg);
    spans.push({ text: label, color: theme.bright ?? theme.fg, bold: true });
    if (arg) spans.push({ text: `(${arg})`, color: theme.dim });
  }
  const s = t.summary ? shortSummary(t.summary, t.arg) : '';
  if (s) spans.push({ text: ` — ${s}`, color: theme.dim });
  const e = elapsed(t.durationMs);
  if (e) spans.push({ text: e, color: theme.dim });
  return spans;
}

/**
 * Collapsed header for a run of consecutive read/search tools — the "tool-call stacking" that
 * keeps recon from flooding scrollback:
 *   `⏺ Read 3 files, Grep 2 patterns · (1.2s) · ⌄ ^O`
 * Writes/edits/shell NEVER enter a run (see computeToolRuns), so mutations stay one-row visible.
 * The dot is green when every call succeeded, red as soon as one failed (shape+color, WCAG 1.4.1).
 * Ctrl-O expands the run to the full per-tool ledger (each tool then renders via renderToolResult).
 */
export function renderToolStack(run: ToolRun, theme: ViewportTheme): StyledSpan[] {
  const headline = formatReconSummary(run.kinds, { fallbackLen: run.len });

  const spans: StyledSpan[] = [
    { text: `${TOOL_DOT} `, color: run.failCount > 0 ? theme.red : theme.green },
    { text: headline, color: theme.bright ?? theme.fg, bold: true },
  ];
  if (run.hint && run.collapsed) {
    spans.push({ text: ` · ${displayToolArg(run.hint, 40)}`, color: theme.dim });
  }
  if (run.failCount > 0) {
    spans.push({ text: ` · ✗${run.failCount}`, color: theme.dim });
  }
  const e = elapsed(run.totalMs);
  if (e) spans.push({ text: e, color: theme.dim });
  if (run.collapsed) spans.push({ text: ' · ⌄ ^O', color: theme.dim }); // expand hint
  return spans;
}

/** Collapsed child of a tool call (output / diff): `  ⌄ output 29 lines · ^O`, +2 indent, dim. */
export function renderToolChild(label: string, lineCount: number, theme: ViewportTheme): StyledSpan[] {
  const n = lineCount === 1 ? '1 line' : `${lineCount} lines`;
  return [{ text: `  ⌄ ${label} ${n} · ^O`, color: theme.dim }];
}

// ── reasoning (one summary row + expandable body) ─────────────────────────────

/**
 * Collapsed reasoning (default):
 *   ∴ thought for 9s
 *     ⌄ 26 lines · ^O
 * Expanded: header only — flattenItem paints the body as dim markdown underneath.
 * `durationMs` is optional (unknown for some providers); falls back to "Thinking".
 */
export function renderReasoning(
  text: string,
  collapsed: boolean,
  theme: ViewportTheme,
  durationMs = 0,
): StyledSpan[][] {
  const lineCount = text ? text.split('\n').length : 0;
  let label = 'Thinking';
  if (durationMs >= 1000) {
    // Branch on the ROUNDED seconds, not raw ms: 59.7s rounds to 60 and must render '1m 0s',
    // never the impossible 'thought for 60s'.
    const s = Math.round(durationMs / 1000);
    label = s >= 60 ? `thought for ${Math.floor(s / 60)}m ${s % 60}s` : `thought for ${s}s`;
  } else if (durationMs >= 100) {
    label = `thought for ${(durationMs / 1000).toFixed(1)}s`;
  }
  const header: StyledSpan[] = [
    { text: '∴ ', color: theme.cyan },
    { text: label, color: theme.dim, italic: true },
  ];
  if (!collapsed) return [header];
  const n = lineCount === 1 ? '1 line' : `${Math.max(lineCount, 1)} lines`;
  return [header, [{ text: `  ⌄ ${n} · ^O`, color: theme.dim }]];
}
