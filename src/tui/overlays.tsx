/**
 * Borderless overlay panels for the Shadow TUI (question / permission / plan / model picker).
 * Same visual family as the slash menu: shaded bars, no boxes. One border in the app is the composer.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { ApprovalRequest } from '../agent/approval.js';
import type { UserQuestion } from '../agent/approval.js';
import { recommendedIndex } from './questions.js';
import type { QuestionSelection } from './questions.js';
import type { PickerRow } from '../util/modelGroups.js';
import { displayWidth, takeByWidth, nextCluster } from './width.js';
import { diffLines, type DiffLine } from '../util/diff.js';
import { formatDiffStats, stripCtl } from './format.js';
import { isWriteTool } from './toolDisplay.js';

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

/**
 * Approval-time diff for the permission dialog (F10-04): a file-mutating call must show the
 * CHANGE it asks to make, not a one-line gist — the transcript renders `meta.diff` only AFTER
 * the tool ran, which is too late for the human deciding y/n. Same visual grammar as the
 * committed diff (+ green, − red, context dim, `+N −M` stat). Pure and injectable (`readFile`)
 * so tests drive it without Ink; any malformed/unreadable input returns null and the dialog
 * falls back to the existing one-line preview — never crash the gate.
 */
export interface ApprovalDiff {
  /** Operative fields only (`edit_file src/a.ts`) — the model-writable description is excluded. */
  header: string;
  /** `+N −M` over the WHOLE change, so the stat stays honest when the body is capped. */
  stats: string;
  /** At most the requested cap, sanitized to single-row text. */
  lines: DiffLine[];
  /** Diff lines elided beyond the cap. */
  hidden: number;
}

/** Bound on diff construction per pending call — the visible cap is far smaller; this only stops
 *  a pathological input from building thousands of line objects on a render pass. */
const APPROVAL_DIFF_WORK_CAP = 400;

/** Relative paths resolve against cwd (the TUI runs from the workspace root). A miss or a huge
 *  file only downgrades an overwrite preview to all-additions — same presentation the committed
 *  write_file result uses for a new/binary target — never an error in the dialog. */
function defaultRead(path: string): string | null {
  try {
    const abs = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
    if (statSync(abs).size > 2_000_000) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Single-row hygiene: Ink escapes markup, but stray ESC/\r/\t corrupt the bar-width math
 *  (stripCtl keeps \t and \r, so they are handled here). */
function cleanDiffText(s: string): string {
  return stripCtl(s).replace(/\r/g, '').replace(/\t/g, '  ');
}

function fileDiffOf(
  name: string,
  input: Record<string, unknown>,
  readFile: (path: string) => string | null,
): { header: string; lines: DiffLine[] } | null {
  const bound = { maxLines: APPROVAL_DIFF_WORK_CAP };
  if (name === 'edit_file') {
    const { path, old_string: oldS, new_string: newS } = input;
    if (typeof oldS !== 'string' || typeof newS !== 'string') return null;
    return { header: `edit_file ${typeof path === 'string' ? path : ''}`, lines: diffLines(oldS, newS, bound) };
  }
  if (name === 'multi_edit') {
    const { path, edits } = input;
    if (!Array.isArray(edits) || edits.length === 0) return null;
    const lines: DiffLine[] = [];
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] as Record<string, unknown> | null | undefined;
      const o = e?.old_string;
      const n = e?.new_string;
      if (typeof o !== 'string' || typeof n !== 'string') return null;
      if (edits.length > 1) lines.push({ tag: ' ', text: `— edit ${i + 1}/${edits.length} —` });
      lines.push(...diffLines(o, n, bound));
      if (lines.length >= APPROVAL_DIFF_WORK_CAP) break;
    }
    const suffix = edits.length > 1 ? ` (${edits.length} edits)` : '';
    return { header: `multi_edit ${typeof path === 'string' ? path : ''}${suffix}`, lines };
  }
  if (name === 'write_file') {
    const { path, content } = input;
    if (typeof path !== 'string' || typeof content !== 'string') return null;
    const old = readFile(path);
    if (old === null) {
      const ls = content.split('\n');
      if (ls.length > 1 && ls[ls.length - 1] === '') ls.pop(); // trailing \n is not a line
      return {
        header: `write_file ${path}`,
        lines: ls.slice(0, APPROVAL_DIFF_WORK_CAP).map((text) => ({ tag: '+' as const, text })),
      };
    }
    return { header: `write_file ${path}`, lines: diffLines(old, content, bound) };
  }
  // apply_patch — the input IS a diff already; recolor its lines with the envelope stripped.
  const patch = input.patch;
  if (typeof patch !== 'string' || !patch.trim()) return null;
  const lines: DiffLine[] = [];
  const files: string[] = [];
  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('*** Begin Patch') || raw.startsWith('*** End Patch')) continue;
    const fileHdr = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(raw);
    if (fileHdr) files.push(fileHdr[1]!.trim());
    if (raw.startsWith('+')) lines.push({ tag: '+', text: raw.slice(1) });
    else if (raw.startsWith('-')) lines.push({ tag: '-', text: raw.slice(1) });
    else if (raw.startsWith(' ')) lines.push({ tag: ' ', text: raw.slice(1) });
    else lines.push({ tag: ' ', text: raw }); // `*** File:` headers / @@ hunks / lenient blanks
    if (lines.length >= APPROVAL_DIFF_WORK_CAP) break;
  }
  while (lines.length && lines[lines.length - 1]!.tag === ' ' && lines[lines.length - 1]!.text === '') lines.pop();
  if (lines.length === 0) return null;
  const header = files.length === 1 ? `apply_patch ${files[0]!}` : `apply_patch (${files.length} files)`;
  return { header, lines };
}

