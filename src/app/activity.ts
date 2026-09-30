// src/app/activity.ts — the activity sub-window.
//
// The transcript folds a burst of tool calls into one row (`Ran 20 commands · ✗1 failed`). This is
// where you go to see what was actually in it: a scrollable document of every call, with the full
// command and its output.
//
// It is a plain scrollable Component rather than a list-plus-pane, because the thing you are
// looking for is usually output — a stack trace, a diff, an exit code — and a two-pane layout
// spends half the width on an index you can already infer from the order.

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';

import { C } from '../tui/theme.js';
import { groupKind } from '../tui/toolDisplay.js';
import { style } from './ansi.js';
import { fitLines } from './cells.js';

/** One tool call, as the panel needs it. */
export interface ToolDetail {
  /** 1-based position in the session — the number shown beside the call. */
  n: number;
  /** The turn the call happened in — the panel groups by this with 8.7-style summaries. */
  turn: number;
  name: string;
  arg?: string;
  ok: boolean;
  durationMs: number;
  summary: string;
  /** The call's input JSON (capped), from 8.7's toolDetail shape. */
  inputJson?: string;
  /** stdout / diff / answer body, already capped at commit time. */
  body?: string[];
  meta?: string;
}

/** Per-turn summary, the activityLabel shape: counts by the display classifier. */
export function turnSummary(counts: { command: number; read: number; search: number; edit: number; other: number }): string {
  const parts: string[] = [];
  if (counts.command) parts.push(`${counts.command} command${counts.command === 1 ? '' : 's'}`);
  if (counts.edit) parts.push(`${counts.edit} edit${counts.edit === 1 ? '' : 's'}`);
  if (counts.read) parts.push(`${counts.read} file read${counts.read === 1 ? '' : 's'}`);
  if (counts.search) parts.push(`${counts.search} search${counts.search === 1 ? '' : 'es'}`);
  const other = counts.other;
  if (other) parts.push(`${other} other action${other === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'thinking only';
}

const MAX_BODY_LINES = 200;

/** Cap a captured body so the panel can never hold a multi-megabyte dump. */
export function capBody(raw: string[]): string[] {
  if (raw.length <= MAX_BODY_LINES) return raw;
  const omitted = raw.length - MAX_BODY_LINES;
  return [`… ${omitted} earlier lines omitted …`, ...raw.slice(-MAX_BODY_LINES)];
}

export class ActivityPanel implements Component {
  private offset = 0;
  private cachedWidth = -1;
  private cachedDoc: string[] | null = null;

  constructor(
    private details: ToolDetail[],
    private onClose: () => void,
    private getRows: () => number,
  ) {}

  invalidate(): void {
    this.cachedDoc = null;
  }

  handleInput(data: string): void {
    const page = Math.max(1, this.viewportRows() - 2);
    const last = Math.max(0, this.doc().length - this.viewportRows());
    switch (data) {
      case '\x1b': // Esc
      case 'q':
        this.onClose();
        return;
      case '\x1b[A':
      case 'k':
        this.offset = Math.max(0, this.offset - 1);
        return;
      case '\x1b[B':
      case 'j':
        this.offset = Math.min(last, this.offset + 1);
        return;
      case '\x1b[5~': // PgUp
        this.offset = Math.max(0, this.offset - page);
        return;
      case '\x1b[6~': // PgDn
        this.offset = Math.min(last, this.offset + page);
        return;
      case 'g':
        this.offset = 0;
        return;
      case 'G':
        this.offset = last;
        return;
      default:
        return;
    }
  }

  private viewportRows(): number {
    return Math.max(6, Math.min(this.getRows() - 6, 30));
  }

  /** The whole document, one string per row. Rebuilt only when the width changes. */
  private doc(): string[] {
    return this.cachedDoc ?? [];
  }

  private build(width: number): string[] {
    const out: string[] = [];
    const total = this.details.length;
    const failed = this.details.filter((d) => !d.ok).length;
    const tail = failed ? style.yellow(` · ✗${failed} failed`) : '';
    out.push(`  ${style.cyan('◆')} ${style.bold('Activity')} ${style.dim(`· ${total} call${total === 1 ? '' : 's'}`)}${tail}`);
    out.push('');
    if (!total) {
      out.push(style.dim('  No tool calls in this session yet.'));
      return out;
    }
    // Turn-grouped index (P1.4): 8.7's per-turn summaries (commands / edits / reads / searches)
    // computed from the DISPLAY classifier (groupKind), not hardcoded tool-name checks.
    let lastTurn = -1;
    for (const d of this.details) {
      if (d.turn !== lastTurn) {
        lastTurn = d.turn;
        const calls = this.details.filter((x) => x.turn === d.turn);
        const counts = { command: 0, read: 0, search: 0, edit: 0, other: 0 };
        for (const c of calls) {
          const k = groupKind(c.name);
          counts[k === 'list' || k === 'view' ? 'other' : k]++;
        }
        const failed = calls.filter((c) => !c.ok).length;
        const tail = failed ? style.yellow(` · ✗${failed} failed`) : '';
        out.push(`  ${style.dim(`— turn ${d.turn} —`)} ${style.dim(turnSummary(counts))}${tail}`);
      }
      const glyph = d.ok ? style.green('✓') : style.red('✗');
      const num = style.dim(String(d.n).padStart(3));
      const name = style.bold(truncateToWidth(d.name, 14, '…'));
      const secs = d.durationMs >= 100 ? style.dim(` ${(d.durationMs / 1000).toFixed(1)}s`) : '';
      out.push(`  ${glyph} ${num}  ${name}${secs}`);
      if (d.arg) {
        for (const line of wrapIndent(d.arg, width - 10)) out.push(`         ${style.fg(C.body, line)}`);
      }
      if (d.inputJson) {
        for (const line of d.inputJson.split('\n').slice(0, 6)) {
          out.push(`         ${style.dim(truncateToWidth(line, Math.max(10, width - 12), '…'))}`);
        }
      }
      if (!d.ok) out.push(`         ${style.red(truncateToWidth(d.summary, Math.max(10, width - 10), '…'))}`);
      else if (d.summary) out.push(`         ${style.dim(truncateToWidth(d.summary, Math.max(10, width - 10), '…'))}`);
      if (d.body?.length) {
        const label = d.meta === 'diff' ? 'diff' : d.meta === 'answer' ? 'answer' : 'output';
        out.push(`         ${style.dim(`⌄ ${label} ${d.body.length} lines`)}`);
        for (const line of d.body) {
          const color = line.startsWith('+') ? C.green : line.startsWith('-') ? C.red : C.dim;
          out.push(`           ${style.fg(color, truncateToWidth(line, Math.max(10, width - 12), '…'))}`);
        }
      }
      out.push('');
    }
    return out;
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width || !this.cachedDoc) {
      this.cachedWidth = width;
      this.cachedDoc = this.build(width);
    }
    const doc = this.cachedDoc;
    const rows = this.viewportRows();
    const last = Math.max(0, doc.length - rows);
    if (this.offset > last) this.offset = last;
    const window = doc.slice(this.offset, this.offset + rows);

    const hiddenAbove = this.offset;
    const hiddenBelow = Math.max(0, doc.length - this.offset - rows);
    const scroll =
      hiddenAbove || hiddenBelow
        ? style.dim(
            `  ${hiddenAbove ? `↑${hiddenAbove}` : ''}${hiddenAbove && hiddenBelow ? ' ' : ''}${hiddenBelow ? `↓${hiddenBelow}` : ''}`,
          )
        : '';
    const footer = `  ${style.dim('↑/↓ scroll · PgUp/PgDn page · g/G ends · esc close')}`;
    const body = [scroll, ...window, footer].filter((l, i) => i > 0 || l !== '');
    return fitLines(body, width);
  }
}

/** Wrap a command to the available width, indenting continuation lines. */
function wrapIndent(text: string, width: number): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];
  let rest = text.replace(/\s+/g, ' ').trim();
  while (rest && out.length < 6) {
    const cut = truncateToWidth(rest, w, '');
    if (!cut) break;
    out.push(cut);
    rest = rest.slice(cut.length);
  }
  if (rest) out[out.length - 1] = truncateToWidth(out[out.length - 1]! + '…', w, '…');
  return out;
}

