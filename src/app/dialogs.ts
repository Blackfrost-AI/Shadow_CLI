import { BORDER, GLYPHS, SPACING } from '../tui/glyphs.js';
// src/app/dialogs.ts — the approval and question overlays.
//
// This is the safety surface: everything an autonomous agent is allowed to do to the user's
// machine passes through the component in this file. The hardened semantics from the 4.0 review
// are preserved deliberately, not re-derived:
//
//   * The preview keeps BOTH ends. One truncated row let a command hide its own tail
//     (`git status` + padding + `; rm -rf ~/Documents` read as "$ git status"), so a long body is
//     laid out across rows and anything still hidden is counted on screen.
//   * Keys that arrived before the dialog was visible never count as a decision. The 275 ms
//     arming window lives in the app's input listener (the dialog exposes `shownAt`), so
//     type-ahead aimed at the composer cannot approve a tool the user has not read.
//   * The question path and the permission path share one component and one key handler, so a
//     key can only mean what the visible legend says it means.

import type { Component } from '@earendil-works/pi-tui';
import { visibleWidth, truncateToWidth, isKeyRelease, matchesKey } from '@earendil-works/pi-tui';

import type { ApprovalDecision, ApprovalRequest, UserQuestion } from '../agent/approval.js';
import type { AutonomyLevel } from '../safety/permissions.js';
import { raiseAutonomy } from '../safety/permissions.js';
import { recommendedIndex, type QuestionSelection } from '../tui/questions.js';
import { C } from '../tui/theme.js';
import { style } from './ansi.js';
import { fitLines } from './cells.js';
import { approvalText } from '../util/approvalText.js';

/** Faint slate panel behind menus/overlays — themes override via `menuBg`. */
function menuBg(): string {
  return C.panel ?? C.menuBg;
}
function menuSelBg(): string {
  return C.selection ?? C.menuSelBg;
}

/** The dialog's fixed bar width: never edge-to-edge, never wider than a comfortable measure. */
export function barWidth(cols: number, pageMargin: number): number {
  return Math.max(24, Math.min(cols - pageMargin * 2 - 1, 74));
}

/** Lay styled text out with a background fill across `width` columns, clipped on a grapheme. */
function fill(text: string, width: number, bg: string): string {
  const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, '…') : text;
  const pad = Math.max(0, width - visibleWidth(clipped));
  const background = `\x1b[48;2;${hex(bg)}m`;
  return background + clipped.replaceAll('\x1b[0m', '\x1b[0m' + background) + ' '.repeat(pad) + '\x1b[0m';
}

function hex(h: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) return '27;35;49';
  const v = m[1]!;
  return `${parseInt(v.slice(0, 2), 16)};${parseInt(v.slice(2, 4), 16)};${parseInt(v.slice(4, 6), 16)}`;
}

/**
 * Lay the approval preview across up to `maxRows` rows, keeping BOTH ends visible. Returns the
 * rows plus how many characters were dropped, so the dialog can state that plainly rather than
 * letting a hidden tail pass for the whole command.
 */
export function previewRows(
  text: string,
  firstWidth: number,
  contWidth: number,
  maxRows: number,
): { rows: string[]; hidden: number } {
  const rows: string[] = [];
  let rest = approvalText(text);
  for (let r = 0; r < maxRows && rest !== ''; r++) {
    const width = Math.max(1, r === 0 ? firstWidth : contWidth);
    if (r < maxRows - 1) {
      const cut = truncateToWidth(rest, width, '');
      if (cut === '') {
        // A single grapheme wider than the row (a fullwidth glyph at width 1) — take it anyway
        // rather than looping forever.
        const one = [...rest][0] ?? '';
        rows.push(one);
        rest = rest.slice(one.length);
        continue;
      }
      rows.push(cut);
      rest = rest.slice(cut.length);
      continue;
    }
    // Final row: if the remainder fits, print it; otherwise keep the END and mark the gap.
    if (visibleWidth(rest) <= width) {
      rows.push(rest);
      return { rows, hidden: 0 };
    }
    const budget = Math.max(1, width - 1); // room for the leading ellipsis
    // Take the tail from the RIGHT: a command's dangerous clause is appended, so the right edge
    // is the half worth showing.
    const kept = rightByWidth(rest, budget);
    rows.push('…' + kept);
    return { rows, hidden: rest.length - kept.length };
  }
  return { rows, hidden: 0 };
}

