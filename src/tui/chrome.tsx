// src/tui/chrome.tsx — the transcript chrome components (extracted from tui.tsx, plan 2.4):
// the pinned agent-state block, the status strip, composer, and the committed FlatItem renderer.
import React from 'react';
import { Box, Text } from 'ink';
import type { PlanSnapshot } from '../agent/planMode.js';
import type { TodoItem } from '../agent/todo.js';
import { displayWidth, nextCluster } from '../util/width.js';
import {
  COMPOSER_MAX_VISIBLE_ROWS,
  COMPOSER_GUTTER,
  visibleComposerWindow,
  caretNeedsOwnRow,
} from './composer.js';
import { flattenItemCached } from './flatten.js';
import { shortPath } from './format.js';
import { PROSE_MAX_COLS } from './markdown.js';
import { NEWLINE_HINT } from './platform.js';
import { type ToolRun, type TranscriptItem } from './rows.js';
import { C } from './theme.js';

/** Left/right page margin for transcript content — floats content off the terminal edges
 *  like the reference client instead of running flush to column 1. */
export const PAGE_MARGIN = 4;
export const MARGIN_PAD = ' '.repeat(PAGE_MARGIN);

/** The single palette handed to flattenItem (the FlatItem stock renderer). `dim` is the
 *  EXPLICIT ADA gray — v2 rows use it for all de-emphasis instead of the banned faint attribute. */
// LIVE theme view for the flattener. Getters (not a snapshot!) so `/theme` re-themes the
// transcript: the old `{ fg: '#c9d2da', dim: C.dim, … }` literal froze the palette at module
// load — switching to `light` left transcript prose painted in dark-theme gray, unreadable on
// a white terminal. Every property now reads the mutable `C` singleton at render time.
const PIN_THEME = {
  get fg() { return C.body; },
  get bright() { return C.bright; },
  get dim() { return C.dim; },
  get green() { return C.green; },
  get cyan() { return C.cyan; },
  get yellow() { return C.yellow; },
  get red() { return C.red; },
  get purple() { return C.purple; },
  get user() { return C.user; },
  get accent() { return C.accent; },
  get codeBg() { return C.codeBg; },
};

/** Pinned agent state — a light, full-width block above the composer: a dim top
 *  rule, a one-line header (plan mode/title + task count), the todo items marked
 *  ✔/▶/·, then a closing rule. No borders, so it reads as part of the flow rather
 *  than a crowding card, and (unlike the old side panel) never sits beside <Static>. */
export function PinnedState({
  goal,
  plan,
  todos,
  showPlan,
  showTodo,
  collapsed,
  cols,
  maxItems,
}: {
  goal: string | null;
  plan: PlanSnapshot;
  todos: TodoItem[];
  showPlan: boolean;
  showTodo: boolean;
  collapsed: boolean;
  cols: number;
  /** Terminal-height-aware cap on visible todo rows (block chrome ≈ 6 rows worst case), so the
   *  idle pinned block can never push the live frame to terminal height on short terminals. */
  maxItems?: number;
}) {
  const planActive = plan.mode === 'planning';
  const done = todos.filter((t) => t.status === 'completed').length;
  const planLabel = showPlan
    ? `${planActive ? 'Plan mode' : 'Implement mode'}${plan.title ? ` — ${plan.title}` : ''}`
    : '';
  const todoLabel = showTodo
    ? `${collapsed ? '▸' : '▾'} Task list ${done}/${todos.length}${collapsed ? ' · Ctrl-T' : ''}`
    : '';
  // todoLabel FIRST: the row truncates right, and the task count must survive a verbose plan title.
  const header = [todoLabel, planLabel].filter(Boolean).join('   ·   ');
  // The block is inset by PAGE_MARGIN on both sides (see the Box below), so its rules measure the
  // same span as the composer's — not the full terminal width.
  const rule = '─'.repeat(Math.max(8, cols - PAGE_MARGIN * 2));
  const MAX = maxItems ?? 8;
  const shown = todos.slice(0, MAX);
  const mark = (s: TodoItem['status']) => (s === 'completed' ? '✔' : s === 'in_progress' ? '▶' : '·');
  const itemColor = (s: TodoItem['status']) =>
    s === 'in_progress' ? C.yellow : s === 'completed' ? 'gray' : undefined;
  return (
    // Every row below is wrap="truncate": this block sits in the LIVE frame, whose height budget
    // counts physical rows. A model-written 70-char todo subject (or long goal / plan path)
    // wrapping to 2+ rows on a narrow terminal blew the budget and re-armed Ink's scrollback-
    // wiping clearTerminal fallback — maxItems bounds item COUNT, truncation bounds each row.
    // paddingLeft=PAGE_MARGIN: expanded (Ctrl-T) and collapsed forms must share the transcript's
    // left edge. Without it the same task list jumped 4 columns left when you expanded it, and its
    // two rules ran the full terminal width — the loudest lines on screen.
    <Box flexDirection="column" flexShrink={0} marginTop={1} width={cols} paddingLeft={PAGE_MARGIN}>
      <Text color={C.dim}>{rule}</Text>
      {goal ? <Text wrap="truncate" bold color={C.purple}>{`🎯 Goal: ${goal}`}</Text> : null}
      {header ? (
        <Text wrap="truncate" bold color={planActive ? C.yellow : C.green}>
          {header}
        </Text>
      ) : null}
      {showPlan && plan.path ? <Text wrap="truncate" color={C.dim}>{shortPath(plan.path)}</Text> : null}
      {showTodo && !collapsed
        ? shown.map((item) => (
            <Text key={item.id} wrap="truncate" color={item.status === 'completed' ? C.dim : itemColor(item.status)}>
              {` ${mark(item.status)} ${item.subject}`}
            </Text>
          ))
        : null}
      {showTodo && !collapsed && todos.length > MAX ? (
        <Text italic color={C.dim}>{`   … +${todos.length - MAX} more`}</Text>
      ) : null}
      <Text color={C.dim}>{rule}</Text>
    </Box>
  );
}

