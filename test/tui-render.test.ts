import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { PlanModeState } from '../src/agent/planMode.js';

/**
 * The OLD tui-composer tests pinned the hand-rolled ANSI redraw math, which no
 * longer exists — Ink owns wrapping now. The real gap they left was that NOTHING
 * mounted the Ink component, so a renderer that crashes at first render ("Box is
 * not defined") still shipped with a green suite. This test closes that gap: it
 * actually mounts <TuiApp> and asserts it renders. The component touches
 * provider/registry/context only inside runOne (on Enter), so a minimal opts with
 * a real EventBus is enough to render the banner + composer.
 */
function makeOpts(over: Partial<TuiOpts> = {}): TuiOpts {
  return {
    provider: {} as TuiOpts['provider'],
    registry: {} as TuiOpts['registry'],
    bus: new EventBus(),
    context: {} as TuiOpts['context'],
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: '',
    workspaceRoot: '/tmp/ws',
    cfg: { provider: 'mock', model: 'claude-opus-4-8' } as unknown as TuiOpts['cfg'],
    autonomy: 'auto-edit',
    bypass: false,
    version: '9.9.9',
    ...over,
  };
}

test('TuiApp renders without throwing (regression guard for the Box/Text import crash)', () => {
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  const frame = lastFrame() ?? '';
  // Footer status line is always in the live frame when idle.
  assert.match(frame, /mock\/claude-opus-4-8/, 'shows provider/model');
  assert.match(frame, /mode: auto-edit/, 'shows the autonomy level');
  assert.match(frame, /❯/, 'renders the composer prompt');
  unmount();
});

test('TuiApp reflects yolo + autonomy in the footer', () => {
  const { lastFrame, unmount } = render(
    React.createElement(TuiApp, { opts: makeOpts({ bypass: true, autonomy: 'full' }) }),
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /mode: full/);
  assert.match(frame, /\(yolo\)/);
  assert.match(frame, /sandbox:off/);
  // '(yolo)' must appear exactly once — the core marker already signals bypass,
  // so the sandbox field must not repeat it.
  assert.equal((frame.match(/\(yolo\)/g) ?? []).length, 1, "'(yolo)' should render once");
  unmount();
});

test('usage events update the status line', async () => {
  const bus = new EventBus();
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ bus }) }));
  await new Promise((r) => setTimeout(r, 20)); // let the mount effect subscribe to the bus
  bus.emit({
    type: 'usage',
    inputTokens: 1200,
    outputTokens: 800,
    costUSD: 0.0123,
    contextPct: 0.42,
  });
  await new Promise((r) => setTimeout(r, 20));
  const frame = lastFrame() ?? '';
  assert.match(frame, /2\.0k tokens/, 'totals input+output and humanizes the count');
  assert.match(frame, /ctx 42%/);
  unmount();
});

test('TuiApp surfaces plan mode and todo state in panels', async () => {
  const bus = new EventBus();
  const planMode = new PlanModeState(true);
  planMode.recordPlan('TUI Redesign', '/tmp/shadow/plans/tui-redesign.md');
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ bus, planMode }) }));
  await new Promise((r) => setTimeout(r, 20));
  bus.emit({
    type: 'todo',
    items: [
      { id: 'todo-1', subject: 'Refactor transcript', status: 'completed' },
      { id: 'todo-2', subject: 'Wire composer queue', status: 'in_progress' },
    ],
  });
  await new Promise((r) => setTimeout(r, 20));
  const frame = lastFrame() ?? '';
  assert.match(frame, /Plan mode/);
  assert.match(frame, /TUI Redesign/);
  assert.match(frame, /Task list 1\/2/);
  assert.match(frame, /Refactor transcript/);
  assert.match(frame, /Wire composer queue/);
  unmount();
});

test('TuiApp renders tool denials as blocked status, not errors', async () => {
  const bus = new EventBus();
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ bus }) }));
  await new Promise((r) => setTimeout(r, 20));
  bus.emit({
    type: 'tool_denied',
    call: { id: 'm', name: 'memory', input: { action: 'remember' } },
    reason: 'plan mode blocks write tool memory; call plan_write, then exit_plan_mode for approval before implementing',
  });
  await new Promise((r) => setTimeout(r, 20));
  const frame = lastFrame() ?? '';
  assert.match(frame, /blocked/);
  assert.match(frame, /Plan mode is active/);
  assert.doesNotMatch(frame, /\berror\b/);
  assert.doesNotMatch(frame, /\bdenied\b/);
  unmount();
});

