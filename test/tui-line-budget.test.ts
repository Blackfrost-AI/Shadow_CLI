import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

/**
 * 2.4 — tui.tsx structural budget.
 *
 * The component file accreted to 4,974 lines (every overlay, renderer, and helper inline), which
 * made each TUI change slow and dangerous to review. The plan 2.4 slices were extracted to
 * `src/tui/*` and the file landed under 4,000 lines. This gate keeps it there: a PR that pushes
 * the file back over the budget fails CI instead of silently re-accreting.
 */
const root = new URL('../', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');
/** `wc -l` semantics: count newlines, so a trailing newline doesn't add a phantom line. */
const lineCount = (p: string): number => (read(p).match(/\n/g) ?? []).length;

const TUI_MAX_LINES = 4_000;

test('src/tui.tsx stays under its structural line budget', () => {
  const count = lineCount('src/tui.tsx');
  assert.ok(
    count <= TUI_MAX_LINES,
    `src/tui.tsx is ${count} lines; the budget is ${TUI_MAX_LINES}. ` +
      'Extract the next slice under src/tui/ instead of growing the component file (plan 2.4).',
  );
});

test('the plan-2.4 extracted slices exist as their own modules', () => {
  // The line budget is only honest if the slices it was cut into live OUTSIDE tui.tsx. If one of
  // these is missing, someone reverted an extraction to dodge the gate by inlining elsewhere.
  for (const p of [
    'src/tui/slashMenu.ts', // slash-command menu + argument pickers (sessions, turns, models)
    'src/tui/markdown.tsx', // transcript markdown renderer
    'src/tui/chrome.tsx', // status strip, chrome markers, composer paint, flat items
    'src/tui/headless.ts', // headless renderer for one-shot / piped runs
    'src/tui/gate.ts', // InteractiveGate (the loop's ApprovalGate in TUI mode)
    'src/tui/sanitize.ts', // assistant-text display sanitization
  ]) {
    assert.ok(existsSync(new URL(p, root)), `${p} missing — was an extraction reverted?`);
  }
});