export function StatusStrip({ text, marker }: { text: string; marker?: { text: string; color: string } }) {
  return (
    // wrap="truncate": the strip is budgeted at exactly ONE row. A verbose /statusline command
    // (customStatus renders through this too) used to wrap to several rows on narrow terminals,
    // silently blowing the frame budget and re-triggering Ink's scrollback-wiping fallback.
    // No paddingX here: the call site already insets by PAGE_MARGIN, and the two composed to a
    // 5-column indent — one off from every other chrome row, which reads as a rendering glitch.
    <Box>
      <Text wrap="truncate" color={C.dim}>
        {marker ? (
          <Text color={marker.color} bold>
            {marker.text + ' · '}
          </Text>
        ) : null}
        {text}
      </Text>
    </Box>
  );
}

export interface ChromeMarker {
  text: string;
  color: string;
  bold?: boolean;
}

/** High-priority state badges used in the composer/status chrome (privacy and guardrail state). */
export function ChromeMarkers({ markers, trailing }: { markers: ChromeMarker[]; trailing?: boolean }) {
  return (
    <>
      {markers.map((marker, i) => (
        <React.Fragment key={`${marker.text}-${i}`}>
          <Text color={marker.color} bold={marker.bold}>{marker.text}</Text>
          {i < markers.length - 1 || trailing ? <Text color={C.dim}>{' · '}</Text> : null}
        </React.Fragment>
      ))}
    </>
  );
}

/** Small chrome rows (confirmations, errors, denials) — one block when they arrive back to back. */
export function isChatter(kind: string | undefined): boolean {
  return kind === 'system' || kind === 'error' || kind === 'blocked';
}

/** Empty-composer placeholder — a dim prompt, not an example that could be mistaken for real input. */
// T1: platform-aware — macOS sends Option+Enter as ESC-prefixed; Linux terminals send Alt+Enter.
// The composer's newline branch keys on key.meta+return, so the hint names that path (Shift+Enter
// is deliberately NOT advertised — without CSI-u it sends the message instead of breaking the line).
const COMPOSER_PLACEHOLDER = `Send a message…  ( / for commands · ${NEWLINE_HINT} newline )`;

/**
 * Multi-row composer: soft-wraps long lines, keeps a real caret on any row, scrolls a window when
 * the draft is taller than COMPOSER_MAX_VISIBLE_ROWS. Open-sided rules (no L/R border).
 */