// TUI polish test: auto-collapse of reasoning when done (tool_start after reasoning_done)
test('TuiApp auto-collapses reasoning on tool_start (polish: collapse when done)', async () => {
  const bus = new EventBus();
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ bus }) }));
  await new Promise((r) => setTimeout(r, 20));

  bus.emit({ type: 'reasoning_done', text: 'This is long thinking that should collapse' });
  await new Promise((r) => setTimeout(r, 20));

  // After reasoning, before action it may be visible or collapsed by default
  let frame = lastFrame() ?? '';
  // Now trigger action
  bus.emit({ type: 'tool_start', call: { id: 't1', name: 'read_file', input: { path: 'x' } } });
  await new Promise((r) => setTimeout(r, 20));

  frame = lastFrame() ?? '';
  // Should show the collapsed v2 form (∴ Thinking · ⌄ N lines · ^O), not the full thinking text.
  assert.match(frame, /∴ Thinking/);
  assert.doesNotMatch(frame, /This is long thinking that should collapse/);
  unmount();
});

// Claude Code parity: thinking is NEVER streamed raw into the view — a compact indicator live,
// then a COLLAPSED row in the transcript (no separate raw-thought preview = no "split").
test('thinking shows a compact ✻ Thinking… indicator live, never the raw thought', async () => {
  const bus = new EventBus();
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ bus }) }));
  await new Promise((r) => setTimeout(r, 20));

  bus.emit({ type: 'thinking', delta: 'SECRET_RAW_THOUGHT one\nSECRET_RAW_THOUGHT two\nSECRET_RAW_THOUGHT three' });
  await new Promise((r) => setTimeout(r, 60)); // > the ~30ms think-flush coalesce window
  let frame = lastFrame() ?? '';
  assert.match(frame, /∴ Thinking…/, 'shows the compact live thinking indicator');
  assert.doesNotMatch(frame, /SECRET_RAW_THOUGHT/, 'never streams the raw thought into the live preview (the split)');

  bus.emit({ type: 'reasoning_done', text: 'SECRET_RAW_THOUGHT one\nSECRET_RAW_THOUGHT two\nSECRET_RAW_THOUGHT three' });
  await new Promise((r) => setTimeout(r, 60));
  frame = lastFrame() ?? '';
  assert.match(frame, /∴ Thinking/, 'commits a COLLAPSED ∴ Thinking row to the transcript');
  assert.doesNotMatch(frame, /SECRET_RAW_THOUGHT/, 'the raw thought is folded (Ctrl-O), not dumped inline');
  unmount();
});

// Collapsible task list: Ctrl-T folds the pinned todo box to its header and back.
test('Ctrl-T folds the pinned task list (header stays, items hide)', async () => {
  const bus = new EventBus();
  const { lastFrame, stdin, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ bus }) }));
  await new Promise((r) => setTimeout(r, 20));
  bus.emit({
    type: 'todo',
    items: [
      { id: 'todo-1', subject: 'Refactor transcript', status: 'completed' },
      { id: 'todo-2', subject: 'Wire composer queue', status: 'in_progress' },
    ],
  });
  await new Promise((r) => setTimeout(r, 20));

  // Expanded by default: ▾ header + items visible.
  let frame = lastFrame() ?? '';
  assert.match(frame, /▾ Task list 1\/2/, 'task list starts expanded');
  assert.match(frame, /Refactor transcript/, 'items visible when expanded');

  // Ctrl-T (0x14) folds it: ▸ header with the Ctrl-T hint, items hidden.
  stdin.write('\x14');
  await new Promise((r) => setTimeout(r, 20));
  frame = lastFrame() ?? '';
  assert.match(frame, /▸ Task list 1\/2 · Ctrl-T/, 'collapsed header shows ▸, count, and hint');
  assert.doesNotMatch(frame, /Refactor transcript/, 'items hidden when collapsed');

  // Ctrl-T again expands.
  stdin.write('\x14');
  await new Promise((r) => setTimeout(r, 20));
  frame = lastFrame() ?? '';
  assert.match(frame, /Refactor transcript/, 'items visible again after re-expand');
  unmount();
});
