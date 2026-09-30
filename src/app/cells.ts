// src/app/cells.ts — transcript rows as pi-tui Components.
//
// The engine's contract is `render(width): string[]`. Shadow's flattener already produces one
// styled row per terminal row, so each cell here is a thin, cached adapter: it calls
// flattenItem() and converts the spans to ANSI. All the visual design (brand mark, one-row tool
// results, ADA markdown, tables, charts, diffs) is unchanged — this file only moves who owns the
// cursor.
//
// Every cell runs its output through `fitLines()` before returning. That is the single
// enforcement point the Ink architecture never had: pi-tui's main-screen renderer aborts with a
// crash log if any line exceeds the terminal width, so an over-wide row must be impossible by
// construction rather than by convention.

import type { Component } from '@earendil-works/pi-tui';
import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';

import { flattenItem, type FlattenItem, type ViewportLine } from '../tui/flatten.js';
import type { BrandInfo, ToolRun } from '../tui/rows.js';
import { renderBrand } from '../tui/rows.js';
import { groupKind, type CollapseKind } from '../tui/toolDisplay.js';
import { clampTail } from '../tui/streamCommit.js';
import { PIN_THEME, RESET, bgAnsi, lineToAnsi } from './ansi.js';

/** Left/right page margin — floats transcript content off the terminal edges. */
export const PAGE_MARGIN = 4;
/** Cap prose so lines don't run edge-to-edge on wide terminals (matches the Ink path). */
export const PROSE_MAX_COLS = 100;

/**
 * Guarantee every row fits the viewport. Cheap in the normal case (visibleWidth is cached and
 * flattenItem already wrapped to `width`); the truncate only fires on a measurement disagreement,
 * which is exactly when the old renderer deleted text or threw.
 */
export function fitLines(lines: string[], width: number): string[] {
  const w = Math.max(1, width);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (visibleWidth(l) > w) lines[i] = truncateToWidth(l, w, '…');
  }
  return lines;
}

/** Inner content width for a terminal column count. */
export function contentWidth(cols: number, kind: string): number {
  const inner = Math.max(20, cols - PAGE_MARGIN * 2);
  return kind === 'banner' ? inner : Math.min(inner, PROSE_MAX_COLS);
}

// ── committed transcript row ─────────────────────────────────────────────────

/** Identity of a run descriptor that matters to rendering — members may be a fresh array each
 *  recompute, so the cache must diff by content, not by reference. */
function runSig(run: ToolRun | undefined): string {
  return run ? `${run.pos}/${run.len}/${run.collapsed}/${run.failCount}` : '';
}

/**
 * One committed transcript item. Caches its render so an unchanged transcript costs nothing per
 * frame — the engine re-renders the live region constantly, and the app re-syncs every cell on
 * every commit, so the cache has to survive both.
 *
 * `update()` is the sync path: it diffs the render-affecting state and only invalidates the cache
 * when something actually changed. Recreating cells instead (what this class originally did from
 * its owner) defeated the width cache on every commit and re-flattened — re-parsed markdown for —
 * the entire transcript per event.
 */
export class FlatCell implements Component {
  private cachedWidth = -1;
  private cachedLines: string[] | null = null;
  private lines: ViewportLine[] = [];
  private collapsed: boolean;
  private continuation: boolean;
  private toolRun: ToolRun | undefined;
  private foldTables: boolean;
  private sig: string;

  constructor(
    private item: FlattenItem,
    collapsed: boolean,
    continuation = false,
    toolRun?: ToolRun,
    foldTables = true,
  ) {
    this.collapsed = collapsed;
    this.continuation = continuation;
    this.toolRun = toolRun;
    this.foldTables = foldTables;
    this.sig = runSig(toolRun);
  }

  /**
   * Re-sync render state in place. A no-op when nothing changed, so a routine commit (one new
   * item appended) leaves every other cell's cache intact.
   */
  update(state: { collapsed: boolean; continuation: boolean; toolRun?: ToolRun; foldTables: boolean }): void {
    const sig = runSig(state.toolRun);
    if (
      state.collapsed === this.collapsed &&
      state.continuation === this.continuation &&
      sig === this.sig &&
      state.foldTables === this.foldTables
    ) {
      return;
    }
    this.collapsed = state.collapsed;
    this.continuation = state.continuation;
    this.toolRun = state.toolRun;
    this.foldTables = state.foldTables;
    this.sig = sig;
    this.cachedLines = null;
  }