export function Composer({
  input,
  cursor,
  hint,
  markers = [],
  cols,
  maxRows = COMPOSER_MAX_VISIBLE_ROWS,
  showHint = true,
  borderColor = C.dim,
  placeholder = COMPOSER_PLACEHOLDER,
}: {
  input: string;
  cursor: number;
  hint: string;
  /** Priority badges painted before the quiet hint so warnings survive right-edge truncation. */
  markers?: ChromeMarker[];
  /** Terminal width — drives soft-wrap for caret math + paint. */
  cols: number;
  /** Max visible input rows — clamped by the caller to what the terminal height allows. */
  maxRows?: number;
  showHint?: boolean;
  borderColor?: string;
  placeholder?: string;
}) {
  const caret = Math.min(cursor, input.length);
  const empty = input.length === 0;
  // The composer sits on the SAME left edge as the transcript (PAGE_MARGIN) and stops the same
  // distance from the right — anything else reads as a misaligned column. `inner` is what's left
  // for text after the `❯ ` gutter (also the continuation indent), and it is exactly the width the
  // caret math uses, so the draft now wraps at the rule's right end instead of 8 columns short.
  const boxW = Math.max(12, cols - PAGE_MARGIN * 2);
  const inner = Math.max(8, boxW - COMPOSER_GUTTER);
  const maxV = Math.max(1, maxRows);
  let win = visibleComposerWindow(input, caret, inner, maxV);
  // A caret at the end of a row that exactly fills the width cannot paint inline (wrap="truncate"
  // would eat the CARET cell, not the text) — it gets its own row below. When the window is AT the
  // cap it yields one row to host the caret (height stays ≤ maxRows, matching composerPaintRows);
  // below the cap the extra row simply fits.
  const needCaretRow = caretNeedsOwnRow(win.lines[win.caretRow] ?? '', win.caretCol, inner);
  if (needCaretRow && win.lines.length === maxV && maxV > 1) {
    win = visibleComposerWindow(input, caret, inner, maxV - 1);
  }

  return (
    <Box flexDirection="column" flexShrink={0} width={cols} paddingLeft={PAGE_MARGIN}>
      {/* Open-sided input: top + bottom rule only. Multi-line drafts grow up to
          COMPOSER_MAX_VISIBLE_ROWS, then scroll around the caret. */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={borderColor}
        borderLeft={false}
        borderRight={false}
        paddingX={0}
        width={boxW}
      >
        {empty ? (
          <Text wrap="truncate">
            <Text color={C.dim}>{'❯ '}</Text>
            <Text inverse> </Text>
            {/* The full placeholder is 58 cols + gutter + caret = 61; below ~69 terminal cols it
                wrapped to a SECOND row — an idle composer 4 rows tall where every height budget
                assumes 3. Ladder to the short form when it can't fit one row; truncate is the
                final guard for the narrowest terminals. */}
            <Text color={C.dim}>
              {boxW < displayWidth(placeholder) + 3 ? 'Send a message…' : placeholder}
            </Text>
          </Text>
        ) : (
          win.lines.map((line, ri) => {
            const gutter = ri === 0 && win.offset === 0 ? '❯ ' : '  ';
            const onCaretRow = ri === win.caretRow;
            if (!onCaretRow || needCaretRow) {
              return (
                <Text key={ri} wrap="truncate">
                  <Text color={C.dim}>{gutter}</Text>
                  {line || ' '}
                </Text>
              );
            }
            // Caret cell = the WHOLE grapheme cluster under the caret (slice(col, col+1) painted
            // half an emoji as mojibake). At the row end it is a plain space.
            const col = Math.min(win.caretCol, line.length);
            let before = line;
            let at = ' ';
            let after = '';
            if (col < line.length) {
              const cluster = nextCluster(line, col);
              before = line.slice(0, col);
              at = cluster;
              after = line.slice(col + cluster.length);
            }
            return (
              <Text key={ri} wrap="truncate">
                <Text color={C.dim}>{gutter}</Text>
                {before}
                <Text inverse>{at}</Text>
                {after}
              </Text>
            );
          })
        )}
        {needCaretRow && !empty ? (
          // The borrowed caret row: continuation indent + the inverse cell alone.
          <Text wrap="truncate">
            <Text color={C.dim}>{'  '}</Text>
            <Text inverse> </Text>
          </Text>
        ) : null}
      </Box>
      {showHint ? (
        <Text wrap="truncate" color={C.dim}>
          <ChromeMarkers markers={markers} trailing={markers.length > 0 && hint.length > 0} />
          {hint}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Render a committed transcript item using the v2 flatten output (the SAME styling the pinned
 * renderer produces: ✦ brand, one-row tool results, ADA markdown), but as plain Ink <Text> rows
 * inside <Static>. This is the reference-client architecture — Ink owns the cursor and native scrollback, so the
 * whole scroll-region/absolute-paint bug class is structurally impossible — with the v2 look intact.
 * A left page margin (PAGE_MARGIN) insets content off the terminal edge.
 */
export function FlatItem({
  item,
  cols,
  collapsed,
  continuation = false,
  foldLargeTables = true,
  toolRun,
}: {
  item: TranscriptItem;
  cols: number;
  collapsed: boolean;
  continuation?: boolean;
  /** When true (default), GFM tables with many body rows fold to `⌄ table N×M · ^O`. */
  foldLargeTables?: boolean;
  /** Tool-call stacking descriptor (set only for items in a run of ≥2 consecutive tools). */
  toolRun?: ToolRun;
}) {
  const inner = Math.max(20, cols - PAGE_MARGIN * 2);
  const w = item.kind === 'banner' ? inner : Math.min(inner, PROSE_MAX_COLS);
  // P3-03: epoch-independent memo — a <Static key={staticEpoch}> remount recreates every FlatItem
  // (in-component useMemo would die with it), so the cache lives in flatten.ts, a WeakMap keyed on
  // the ITEM OBJECT (ids restart at 0 per TuiApp mount and would collide across instances) with the
  // layout inputs as the variant key. Ctrl-O at unchanged width reuses the wrap work; only items
  // whose fold/layout actually changed re-flatten.
  const lines = flattenItemCached(
    item as Parameters<typeof flattenItemCached>[0],
    w,
    collapsed,
    PIN_THEME,
    continuation,
    foldLargeTables,
    toolRun,
  );
  return (
    <Box flexDirection="column" paddingLeft={PAGE_MARGIN}>
      {lines.map((ln) => {
        const empty = ln.spans.every((s) => s.text === '');
        if (empty) return <Text key={ln.key}> </Text>; // preserve block-gap blank lines
        return (
          <Text key={ln.key} wrap="truncate">
            {ln.spans.map((s, i) => (
              <Text
                key={i}
                color={s.color ?? (s.dim ? C.dim : undefined)}
                backgroundColor={s.bg}
                bold={s.bold}
                italic={s.italic}
              >
                {s.text}
              </Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
}
