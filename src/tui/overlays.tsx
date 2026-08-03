/**
 * Borderless overlay panels for the Shadow TUI (question / permission / plan / model picker).
 * Same visual family as the slash menu: shaded bars, no boxes. One border in the app is the composer.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { ApprovalRequest } from '../agent/approval.js';
import type { UserQuestion } from '../agent/approval.js';
import { recommendedIndex } from './questions.js';
import type { QuestionSelection } from './questions.js';
import type { PickerRow } from '../util/modelGroups.js';
import { displayWidth, takeByWidth, nextCluster } from './width.js';

/** Faint slate panel behind menus/overlays — the OG default. Themes override via `menuBg`;
 *  these remain as the fallback for any palette that predates the field. */
export const MENU_BG = '#1b2331';
/** Stronger tone on the selected overlay/menu row. */
export const MENU_SEL_BG = '#31465f';

export interface OverlayPalette {
  fg: string;
  dim: string;
  green: string;
  cyan: string;
  yellow: string;
  red: string;
  purple: string;
  /** Panel tones from the active theme; absent on older palettes → the module defaults below. */
  menuBg?: string;
  menuSelBg?: string;
}

function barWidth(cols: number, pageMargin: number): number {
  // Never demand a 24-column panel from a 20-column split pane. The labels truncate honestly;
  // overflowing past the terminal edge is worse than showing a compact surface.
  return Math.max(8, Math.min(cols - pageMargin * 2 - 1, 74));
}

function padBar(s: string, width: number): string {
  // Measured in COLUMNS: `.length` padded a CJK label to half its visual width, so the shaded bar
  // ended mid-row and the clip cut a fullwidth glyph in half.
  const w = displayWidth(s);
  if (w >= width) return takeByWidth(s, width).head;
  return s + ' '.repeat(width - w);
}

/**
 * Lay the approval preview across up to `maxRows` rows, keeping BOTH ends visible.
 *
 * One `wrap="truncate"` row let a command hide its own tail: `git status` + padding +
 * `; rm -rf ~/Documents` rendered as "$ git status" with the destructive half past the right edge.
 * `previewOf` now collapses whitespace runs, but a genuinely long command still has to be shown
 * honestly — so when it will not fit we print the head, then the TAIL (where an appended clause
 * lives), and state how much is hidden. Bounded rows because the dialog shares the frame budget
 * with the transcript; an unbounded preview would trip Ink's scrollback-wiping clearTerminal.
 */
function previewRows(
  text: string,
  firstWidth: number,
  contWidth: number,
  maxRows: number,
): { rows: string[]; hidden: number } {
  const rows: string[] = [];
  let rest = text;
  for (let r = 0; r < maxRows && rest !== ''; r++) {
    const width = Math.max(1, r === 0 ? firstWidth : contWidth);
    if (r < maxRows - 1) {
      const { head, rest: tail } = takeByWidth(rest, width);
      const chunk = head === '' ? (nextCluster(rest, 0) || rest.slice(0, 1)) : head;
      rows.push(chunk);
      rest = head === '' ? rest.slice(chunk.length) : tail;
      continue;
    }
    // Final row: if the remainder fits, print it; otherwise keep the END and mark the gap.
    if (displayWidth(rest) <= width) {
      rows.push(rest);
      return { rows, hidden: 0 };
    }
    const budget = Math.max(1, width - 1); // room for the leading ellipsis
    let tail = rest;
    while (tail !== '' && displayWidth(tail) > budget) {
      tail = tail.slice((nextCluster(tail, 0) || tail.slice(0, 1)).length);
    }
    rows.push(`…${tail}`);
    return { rows, hidden: rest.length - tail.length };
  }
  return { rows, hidden: 0 };
}