  /** The flattened rows of the most recent render — used by transcript search and /export. */
  renderedLines(): ViewportLine[] {
    return this.lines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = null;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const w = contentWidth(width, this.item.kind);
    this.lines = flattenItem(this.item, w, this.collapsed, PIN_THEME, this.continuation, this.foldTables, this.toolRun);
    const isUser = this.item.kind === 'user';
    const band = isUser ? PIN_THEME.userBg : undefined;
    const pad = ' '.repeat(Math.min(PAGE_MARGIN, Math.max(0, width - 1)));
    const out = this.lines.map((ln) => {
      const rendered = lineToAnsi(ln.spans, PIN_THEME);
      // A user turn is drawn as a FULL-BLEED band: no page margin, the fill running to both edges.
      // Only rows the flattener actually banded get the fill — the item's leading separator row is
      // part of the same item but sits outside the highlight, which is what gives the band its
      // top edge instead of bleeding into the blank line above it.
      const banded = band !== undefined && ln.spans.some((s) => s.bg === band);
      if (banded) {
        const fill = Math.max(0, width - visibleWidth(rendered));
        // The band must survive the padding, and every span closes with a reset — so the trailing
        // fill re-opens the background rather than inheriting a style that is already gone.
        return rendered + bgAnsi(band) + ' '.repeat(fill) + RESET;
      }
      if (!rendered) return '';
      return isUser ? rendered : pad + rendered;
    });
    this.cachedWidth = width;
    this.cachedLines = fitLines(out, width);
    return this.cachedLines;
  }
}

// ── live streaming tail ──────────────────────────────────────────────────────

/**
 * The in-progress assistant tail. Its text is replaced as deltas arrive; `setText` bumps a
 * revision so the cache misses only when the content actually changed.
 *
 * `clampTail` (caller-side) keeps this bounded — an open code fence or a long paragraph streams
 * into a few rows, never into a screen-tall box.
 */
export class StreamCell implements Component {
  private text = '';
  private continuation = false;
  private cachedWidth = -1;
  private cachedText = '';
  private cachedContinuation = false;
  private cachedLines: string[] | null = null;

  setText(text: string, continuation: boolean): void {
    if (text === this.text && continuation === this.continuation) return;
    this.text = text;
    this.continuation = continuation;
    this.cachedLines = null;
  }

  getText(): string {
    return this.text;
  }

  invalidate(): void {
    this.cachedLines = null;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedText === this.text && this.cachedContinuation === this.continuation) {
      return this.cachedLines;
    }
    if (!this.text.trim()) {
      this.cachedWidth = width;
      this.cachedText = this.text;
      this.cachedContinuation = this.continuation;
      this.cachedLines = [];
      return this.cachedLines;
    }
    const item: FlattenItem = {
      id: '__stream__',
      kind: 'assistant',
      text: this.text,
      tight: this.continuation,
    };
    const w = contentWidth(width, 'assistant');
    const lines = flattenItem(item, w, false, PIN_THEME, this.continuation, false);
    const pad = ' '.repeat(Math.min(PAGE_MARGIN, Math.max(0, width - 1)));
    const out = lines.map((ln) => {
      const rendered = lineToAnsi(ln.spans, PIN_THEME);
      return rendered ? pad + rendered : '';
    });
    this.cachedWidth = width;
    this.cachedText = this.text;
    this.cachedContinuation = this.continuation;
    this.cachedLines = fitLines(out, width);
    return this.cachedLines;
  }
}

// ── live-tail clamping ───────────────────────────────────────────────────────

/** A GFM table separator row: pipes, dashes, colons, spaces — nothing else. */
function isTableSeparator(line: string): boolean {
  return line.includes('|') && /^[\s|:-]+$/.test(line);
}

/**
 * Clamp the live streaming tail, table-aware.
 *
 * A plain clamp keeps the LAST `budget` lines — correct for prose, wrong for tables: a table cut
 * below its header/separator no longer parses as a table and renders as a paragraph of raw pipes
 * until the block commits. When the tail ends inside (or just after) a table whose header sits
 * within `tableBudget` lines, keep from the header row so the live preview stays a table.
 */
export function clampStreamTail(text: string, budget = 6, tableBudget = 16): string {
  const lines = text.split('\n');
  const floor = Math.max(0, lines.length - tableBudget);
  for (let i = lines.length - 1; i >= floor; i--) {
    if (!isTableSeparator(lines[i]!)) continue;
    const header = i - 1;
    if (header < floor) break;
    if (!lines[header]!.includes('|')) continue;
    return lines.slice(header).join('\n');
  }
  return clampTail(text, budget);
}