/** Build the bounded approval-time diff for a pending file-mutating call; null → caller keeps
 *  the one-line preview (non-file tool, malformed input, no net change, or tiny cap). */
export function buildApprovalDiff(
  call: { name: string; input: unknown },
  maxLines: number,
  readFile: (path: string) => string | null = defaultRead,
): ApprovalDiff | null {
  if (maxLines < 1 || !isWriteTool(call.name)) return null;
  if (!call.input || typeof call.input !== 'object') return null;
  try {
    const built = fileDiffOf(call.name, call.input as Record<string, unknown>, readFile);
    if (!built || built.lines.length === 0) return null;
    // A change with zero +/- lines is a no-op preview (identical strings) — except apply_patch,
    // where an all-context body can still carry `*** Delete File:` headers that ARE the change.
    if (call.name !== 'apply_patch' && !built.lines.some((l) => l.tag !== ' ')) return null;
    const stats = formatDiffStats(built.lines.map((l) => ({ text: `${l.tag} ${l.text}` })));
    const shown = built.lines.slice(0, maxLines).map((l) => ({ tag: l.tag, text: cleanDiffText(l.text) }));
    return {
      header: stripCtl(built.header).replace(/\s+/g, ' ').trim(), // a hostile path must not add rows
      stats,
      lines: shown,
      hidden: built.lines.length - shown.length,
    };
  } catch {
    return null;
  }
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
  // F10-04: a file-mutating call shows the pending CHANGE, not a one-line gist. Bounded the same
  // way the option list is (rows-scaled, hard cap 20) because the dialog shares the frame budget
  // with the transcript; below a 3-line budget the diff adds nothing over the preview. Memoized
  // per request — the write_file path reads the target file once, not on every repaint.
  const DIFF_MAX = Math.max(0, Math.min(20, rows - 18));
  const diff = React.useMemo(
    () => (pending.kind === 'permission' && DIFF_MAX >= 3 ? buildApprovalDiff(pending.call, DIFF_MAX) : null),
    [pending, DIFF_MAX],
  );
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
        // With a diff below, the action row collapses to the operative header (tool + path) —
        // the payload lives in the diff, and the saved rows keep the dialog inside the budget.
        const body =
          pending.kind === 'user_question'
            ? (activeQuestion?.question ?? pending.preview)
            : (diff?.header ?? pending.preview);
        // Scaled to terminal height the same way the option list is, so a short terminal never
        // grows the dialog into the frame-budget wipe.
        const maxRows = diff ? 1 : Math.max(1, Math.min(3, rows - 16));
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
            {diff ? (
              <>
                {diff.stats ? (
                  <Text wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG} color={C.dim}>
                    {bar(`  ${diff.stats}`)}
                  </Text>
                ) : null}
                {diff.lines.map((l, i) => (
                  <Text
                    key={`df${i}`}
                    wrap="truncate"
                    backgroundColor={C.menuBg ?? MENU_BG}
                    color={l.tag === '+' ? C.green : l.tag === '-' ? C.red : C.dim}
                  >
                    {bar(` ${l.tag} ${l.text}`)}
                  </Text>
                ))}
                {diff.hidden > 0 ? (
                  <Text wrap="truncate" backgroundColor={C.menuBg ?? MENU_BG} color={C.yellow}>
                    {bar(`  ⚠ +${diff.hidden} more diff lines not shown — deny and inspect if unsure`)}
                  </Text>
                ) : null}
              </>
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