export function PendingOverlay({
  pending,
  cols,
  rows,
  pageMargin,
  colors: C,
  activeQuestion,
  activeQuestionIndex,
  pendingQuestionsLength,
  activeQuestionSelection,
  questionCursor,
  autoAnswerSecs,
}: {
  pending: ApprovalRequest;
  cols: number;
  rows: number;
  pageMargin: number;
  colors: OverlayPalette;
  activeQuestion: UserQuestion | undefined;
  activeQuestionIndex: number;
  pendingQuestionsLength: number;
  activeQuestionSelection: string[];
  questionCursor: Record<number, number>;
  autoAnswerSecs: number | null;
}): React.ReactElement {
  const BAR_W = barWidth(cols, pageMargin);
  const bar = (s: string) => padBar(s, BAR_W);
  const titleColor = pending.kind === 'user_question' ? C.cyan : C.yellow;
  const title =
    pending.kind === 'user_question'
      ? (activeQuestion?.header ? `◆ ${activeQuestion.header}` : '◆ A quick decision')
      : pending.kind === 'plan_enter'
        ? 'Enter plan mode?'
        : pending.kind === 'plan_exit'
          ? 'Approve plan?'
          : `Permission required · ${pending.risk}`;

  return (
    <Box flexDirection="column" paddingLeft={pageMargin} marginTop={1}>
      <Text wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG} color={titleColor} bold>
        {bar(` ${title}`)}
      </Text>
      {(() => {
        const label =
          pending.kind === 'user_question'
            ? ` question${pendingQuestionsLength > 1 ? ` ${activeQuestionIndex + 1}/${pendingQuestionsLength}` : ''}: `
            : pending.kind === 'permission'
              ? ' action: '
              : ' proposal: ';
        const body =
          pending.kind === 'user_question'
            ? (activeQuestion?.question ?? pending.preview)
            : pending.preview;
        // Scaled to terminal height the same way the option list is, so a short terminal never
        // grows the dialog into the frame-budget wipe.
        const maxRows = Math.max(1, Math.min(3, rows - 16));
        const labelW = displayWidth(label);
        const { rows: preview, hidden } = previewRows(
          body,
          Math.max(8, BAR_W - labelW),
          Math.max(8, BAR_W - 2),
          maxRows,
        );
        return (
          <>
            <Text wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG}>
              <Text color={C.yellow} bold>
                {label}
              </Text>
              <Text color={C.fg}>{padBar(preview[0] ?? '', BAR_W - labelW)}</Text>
            </Text>
            {preview.slice(1).map((line, i) => (
              <Text key={`pv${i}`} wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG} color={C.fg}>
                {padBar(`  ${line}`, BAR_W)}
              </Text>
            ))}
            {hidden > 0 ? (
              <Text wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG} color={C.yellow}>
                {padBar(`  ⚠ ${hidden} more characters not shown — deny and inspect if unsure`, BAR_W)}
              </Text>
            ) : null}
          </>
        );
      })()}
      {pending.kind === 'user_question' && activeQuestion ? (
        // Window the option list around the cursor; force each row to ONE truncated line so a long
        // dialog can't trip Ink's clearTerminal fallback on a short terminal.
        (() => {
          const OPTION_MAX = Math.max(1, Math.min(8, rows - 14));
          const opts_ = activeQuestion.options;
          const cursor = questionCursor[activeQuestionIndex] ?? recommendedIndex(activeQuestion);
          const rec = recommendedIndex(activeQuestion);
          const start = Math.min(Math.max(0, cursor - OPTION_MAX + 1), Math.max(0, opts_.length - OPTION_MAX));
          return (
            <>
              {start > 0 ? <Text italic color={C.dim}>{`  ↑ ${start} more`}</Text> : null}
              {opts_.slice(start, start + OPTION_MAX).map((o, jj) => {
                const i = start + jj;
                const selected = activeQuestionSelection.includes(o.label);
                const isCursor = i === cursor;
                const isRec = i === rec;
                const mark = activeQuestion.multiSelect ? (selected ? '✓ ' : '  ') : '';
                const row = `${isCursor ? '❯' : ' '} ${i + 1}. ${mark}${o.label}${isRec ? '  ★ recommended' : ''}${o.description ? `  — ${o.description}` : ''}`;
                return (
                  // Keyed by INDEX, not label: a question with two identically-labelled options
                  // (models routinely emit "Yes"/"Yes") produced duplicate React keys, and the two
                  // rows then shared selection state — clicking one highlighted the other.
                  <Text
                    key={`opt${i}`}
                    wrap="truncate"
                    backgroundColor={isCursor ? (C.menuSelBg ?? MENU_SEL_BG) : (C.menuBg ?? MENU_BG)}
                    color={isCursor ? C.fg : selected ? C.green : isRec ? C.yellow : C.dim}
                    bold={isCursor}
                  >
                    {bar(row)}
                  </Text>
                );
              })}
              {start + OPTION_MAX < opts_.length ? (
                <Text italic color={C.dim}>{`  ↓ ${opts_.length - start - OPTION_MAX} more`}</Text>
              ) : null}
            </>
          );
        })()
      ) : (
        <Text wrap="truncate" color={C.dim}>{`  Why: ${pending.reason}`}</Text>
      )}
      {pending.kind === 'user_question' && autoAnswerSecs != null ? (
        <Text wrap="truncate" color={C.yellow}>
          {`  ⏳ auto-picking the recommended answer in ${autoAnswerSecs}s · any key to take over`}
        </Text>
      ) : null}
      {/* The ONE unbudgeted line in the dialog: without wrap="truncate" this legend wrapped to a
          second row on a narrow terminal, which is exactly the unaccounted-for row that pushes the
          frame to terminal height and trips Ink's scrollback-wiping clearTerminal. */}
      <Text wrap="truncate">
        {pending.kind === 'user_question' ? (
          <>
            <Text color={C.green}>↑/↓</Text> move{' '}
            · <Text color={C.cyan}>1–9</Text> jump{' '}
            {activeQuestion?.multiSelect ? (
              <>
                · <Text color={C.green}>Space</Text> toggle{' '}
              </>
            ) : null}
            · <Text color={C.green}>Enter</Text>{' '}
            {pendingQuestionsLength > 1 && activeQuestionIndex < pendingQuestionsLength - 1
              ? 'next'
              : 'confirm'}{' '}
            {pendingQuestionsLength > 1 ? (
              <>
                · <Text color={C.cyan}>←/→</Text> question{' '}
              </>
            ) : null}
            · <Text color={C.red}>Esc</Text> skip
          </>
        ) : pending.kind === 'plan_enter' ? (
          <>
            <Text color={C.green}>y</Text> enter plan mode{'  ·  '}
            <Text color={C.red}>n</Text> keep implementing
          </>
        ) : pending.kind === 'plan_exit' ? (
          <>
            <Text color={C.green}>y</Text> approve{'  ·  '}
            <Text color={C.red}>n</Text> keep planning{'  ·  '}
            <Text color={C.purple}>a</Text> approve + raise mode
          </>
        ) : (
          <>
            <Text color={C.green}>y</Text> once{'  ·  '}
            <Text color={C.red}>n</Text> deny{'  ·  '}
            <Text color={C.cyan}>s</Text> tool/session{'  ·  '}
            {pending.call.name === 'run_shell' ? (
              <><Text color={C.cyan}>f</Text> shell prefix{'  ·  '}</>
            ) : null}
            <Text color={C.purple}>a</Text> raise mode + approve
          </>
        )}
      </Text>
    </Box>
  );
}

