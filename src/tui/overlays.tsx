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

/** Faint slate panel behind menus/overlays. */
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
}

function barWidth(cols: number, pageMargin: number): number {
  return Math.max(24, Math.min(cols - pageMargin * 2 - 1, 74));
}

function padBar(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
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
          : 'Permission required';

  return (
    <Box flexDirection="column" paddingLeft={pageMargin} marginTop={1}>
      <Text wrap="truncate" backgroundColor={MENU_BG} color={titleColor} bold>
        {bar(` ${title}`)}
      </Text>
      <Text wrap="truncate" backgroundColor={MENU_BG}>
        <Text color={C.yellow} bold>
          {pending.kind === 'user_question'
            ? ` question${pendingQuestionsLength > 1 ? ` ${activeQuestionIndex + 1}/${pendingQuestionsLength}` : ''}: `
            : ' approve? '}
        </Text>
        <Text color={C.fg}>
          {pending.kind === 'user_question'
            ? (activeQuestion?.question ?? pending.preview)
            : pending.preview}
        </Text>
      </Text>
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
                return (
                  <Text key={o.label} wrap="truncate" color={selected ? C.green : isCursor ? C.fg : C.dim} bold={isCursor}>
                    {`${isCursor ? '❯' : ' '} ${i + 1}. ${mark}${o.label}`}
                    {isRec ? <Text color={C.yellow}>{'  ★ recommended'}</Text> : ''}
                    {o.description ? <Text color={C.dim}>{`  — ${o.description}`}</Text> : ''}
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
        <Text wrap="truncate" color={C.dim}>{`  [${pending.risk}] ${pending.reason}`}</Text>
      )}
      {pending.kind === 'user_question' && autoAnswerSecs != null ? (
        <Text wrap="truncate" color={C.yellow}>
          {`  ⏳ auto-picking the recommended answer in ${autoAnswerSecs}s · any key to take over`}
        </Text>
      ) : null}
      <Text>
        {pending.kind === 'user_question' ? (
          <>
            <Text color={C.green}>↑/↓</Text> move{' '}
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
            <Text color={C.green}>(y)</Text>es{'  '}
            <Text color={C.red}>(n)</Text>o
          </>
        ) : pending.kind === 'plan_exit' ? (
          <>
            <Text color={C.green}>(y)</Text>es{'  '}
            <Text color={C.red}>(n)</Text>o{'  '}
            <Text color={C.purple}>(a)</Text>lways
          </>
        ) : (
          <>
            <Text color={C.green}>(y)</Text>es{'  '}
            <Text color={C.red}>(n)</Text>o{'  '}
            <Text color={C.cyan}>(s)</Text>ession{'  '}
            <Text color={C.cyan}>(f)</Text>prefix{'  '}
            <Text color={C.purple}>(a)</Text>lways
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
      <Text wrap="truncate" backgroundColor={MENU_BG} color={C.cyan} bold>
        {bar(' Select a model')}
      </Text>
      {pickStart > 0 ? (
        <Text wrap="truncate" backgroundColor={MENU_BG} italic color={C.dim}>{bar(`  ↑ ${pickStart} more`)}</Text>
      ) : null}
      {pickerRows.slice(pickStart, pickStart + pickerMax).map((r, j) => {
        const i = pickStart + j;
        if (r.kind === 'header') {
          return (
            <Text key={`h${i}`} wrap="truncate" backgroundColor={MENU_BG} bold color={C.yellow}>
              {bar(` ${r.label}`)}
            </Text>
          );
        }
        const e = r.entry;
        const active = e.provider === currentProvider && e.model === currentModel;
        const cur = i === pickerSel;
        const bg = cur ? MENU_SEL_BG : MENU_BG;
        // Clip AND pad to the bar width (padBar used to do both): a long provider/model must not
        // spill past the shaded rectangle.
        const bodyMax = Math.max(0, BAR_W - 4); // 2 cursor + 2 marker cells
        const raw = `${e.label.padEnd(14)} ${e.provider}/${e.model}`;
        const body = raw.length > bodyMax ? raw.slice(0, bodyMax) : raw;
        const pad = body.length < bodyMax ? ' '.repeat(bodyMax - body.length) : '';
        return (
          // The ● marker on the ACTIVE model stays green regardless of the cursor row — it is the
          // "this one is in use" signal, not a selection highlight.
          <Text key={`m${i}`} wrap="truncate" bold={cur}>
            <Text backgroundColor={bg} color={cur ? C.green : C.dim}>{cur ? '❯ ' : '  '}</Text>
            <Text backgroundColor={bg} color={C.green}>{active ? '● ' : '  '}</Text>
            <Text backgroundColor={bg} color={cur ? C.fg : C.dim}>{body}</Text>
            {pad ? <Text backgroundColor={bg}>{pad}</Text> : null}
          </Text>
        );
      })}
      {pickStart + pickerMax < pickerRows.length ? (
        <Text wrap="truncate" backgroundColor={MENU_BG} italic color={C.dim}>
          {bar(`  ↓ ${pickerRows.length - pickStart - pickerMax} more`)}
        </Text>
      ) : null}
      <Text wrap="truncate" backgroundColor={MENU_BG} color={C.dim}>
        {bar(' ↑/↓ select · Enter switch · Esc cancel')}
      </Text>
    </Box>
  );
}

// Re-export so callers that only need the selection type keep a single import surface.
export type { QuestionSelection };
