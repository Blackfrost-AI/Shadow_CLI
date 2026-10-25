import { BORDER, GLYPHS } from '../tui/glyphs.js';
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
import {
  visibleWidth,
  truncateToWidth,
  isKeyRelease,
  matchesKey,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';

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

/**
 * The dialog's width: a centered panel that grows with the terminal up to a readable measure
 * (100 columns), keeps a 2-column gutter each side, and never goes below 24.
 */
export function barWidth(cols: number, pageMargin: number): number {
  return Math.max(24, Math.min(cols - Math.max(2, pageMargin) * 2, 100));
}

/** Word-wrap plain (already sanitized) text to `width` columns; long tokens are broken. */
function wrapPlain(text: string, width: number): string[] {
  const out = wrapTextWithAnsi(text, Math.max(1, width));
  return out.length ? out : [''];
}

/** Lay styled text out with a background fill across `width` columns, clipped on a grapheme. */
function fill(text: string, width: number, bg: string): string {
  const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, '…') : text;
  const pad = Math.max(0, width - visibleWidth(clipped));
  const background = `\x1b[48;2;${hex(bg)}m`;
  return (
    background + clipped.replaceAll('\x1b[0m', '\x1b[0m' + background) + ' '.repeat(pad) + '\x1b[0m'
  );
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
      // Measure the row ourselves. truncateToWidth() appends an SGR reset, so slicing `rest` by
      // ITS length silently skipped four real characters per wrapped row — the approval preview
      // showed a command that was not the one being approved.
      let cut = leftByWidth(rest, width);
      if (cut === '') {
        // A single grapheme wider than the row (a fullwidth glyph at width 1) — take it anyway
        // rather than looping forever.
        cut = splitGraphemes(rest)[0] ?? '';
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
    return { rows, hidden: splitGraphemes(rest).length - splitGraphemes(kept).length };
  }
  return { rows, hidden: 0 };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Split into user-perceived characters (a ZWJ emoji or a base + VS16 is ONE unit, not two). */
function splitGraphemes(s: string): string[] {
  return Array.from(graphemes.segment(s), (g) => g.segment);
}

/**
 * The leftmost `budget` columns of `s` — plain text in, plain text out (no escape suffix).
 * Measured per grapheme and re-checked as a whole: code-point iteration counted `❤` + VS16 as
 * one column while the terminal draws two, so a row overflowed and the frame's ellipsis hid
 * real command text without the "not shown" warning.
 */
function leftByWidth(s: string, budget: number): string {
  const parts: string[] = [];
  let w = 0;
  for (const g of splitGraphemes(s)) {
    const cw = visibleWidth(g);
    if (w + cw > budget) break;
    parts.push(g);
    w += cw;
  }
  while (parts.length && visibleWidth(parts.join('')) > budget) parts.pop();
  return parts.join('');
}

/** The rightmost `budget` columns of `s`, measured the same way. */
function rightByWidth(s: string, budget: number): string {
  const all = splitGraphemes(s);
  const parts: string[] = [];
  let w = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const cw = visibleWidth(all[i]!);
    if (w + cw > budget) break;
    parts.unshift(all[i]!);
    w += cw;
  }
  while (parts.length && visibleWidth(parts.join('')) > budget) parts.shift();
  return parts.join('');
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
  /** First visible row of the wrapped question when it is taller than its region. */
  private questionScroll = 0;
  /** Rows one PgUp/PgDn moves — set by the last render. */
  private questionPage = 3;
  /** Largest valid scroll offset — set by the last render, so key presses clamp immediately. */
  private questionMaxScroll = 0;
  /** True when the last render could not fit the whole question. */
  private questionScrollable = false;
  /**
   * True when the last render could not show what a commit key would act on (the command, or the
   * highlighted option). Commit keys are inert until the terminal is large enough; Esc still works.
   */
  private tooSmall = false;

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
    // F07-09: an acknowledge-only dialog (catastrophic denylist) offers no approve verbs — the
    // loop hard-blocks the call whatever is answered. Every key acknowledges, answered as 'deny'
    // so no grant (session, prefix, autonomy raise) can ever mint from it. Parity with Ink.
    if (this.req.acknowledgeOnly) return this.finish('deny');
    const k = data.toLowerCase();
    // Esc denies: the safe default when the user backs out.
    if (matchesKey(data, 'escape') || k === 'n') return this.finish('deny');
    // Every other key grants something. Refuse while the command is not on screen.
    if (this.cannotShowDecision()) return;
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

    if (matchesKey(data, 'pageDown') || matchesKey(data, 'pageUp')) {
      const dir = matchesKey(data, 'pageDown') ? 1 : -1;
      // Clamp here, not only at render: renders are batched, so several presses between two
      // paints would otherwise push past the end and make the next PgUp look dead.
      this.questionScroll = Math.max(
        0,
        Math.min(this.questionMaxScroll, this.questionScroll + dir * this.questionPage),
      );
      this.host.repaint();
      return;
    }
    // Arrow keys arrive as CSI sequences; accept both the raw and the normalised forms.
    if (matchesKey(data, 'up') || data === 'k') return move(-1);
    if (matchesKey(data, 'down') || data === 'j') return move(1);
    if (matchesKey(data, 'right') || matchesKey(data, 'left')) {
      const delta = matchesKey(data, 'right') ? 1 : -1;
      const next = this.questionIndex + delta;
      if (next >= 0 && next < this.questions.length) {
        this.questionIndex = next;
        this.questionScroll = 0;
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
      // Never commit an option the user cannot see.
      if (this.cannotShowDecision()) return;
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
        this.questionScroll = 0;
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

  /**
   * A centered, fully framed panel. The question is word-wrapped and shown IN FULL: when it is
   * taller than its region it scrolls (PgUp/PgDn) behind explicit "more lines" markers instead
   * of being cut at a fixed row count. Options always keep a visible region of their own and
   * wrap their descriptions under the label rather than truncating them on one row.
   *
   * Height is allocated up front, never trimmed afterwards. When space runs short the dialog
   * degrades in a fixed order — drop the spacer rows, then use a one-row legend — and if even the
   * minimum (the command tail with its "partial" marker, or the highlighted option) cannot fit,
   * it renders a "terminal too small" frame and the commit keys go inert. An approvable dialog
   * never shows a command, or a cursor, that is not on screen.
   */
  render(width: number): string[] {
    const { rows: termRows } = this.getSize();
    const maxRows = Math.max(1, termRows - 1); // one row of breathing room
    const BAR = Math.max(1, Math.min(barWidth(width, 0), width));
    const inner = BAR - 4; // "│ " + content + " │"
    const left = ' '.repeat(Math.max(0, Math.floor((width - BAR) / 2)));
    const bg = menuBg();
    const bgSel = menuSelBg();
    const border = C.border ?? C.dim;
    const isQ = this.req.kind === 'user_question' && !!this.activeQuestion;
    this.tooSmall = false;

    const row = (content: string, rowBg = bg): string =>
      left +
      fill(`\x1b[38;2;${hex(border)}m${BORDER.vertical}\x1b[0m `, 2, bg) +
      fill(content, inner, rowBg) +
      fill(` \x1b[38;2;${hex(border)}m${BORDER.vertical}`, 2, bg);

    const title = isQ
      ? this.activeQuestion?.header
        ? `${GLYPHS.tool} ${approvalText(this.activeQuestion.header)}`
        : `${GLYPHS.tool} A quick decision`
      : this.req.kind === 'plan_enter'
        ? 'Enter plan mode?'
        : this.req.kind === 'plan_exit'
          ? 'Approve plan?'
          : this.req.acknowledgeOnly
            ? 'Blocked command'
            : 'Permission required';
    const titleColor = isQ ? C.cyan : C.yellow;
    let counter =
      isQ && this.questions.length > 1
        ? ` question ${this.questionIndex + 1}/${this.questions.length} `
        : '';
    if (BAR - 4 - visibleWidth(counter) < 8) counter = '';
    const titleText = truncateToWidth(
      ` ${title} `,
      Math.max(1, BAR - 4 - visibleWidth(counter)),
      '…',
    );
    const dashes = Math.max(0, BAR - 3 - visibleWidth(titleText) - visibleWidth(counter));
    const top =
      left +
      fill(
        `\x1b[38;2;${hex(border)}m${BORDER.topLeft}${BORDER.horizontal}\x1b[0m` +
          `\x1b[1m\x1b[38;2;${hex(titleColor)}m${titleText}\x1b[0m` +
          `\x1b[38;2;${hex(border)}m${BORDER.horizontal.repeat(dashes)}\x1b[0m` +
          (counter ? style.dim(counter) : '') +
          `\x1b[38;2;${hex(border)}m${BORDER.topRight}\x1b[0m`,
        BAR,
        bg,
      );
    const bottom =
      left +
      fill(
        `\x1b[38;2;${hex(border)}m${BORDER.bottomLeft}${BORDER.horizontal.repeat(Math.max(0, BAR - 2))}${BORDER.bottomRight}\x1b[0m`,
        BAR,
        bg,
      );

    // Nothing can be shown faithfully: say so instead of offering a decision.
    const tooSmallFrame = (): string[] => {
      this.tooSmall = true;
      const esc = isQ ? 'Esc skips' : 'Esc denies';
      if (inner < 10 || maxRows < 3) {
        return fitLines([style.yellow(`⚠ terminal too small · ${esc}`)].slice(0, maxRows), width);
      }
      const msg = wrapPlain(
        '⚠ Terminal too small to show this safely. Enlarge it to decide, or ' + esc + '.',
        inner,
      );
      const body = msg.slice(0, Math.max(1, maxRows - 2)).map((l) => row(style.yellow(l)));
      return fitLines([top, ...body, bottom], width);
    };
    if (inner < 10) return tooSmallFrame();

    // Degradation ladder: each step frees rows for content, in order of what matters least.
    const ladder = [
      { spacer: true, compact: false },
      { spacer: false, compact: false },
      { spacer: false, compact: true },
    ];
    const legendFor = (scrollable: boolean, compact: boolean): string[] =>
      wrapTextWithAnsi(this.legend(scrollable, compact), inner);
    // Rows left for content once the frame, optional spacer and legend are placed.
    const availFor = (step: { spacer: boolean; compact: boolean }, scrollable: boolean): number =>
      maxRows - 2 - (step.spacer ? 1 : 0) - legendFor(scrollable, step.compact).length;
    // First step meeting `preferred`; otherwise the first meeting `minimum`; otherwise none.
    const choose = (
      need: (step: { spacer: boolean; compact: boolean }) => {
        min: number;
        pref: number;
        avail: number;
      },
    ) =>
      ladder.find((st) => {
        const n = need(st);
        return n.avail >= n.pref;
      }) ??
      ladder.find((st) => {
        const n = need(st);
        return n.avail >= n.min;
      });

    const out: string[] = [top];
    let legend: string[];
    let spacer: boolean;

    if (isQ) {
      const q = this.activeQuestion!;
      const fgq = `\x1b[38;2;${hex(C.fg)}m`;
      const qLines = wrapPlain(approvalText(q.question), inner).map((l) => fgq + l);

      // Options as blocks: label row(s) plus wrapped description rows.
      const cursor = this.host.cursors[this.questionIndex] ?? recommendedIndex(q);
      const rec = recommendedIndex(q);
      const sel = this.host.selections[this.questionIndex] ?? [];
      const build = (withDescriptions: (i: number) => boolean) =>
        q.options.map((o, i) => {
          const isCursor = i === cursor;
          const selected = sel.includes(o.label);
          const mark = q.multiSelect ? (selected ? '[✓] ' : '[ ] ') : '';
          const color = selected ? C.green : isCursor ? C.fg : C.dim;
          const head = `${isCursor ? GLYPHS.prompt : ' '} ${i + 1}. ${mark}`;
          const indent = ' '.repeat(visibleWidth(head));
          // A "(Recommended)" tag in the label becomes one badge — never shown twice.
          const isRec = i === rec && /\(recommended\)/i.test(o.label);
          const labelText = isRec
            ? approvalText(o.label)
                .replace(/\s*\(recommended\)\s*/i, ' ')
                .trim()
            : approvalText(o.label);
          const labelRows = wrapPlain(
            labelText + (isRec ? '  ★ recommended' : ''),
            Math.max(1, inner - indent.length),
          );
          const lines = labelRows.map(
            (l, k) =>
              `\x1b[38;2;${hex(color)}m${isCursor ? '\x1b[1m' : ''}${k === 0 ? head : indent}${l}`,
          );
          if (o.description && withDescriptions(i)) {
            for (const d of wrapPlain(
              approvalText(o.description),
              Math.max(1, inner - indent.length),
            )) {
              lines.push(`\x1b[38;2;${hex(isCursor ? C.fg : C.dim)}m${indent}${style.dim(d)}`);
            }
          }
          return { lines, labelRows: labelRows.length, bg: isCursor ? bgSel : bg };
        });
      const count = (bs: { lines: string[] }[]) => bs.reduce((n, b) => n + b.lines.length, 0);
      const full = build(() => true);
      const cursorLabelRows = full[cursor]?.labelRows ?? 1;

      // Minimum: one question row (+ marker when it scrolls) and the highlighted option's label.
      const qMin = qLines.length <= 1 ? qLines.length : 2;
      const optMin = Math.max(1, Math.min(cursorLabelRows, 2));
      let scrollable = false;
      const step = choose((st) => {
        const avail = availFor(st, true) - (st.spacer ? 1 : 0); // inner spacer between Q and options
        return {
          avail,
          min: qMin + optMin,
          pref: Math.min(qLines.length, 3) + Math.min(count(full), 3),
        };
      });
      if (!step) return tooSmallFrame();
      spacer = step.spacer;
      const bodyAvail = availFor(step, true) - (spacer ? 1 : 0);

      // Options first: they are what the user acts on. They get what they need up to ~60% of
      // the body; when everything does not fit, only the highlighted option keeps its
      // description (the others collapse to their label).
      const optCap = Math.max(optMin, Math.floor(bodyAvail * 0.6));
      const blocks = count(full) > optCap ? build((i) => i === cursor) : full;
      const optTotal = count(blocks);
      let qRegion = Math.min(qLines.length, Math.max(qMin, bodyAvail - Math.min(optTotal, optCap)));
      if (qRegion < qLines.length && qRegion < 2) qRegion = Math.min(2, bodyAvail - optMin);
      const optRegion = bodyAvail - qRegion;

      // Question region — scrollable, with explicit markers.
      scrollable = qLines.length > qRegion;
      this.questionScrollable = scrollable;
      if (!scrollable) {
        this.questionScroll = 0;
        this.questionMaxScroll = 0;
        for (const l of qLines) out.push(row(l));
      } else {
        const visible = Math.max(1, qRegion - 1); // one row reserved for the marker line
        const maxScroll = Math.max(0, qLines.length - visible);
        this.questionMaxScroll = maxScroll;
        this.questionScroll = Math.max(0, Math.min(this.questionScroll, maxScroll));
        this.questionPage = Math.max(1, visible - 1);
        const s = this.questionScroll;
        for (const l of qLines.slice(s, s + visible)) out.push(row(l));
        const above = s;
        const below = qLines.length - s - visible;
        // "more below" first: it is the part a reader most needs, so it must survive clipping.
        const long: string[] = [];
        if (below > 0) long.push(`↓ ${below} more line${below === 1 ? '' : 's'}`);
        if (above > 0) long.push(`↑ ${above} above`);
        let text = `  ${long.join(' · ')} — PgUp/PgDn`;
        if (visibleWidth(text) > inner) {
          text =
            [below > 0 ? `↓${below}` : '', above > 0 ? `↑${above}` : ''].filter(Boolean).join(' ') +
            ' PgDn/Up';
        }
        out.push(row(style.yellow(text)));
      }
      if (spacer) out.push(row(''));

      // Options region — windowed by whole blocks around the cursor, never taller than its
      // region. Overflow markers are dropped before the highlighted option is.
      let markers = true;
      const marker = (from: number, to: number) =>
        markers ? (from > 0 ? 1 : 0) + (to < blocks.length - 1 ? 1 : 0) : 0;
      const fits = (from: number, to: number): boolean => {
        let n = marker(from, to);
        for (let i = from; i <= to; i++) n += blocks[i]!.lines.length;
        return n <= optRegion;
      };
      let start = 0;
      if (optTotal > optRegion) {
        start = cursor;
        while (start > 0 && fits(start - 1, cursor)) start--;
      }
      let end = start;
      while (end + 1 < blocks.length && fits(start, end + 1)) end++;
      if (optRegion - marker(start, end) < 1) markers = false;
      const room = optRegion - marker(start, end);
      if (markers && start > 0)
        out.push(row(style.dim(`  ↑ ${start} more option${start === 1 ? '' : 's'}`)));
      let used = 0;
      // `blocks` may be empty (a question with no options): never index past it.
      for (let i = start; i <= end && i < blocks.length && used < room; i++) {
        const b = blocks[i]!;
        // Only a single block taller than the region is clipped (the cursor's own label stays).
        for (const l of b.lines.slice(0, room - used)) {
          out.push(row(l, b.bg));
          used++;
        }
      }
      if (markers && end < blocks.length - 1) {
        const n = blocks.length - 1 - end;
        out.push(row(style.dim(`  ↓ ${n} more option${n === 1 ? '' : 's'}`)));
      }
      legend = legendFor(scrollable, step.compact);
    } else {
      // Permission / plan: the preview keeps BOTH ends of a long command (head + tail) and says
      // how much was hidden — a hidden tail must never pass for the whole command. When any of
      // it is hidden the label itself reads "⚠ partial", so the warning survives even when the
      // separate warning line has no room.
      const labelW = Math.max(visibleWidth(' approve? '), visibleWidth(' ⚠ partial '));
      const ownLabelRow = inner - labelW < 8; // too narrow to share a row: label sits above
      const firstW = ownLabelRow ? inner - 2 : inner - labelW;
      const contW = inner - 2;
      const plan = (rowsForPreview: number) => {
        let pv = previewRows(
          this.req.preview,
          firstW,
          contW,
          Math.max(1, Math.min(10, rowsForPreview)),
        );
        const warn = pv.hidden > 0 && rowsForPreview >= 2;
        if (warn)
          pv = previewRows(
            this.req.preview,
            firstW,
            contW,
            Math.max(1, Math.min(10, rowsForPreview - 1)),
          );
        return { pv, warn };
      };
      const ideal = plan(10);
      // The risk/reason line is part of the minimum: it carries "⛔ BLOCKED" and "⚠ UNCONFINED".
      const idealRows = ideal.pv.rows.length + (ideal.warn ? 1 : 0) + (ownLabelRow ? 1 : 0) + 1;
      const minRows = 1 + (ownLabelRow ? 1 : 0) + 1;
      const step = choose((st) => ({
        avail: availFor(st, false),
        min: minRows,
        pref: Math.min(idealRows, 3 + (ownLabelRow ? 1 : 0)),
      }));
      if (!step) return tooSmallFrame();
      spacer = step.spacer;
      const avail = availFor(step, false);
      const { pv, warn } = plan(avail - (ownLabelRow ? 1 : 0) - 1);
      const label = pv.hidden > 0 ? ' ⚠ partial ' : ' approve? ';
      const labelStyled = `\x1b[1m\x1b[38;2;${hex(C.yellow)}m${label}\x1b[0m\x1b[48;2;${hex(bg)}m\x1b[38;2;${hex(C.fg)}m`;
      if (ownLabelRow) {
        out.push(row(labelStyled));
        for (const line of pv.rows) out.push(row(`  ${line}`));
      } else {
        out.push(row(labelStyled + (pv.rows[0] ?? '')));
        for (const line of pv.rows.slice(1)) out.push(row(`  ${line}`));
      }
      if (warn) {
        const msg =
          inner >= 56
            ? `  ⚠ ${pv.hidden} more characters not shown — deny and inspect if unsure`
            : inner >= 28
              ? `⚠ ${pv.hidden} chars not shown`
              : `⚠ ${pv.hidden} hidden`;
        out.push(row(style.yellow(msg)));
      }
      const reasonRoom = avail - (out.length - 1);
      const reason = wrapPlain(
        `[${approvalText(this.req.risk)}] ${approvalText(this.req.reason)}`,
        inner - 2,
      );
      const shown = reason.slice(0, Math.max(0, reasonRoom));
      if (shown.length && shown.length < reason.length) {
        shown[shown.length - 1] = truncateToWidth(shown[shown.length - 1] + ' …', inner - 2, '…');
      }
      for (const l of shown) out.push(row(style.dim(`  ${l}`)));
      legend = legendFor(false, step.compact);
    }

    if (spacer) out.push(row(''));
    for (const l of legend) out.push(row(l));
    out.push(bottom);
    // The allocation above is exact; this is a tripwire, not a trimmer. Trimming rows after the
    // fact is how a warning or the command itself used to disappear.
    if (out.length > maxRows) return tooSmallFrame();
    return fitLines(out, width);
  }

  /** Re-measure at the current size: commit keys act only on what is actually on screen. */
  private cannotShowDecision(): boolean {
    this.render(this.getSize().cols);
    return this.tooSmall;
  }

  private legend(scrollable: boolean, compact: boolean): string {
    const isQ = this.req.kind === 'user_question' && !!this.activeQuestion;
    if (isQ) {
      const q = this.activeQuestion;
      const multiQ = this.questions.length > 1;
      if (compact) {
        const parts = [style.green('↑↓'), style.green('⏎')];
        if (q?.multiSelect) parts.push(style.green('Spc'));
        if (multiQ) parts.push(style.cyan('←→'));
        if (scrollable) parts.push(style.yellow('PgUp/Dn'));
        parts.push(style.red('Esc'));
        return '  ' + parts.join(' ');
      }
      const parts = [`${style.green('↑/↓')} move`];
      if (q?.multiSelect) parts.push(`${style.green('Space')} toggle`);
      parts.push(
        `${style.green('Enter')} ${multiQ && this.questionIndex < this.questions.length - 1 ? 'next' : 'confirm'}`,
      );
      if (multiQ) parts.push(`${style.cyan('←/→')} question`);
      if (scrollable) parts.push(`${style.yellow('PgUp/PgDn')} read`);
      parts.push(`${style.red('Esc')} skip`);
      return '  ' + parts.join(' · ');
    }
    if (this.req.acknowledgeOnly) {
      // No approve verbs: the command is already hard-blocked. Never offer a choice that does not exist.
      return compact
        ? `  ${style.red('⛔')} any key`
        : `  ${style.red('⛔ blocked')} — ${style.green('any key')} acknowledges`;
    }
    if (this.req.kind === 'plan_enter') {
      return compact
        ? `  ${style.green('y')}/${style.red('n')}`
        : `  ${style.green('(y)')}es  ${style.red('(n)')}o`;
    }
    if (this.req.kind === 'plan_exit') {
      return compact
        ? `  ${style.green('y')}/${style.red('n')}/${style.purple('a')}`
        : `  ${style.green('(y)')}es  ${style.red('(n)')}o  ${style.purple('(a)')}lways`;
    }
    if (compact) {
      return `  ${style.green('y')}/${style.red('n')}/${style.cyan('s')}/${style.cyan('f')}/${style.purple('a')}`;
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