export function ModelPickerOverlay({
  cols,
  pageMargin,
  colors: C,
  pickerRows,
  pickStart,
  pickerMax,
  pickerSel,
  currentProvider,
  currentModel,
}: {
  cols: number;
  pageMargin: number;
  colors: OverlayPalette;
  pickerRows: PickerRow[];
  pickStart: number;
  pickerMax: number;
  pickerSel: number;
  currentProvider: string;
  currentModel: string;
}): React.ReactElement {
  const BAR_W = barWidth(cols, pageMargin);
  const bar = (s: string) => padBar(s, BAR_W);
  return (
    <Box flexDirection="column" paddingLeft={pageMargin} marginTop={1}>
      <Text wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG} color={C.cyan} bold>
        {bar(' Select a model')}
      </Text>
      {pickStart > 0 ? (
        <Text wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG} italic color={C.dim}>{bar(`  ↑ ${pickStart} more`)}</Text>
      ) : null}
      {pickerRows.slice(pickStart, pickStart + pickerMax).map((r, j) => {
        const i = pickStart + j;
        if (r.kind === 'header') {
          return (
            <Text key={`h${i}`} wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG} bold color={C.yellow}>
              {bar(` ${r.label}`)}
            </Text>
          );
        }
        const e = r.entry;
        const active = e.provider === currentProvider && e.model === currentModel;
        const cur = i === pickerSel;
        const bg = cur ? (C.menuSelBg ?? MENU_SEL_BG) : (C.menuBg ?? MENU_BG);
        // Clip AND pad to the bar width (padBar used to do both): a long provider/model must not
        // spill past the shaded rectangle.
        const bodyMax = Math.max(0, BAR_W - 4); // 2 cursor + 2 marker cells
        const label = padBar(e.label, 14);
        const body = padBar(`${label} ${e.provider}/${e.model}`, bodyMax);
        return (
          // The ● marker on the ACTIVE model stays green regardless of the cursor row — it is the
          // "this one is in use" signal, not a selection highlight.
          <Text key={`m${i}`} wrap="truncate" bold={cur}>
            <Text backgroundColor={bg} color={cur ? C.green : C.dim}>{cur ? '❯ ' : '  '}</Text>
            <Text backgroundColor={bg} color={C.green}>{active ? '● ' : '  '}</Text>
            <Text backgroundColor={bg} color={cur ? C.fg : C.dim}>{body}</Text>
          </Text>
        );
      })}
      {pickStart + pickerMax < pickerRows.length ? (
        <Text wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG} italic color={C.dim}>
          {bar(`  ↓ ${pickerRows.length - pickStart - pickerMax} more`)}
        </Text>
      ) : null}
      <Text wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG} color={C.dim}>
        {bar(' ● active · ↑/↓ select · Enter switch · Esc cancel')}
      </Text>
    </Box>
  );
}

// Re-export so callers that only need the selection type keep a single import surface.
export type { QuestionSelection };