// ── plain styled lines (slash output, notices) ───────────────────────────────

/** A block of already-styled ANSI lines. Used for command output that isn't markdown. */
export class LinesCell implements Component {
  constructor(private lines: string[]) {}

  invalidate(): void {}

  render(width: number): string[] {
    const pad = ' '.repeat(Math.min(PAGE_MARGIN, Math.max(0, width - 1)));
    return fitLines(
      this.lines.map((l) => (l ? pad + l : '')),
      width,
    );
  }
}

// ── tool-run stacking ────────────────────────────────────────────────────────

/**
 * Fold a run of consecutive tool calls into ONE transcript row.
 *
 * Every call joins a run — shell, edits, reads, all of it. The earlier rule only grouped the
 * tools on a hardcoded read/search list, so a burst of twenty shell probes produced twenty rows
 * and filled the screen; shell was excluded because the grouping predicate was borrowed from the
 * SAFETY classifier, which is as conservative as a permission check and refuses anything with a
 * redirect, a `;` compound or a loop. Grouping is presentation, and whether a call is permitted is
 * decided by the permission gate before it runs — it has never depended on how the transcript
 * draws it.
 *
 * Nothing is hidden by collapsing: the summary line counts commands, edits and failures, so a
 * mutation still shows up as `✎ Edited 2 files`, and expanding the run (Ctrl-O) or opening
 * `/activity` shows every call with its full output.
 *
 * A run of one is not a run: single calls keep their own detailed row.
 */
export function computeToolRuns(items: FlattenItem[], collapsed: boolean): Map<string | number, ToolRun> {
  const runs = new Map<string | number, ToolRun>();
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    if (item.kind !== 'tool' || !item.tool) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < items.length) {
      const next = items[end + 1]!;
      if (next.kind !== 'tool' || !next.tool) break;
      end++;
    }
    const len = end - i + 1;
    if (len >= 2) {
      const members = items.slice(i, end + 1);
      const kinds: Partial<Record<CollapseKind, number>> = {};
      let okCount = 0;
      let failCount = 0;
      let totalMs = 0;
      for (const m of members) {
        const k = groupKind(m.tool!.name);
        kinds[k] = (kinds[k] ?? 0) + 1;
        if (m.tool!.ok) okCount++;
        else failCount++;
        totalMs += m.tool!.durationMs ?? 0;
      }
      const last = members[members.length - 1]!.tool!;
      members.forEach((_m, k) => {
        runs.set(members[k]!.id, {
          pos: k,
          len,
          okCount,
          failCount,
          totalMs,
          collapsed,
          kinds,
          hint: last.arg,
        });
      });
    }
    i = end + 1;
  }
  return runs;
}

// ── the welcome splash ───────────────────────────────────────────────────────

/**
 * The SHADOW wordmark, drawn in the LIVE frame rather than committed to scrollback.
 *
 * That distinction is the whole point. Scrollback is a fixed block of already-printed text: the
 * terminal re-wraps it when the window narrows, so a 51-column ASCII wordmark printed once gets
 * shredded into unreadable garbage on resize and can only be repaired by clearing scrollback —
 * the exact "resizing issue" the art was remembered for. A live-frame component is re-rendered at
 * the new width on every resize, so the art reflows between renderBrand's stacked and
 * side-by-side forms correctly and never corrupts anything.
 *
 * It is mounted only while the transcript is empty and unmounted on the first turn, so it costs
 * no rows during actual work.
 */
export class BrandSplash implements Component {
  private cachedWidth = -1;
  private cachedLines: string[] | null = null;

  constructor(
    private brand: BrandInfo,
    private art: string[],
  ) {}

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = null;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    // The splash gets the FULL width, not the prose measure: the wordmark is chrome, and the
    // extra columns are what let it sit beside the meta block instead of stacking below it.
    const w = Math.max(20, width - PAGE_MARGIN);
    const rows = renderBrand({ ...this.brand, art: this.art }, PIN_THEME, w);
    const pad = ' '.repeat(Math.min(PAGE_MARGIN, Math.max(0, width - 1)));
    const out: string[] = [''];
    for (const spans of rows) {
      const rendered = lineToAnsi(spans, PIN_THEME);
      out.push(rendered ? pad + rendered : '');
    }
    out.push('');
    this.cachedWidth = width;
    this.cachedLines = fitLines(out, width);
    return this.cachedLines;
  }
}

export type { FlattenItem };