/** The rightmost `budget` columns of `s`. */
function rightByWidth(s: string, budget: number): string {
  let out = '';
  let w = 0;
  const chars = [...s];
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = visibleWidth(chars[i]!);
    if (w + cw > budget) break;
    out = chars[i]! + out;
    w += cw;
  }
  return out;
}

/** How long after the dialog appears keys still belong to the composer. */
export function dialogArmMs(): number {
  const n = Number(process.env.SHADOW_DIALOG_ARM_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 275;
}

export interface DialogHost {
  /** Resolve the pending request. */
  decide(decision: ApprovalDecision): void;
  /** Ask the app to move the cursor between questions. */
  onQuestionIndexChange(i: number): void;
  /** Ask the app to repaint. */
  repaint(): void;
  /** The session's CURRENT autonomy — the `(a)lways` grant is computed from it. */
  getAutonomy(): AutonomyLevel;
  /** Current multi-select/selection state per question index. */
  selections: QuestionSelection;
  /** Cursor row per question index. */
  cursors: Record<number, number>;
}

/**
 * The single dialog for every gate: a permission prompt, a plan-mode transition, or a question
 * from `ask_user_question`. One component because they share one key handler, and a key that
 * changes meaning between two code paths is how a dialog stops meaning what it shows.
 */
export class PendingDialog implements Component {
  /** When this dialog became visible — the arming window is measured from here. */
  readonly shownAt = Date.now();

  private questionIndex = 0;
  private done = false;

  constructor(
    private req: ApprovalRequest,
    private host: DialogHost,
    private getSize: () => { cols: number; rows: number },
  ) {}

  get request(): ApprovalRequest {
    return this.req;
  }
  get isDone(): boolean {
    return this.done;
  }
  get activeQuestionIndex(): number {
    return this.questionIndex;
  }
  get questions(): UserQuestion[] {
    return this.req.questions ?? [];
  }
  get activeQuestion(): UserQuestion | undefined {
    return this.questions[this.questionIndex];
  }

  invalidate(): void {}

  // ── input ──────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (this.done) return;
    if (this.req.kind === 'user_question' && this.questions.length) {
      this.handleQuestionKey(data);
      return;
    }
    this.handlePermissionKey(data);
  }

  private finish(decision: ApprovalDecision): void {
    if (this.done) return;
    this.done = true;
    this.host.decide(decision);
  }

  private handlePermissionKey(data: string): void {
    const k = data.toLowerCase();
    // Esc denies: the safe default when the user backs out.
    if (matchesKey(data, 'escape') || k === 'n') return this.finish('deny');
    if (k === 'y') return this.finish('approve');
    if (this.req.kind === 'permission') {
      if (k === 's') return this.finish({ approveForSession: true });
      if (k === 'f') {
        // Two tokens, matching the Ink path: `npm test --watch` grants `npm test`, not `npm`.
        const prefix = prefixGrant(this.req);
        if (prefix) return this.finish({ approveForPrefix: prefix });
        return;
      }
    }
    if (k === 'a' && this.req.kind !== 'plan_enter') {
      // raiseAutonomy, NOT cycleAutonomy. The cycle WRAPS full→manual, so pressing "(a)lways" on
      // the one dialog a full-autonomy session ever sees (a denylisted call) both ran the
      // catastrophic call AND flipped the session to ask-about-everything. raiseAutonomy clamps at
      // `full` and can never downgrade. Shift+Tab remains the cycling control.
      return this.finish({ setAutonomy: raiseAutonomy(this.host.getAutonomy()) });
    }
  }

  private handleQuestionKey(data: string): void {
    const q = this.activeQuestion;
    if (!q) return;
    const cur = this.host.cursors[this.questionIndex] ?? recommendedIndex(q);
    const multi = !!q.multiSelect;

    const move = (delta: number): void => {
      const n = Math.max(0, Math.min(q.options.length - 1, cur + delta));
      this.host.cursors[this.questionIndex] = n;
      if (!multi) {
        const opt = q.options[n];
        this.host.selections[this.questionIndex] = opt ? [opt.label] : [];
      }
      this.host.repaint();
    };

    // Arrow keys arrive as CSI sequences; accept both the raw and the normalised forms.
    if (matchesKey(data, 'up') || data === 'k') return move(-1);
    if (matchesKey(data, 'down') || data === 'j') return move(1);
    if (matchesKey(data, 'right') || matchesKey(data, 'left')) {
      const delta = matchesKey(data, 'right') ? 1 : -1;
      const next = this.questionIndex + delta;
      if (next >= 0 && next < this.questions.length) {
        this.questionIndex = next;
        this.host.onQuestionIndexChange(next);
        this.host.repaint();
      }
      return;
    }
    if (data === ' ') {
      if (!multi) return;
      const opt = q.options[cur];
      if (!opt) return;
      const sel = new Set(this.host.selections[this.questionIndex] ?? []);
      if (sel.has(opt.label)) sel.delete(opt.label);
      else sel.add(opt.label);
      this.host.selections[this.questionIndex] = [...sel];
      this.host.repaint();
      return;
    }
    if (matchesKey(data, 'enter')) {
      // Single-select: committing the cursor row. Multi-select: commit what is checked, and never
      // commit an empty list — an unchecked Enter used to answer a question with no answer.
      if (!multi) {
        const opt = q.options[cur];
        this.host.selections[this.questionIndex] = opt ? [opt.label] : [];
      } else if (!(this.host.selections[this.questionIndex] ?? []).length) {
        const opt = q.options[cur];
        if (opt) this.host.selections[this.questionIndex] = [opt.label];
      }
      if (this.questionIndex < this.questions.length - 1) {
        this.questionIndex++;
        this.host.onQuestionIndexChange(this.questionIndex);
        this.host.repaint();
        return;
      }
      this.finish({ answers: this.answers() });
      return;
    }
    if (data === '\x1b') {
      // Skip: answer the remaining questions with their defaults rather than hanging the turn.
      this.finish({ answers: this.answers() });
      return;
    }
    // A digit selects the nth option directly.
    if (/^[1-9]$/.test(data)) {
      const n = Number(data) - 1;
      if (n < q.options.length) {
        const opt = q.options[n]!;
        this.host.cursors[this.questionIndex] = n;
        this.host.selections[this.questionIndex] = [opt.label];
        this.host.repaint();
      }
    }
  }

  /** Selections, with any untouched question falling back to its default. */
  answers(): { question: string; selected: string[] }[] {
    return this.questions.map((q, i) => {
      const sel = this.host.selections[i];
      if (sel?.length) return { question: q.question, selected: sel };
      const rec = q.options[recommendedIndex(q)];
      return { question: q.question, selected: q.multiSelect ? [] : rec ? [rec.label] : [] };
    });
  }

  // ── render ─────────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const { rows: termRows } = this.getSize();
    const pageMargin = Math.min(SPACING.page, Math.max(0, Math.floor(width / 8)));
    const BAR = Math.min(barWidth(width, pageMargin), Math.max(20, width - pageMargin * 2));
    const pad = ' '.repeat(pageMargin);
    const bg = menuBg();
    const bgSel = menuSelBg();

    const out: string[] = [];
    out.push('');

    const isQ = this.req.kind === 'user_question';
    const title = isQ
      ? this.activeQuestion?.header
        ? `${GLYPHS.tool} ${approvalText(this.activeQuestion.header)}`
        : `${GLYPHS.tool} A quick decision`
      : this.req.kind === 'plan_enter'
        ? 'Enter plan mode?'
        : this.req.kind === 'plan_exit'
          ? 'Approve plan?'
          : 'Permission required';
    const titleColor = isQ ? C.cyan : C.yellow;
    out.push(pad + fill(`\x1b[1m\x1b[38;2;${hex(titleColor)}m${BORDER.topLeft}${BORDER.horizontal} ${title}`, BAR, bg));

    // body
    const label = isQ
      ? ` question${this.questions.length > 1 ? ` ${this.questionIndex + 1}/${this.questions.length}` : ''}: `
      : ' approve? ';
    const body = isQ ? (this.activeQuestion?.question ?? this.req.preview) : this.req.preview;
    // Generous now that the frame budget is the engine's problem rather than ours — but still
    // bounded, because a 200-row dialog is unusable even when it fits.
    const maxRows = Math.max(1, Math.min(6, termRows - 12));
    const labelW = visibleWidth(label);
    const { rows: preview, hidden } = previewRows(
      body,
      Math.max(8, BAR - labelW),
      Math.max(8, BAR - 2),
      maxRows,
    );
    out.push(
      pad +
        fill(
          `\x1b[1m\x1b[38;2;${hex(C.yellow)}m${label}\x1b[0m\x1b[48;2;${hex(bg)}m\x1b[38;2;${hex(C.fg)}m${preview[0] ?? ''}`,
          BAR,
          bg,
        ),
    );
    for (const line of preview.slice(1)) {
      out.push(pad + fill(`  ${line}`, BAR, bg));
    }
    if (hidden > 0) {
      out.push(
        pad +
          fill(`  ⚠ ${hidden} more characters not shown — deny and inspect if unsure`, BAR, bg).replace(
            `\x1b[48;2;${hex(bg)}m`,
            `\x1b[48;2;${hex(bg)}m\x1b[38;2;${hex(C.yellow)}m`,
          ),
      );
    }

    if (isQ && this.activeQuestion) {
      const q = this.activeQuestion;
      const cursor = this.host.cursors[this.questionIndex] ?? recommendedIndex(q);
      const rec = recommendedIndex(q);
      const sel = this.host.selections[this.questionIndex] ?? [];
      const OPTION_MAX = Math.max(1, Math.min(8, termRows - 10));
      const start = Math.min(Math.max(0, cursor - OPTION_MAX + 1), Math.max(0, q.options.length - OPTION_MAX));
      if (start > 0) out.push(pad + style.dim(`  ↑ ${start} more`));
      q.options.slice(start, start + OPTION_MAX).forEach((o, jj) => {
        const i = start + jj;
        const isCursor = i === cursor;
        const selected = sel.includes(o.label);
        const mark = q.multiSelect ? (selected ? '✓ ' : '  ') : '';
        const color = selected ? C.green : isCursor ? C.fg : C.dim;
        let line = `${isCursor ? `${GLYPHS.prompt}` : ' '} ${i + 1}. ${mark}${approvalText(o.label)}`;
        if (i === rec) line += `  ★ recommended`;
        if (o.description) line += `  — ${approvalText(o.description)}`;
        const styled = `\x1b[38;2;${hex(color)}m${isCursor ? '\x1b[1m' : ''}${line}`;
        out.push(pad + fill(styled, BAR, isCursor ? bgSel : bg));
      });
      if (start + OPTION_MAX < q.options.length) {
        out.push(pad + style.dim(`  ↓ ${q.options.length - start - OPTION_MAX} more`));
      }
    } else {
      out.push(pad + style.dim(`  [${approvalText(this.req.risk)}] ${approvalText(this.req.reason)}`));
    }

    out.push(pad + style.fg(C.border ?? C.dim, BORDER.bottomLeft + BORDER.horizontal + ' ') + this.legend());
    return fitLines(out, width);
  }

  private legend(): string {
    const isQ = this.req.kind === 'user_question';
    if (isQ) {
      const q = this.activeQuestion;
      const parts = [`${style.green('↑/↓')} move`];
      if (q?.multiSelect) parts.push(`${style.green('Space')} toggle`);
      parts.push(
        `${style.green('Enter')} ${
          this.questions.length > 1 && this.questionIndex < this.questions.length - 1 ? 'next' : 'confirm'
        }`,
      );
      if (this.questions.length > 1) parts.push(`${style.cyan('←/→')} question`);
      parts.push(`${style.red('Esc')} skip`);
      return '  ' + parts.join(' · ');
    }
    if (this.req.kind === 'plan_enter') return `  ${style.green('(y)')}es  ${style.red('(n)')}o`;
    if (this.req.kind === 'plan_exit') {
      return `  ${style.green('(y)')}es  ${style.red('(n)')}o  ${style.purple('(a)')}lways`;
    }
    return (
      '  ' +
      `${style.green('(y)')}es  ${style.red('(n)')}o  ${style.cyan('(s)')}ession  ` +
      `${style.cyan('(f)')}prefix  ${style.purple('(a)')}lways`
    );
  }
}

/** The `(f) prefix` grant: the first two tokens of the command (`npm test --watch` → `npm test`). */
function prefixGrant(req: ApprovalRequest): string | null {
  const input = req.call?.input as Record<string, unknown> | undefined;
  const cmd = typeof input?.command === 'string' ? input.command : null;
  if (!cmd) return null;
  const prefix = cmd.trim().split(/\s+/).slice(0, 2).join(' ');
  return prefix && prefix.length < 64 ? prefix : cmd.slice(0, 24) || null;
}
