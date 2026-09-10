import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { EventBus } from '../src/agent/events.js';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { ActivityHistory, isRoutineCall, type ToolEnd } from '../src/tui/activity.js';
import { ActivityOverlay, useActivityView } from '../src/tui/activityView.js';
import { useInput } from 'ink';
import { displayWidth } from '../src/util/width.js';
import { FlatItem } from '../src/tui/chrome.js';

const settle = () => new Promise((r) => setTimeout(r, 30));
function tool(id: number, over: Partial<ToolEnd> = {}): ToolEnd {
  return {
    type: 'tool_end',
    call: {
      id: String(id),
      name: 'run_shell',
      input: { command: `cat /tmp/example-${id}.txt 2>&1` },
    },
    result: {
      ok: true,
      summary: 'Command exited 0.',
      data: { stdout: 'first\nsecond\nthird\nfourth' },
      meta: { tool: 'run_shell', durationMs: 5, risk: 'exec' },
    },
    ...over,
  };
}
function opts(bus: EventBus): TuiOpts {
  return {
    bus,
    provider: {} as TuiOpts['provider'],
    registry: {} as TuiOpts['registry'],
    context: { reset() {} } as TuiOpts['context'],
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: '',
    workspaceRoot: '/tmp',
    cfg: { provider: 'mock', model: 'fixture-model', reducedMotion: true } as TuiOpts['cfg'],
    autonomy: 'auto-edit',
    bypass: false,
    version: 'test',
  };
}

test('sequential shell calls and interleaved reasoning stay live and commit one accurate group', async () => {
  const bus = new EventBus();
  const app = render(React.createElement(TuiApp, { opts: opts(bus) }));
  try {
    await settle();
    for (let n = 1; n <= 100; n++) {
      bus.emit({ type: 'reasoning_done', text: `private fixture thought ${n}` });
      const e = tool(n);
      bus.emit({ type: 'tool_start', call: e.call, risk: 'exec' });
      bus.emit(e);
      await settle(); // independent Ink flushes, not a prebuilt array or a batched render
      if (n === 1 || n === 10 || n === 100) {
        const frame = app.lastFrame()!;
        assert.match(frame, new RegExp(`Working… · ${n} command${n === 1 ? '' : 's'}`));
        assert.doesNotMatch(
          frame,
          /\[DONE\]|private fixture thought|Command exited|output 4 lines/,
        );
        assert.equal(frame.split('\n').filter((l) => l.includes('Working…')).length, 1);
      }
    }
    // Ending the phase with prose commits its group before the answer, without losing count.
    bus.emit({ type: 'text', delta: 'The inspection is complete.\n' });
    bus.emit({ type: 'assistant_done', text: 'The inspection is complete.' });
    await settle();
    const frame = app.lastFrame()!;
    assert.equal((frame.match(/\[DONE\] 100 commands/g) ?? []).length, 1);
    assert.ok(frame.indexOf('[DONE] 100 commands') < frame.indexOf('The inspection is complete.'));
    assert.doesNotMatch(frame, /◆ SHADOW|> YOU/);
    assert.match(frame, /mock\/fixture-model/, 'model information remains in the footer');
    assert.doesNotMatch(frame, /private fixture thought/);
  } finally {
    app.unmount();
  }
});

test('failed and mutating tools remain visible; full output survives display limits', async () => {
  const bus = new EventBus();
  const app = render(React.createElement(TuiApp, { opts: opts(bus) }));
  try {
    await settle();
    bus.emit(tool(1));
    const failure = tool(2);
    failure.result = {
      ...failure.result,
      ok: false,
      summary: 'Cannot open fixture',
      data: { stdout: Array.from({ length: 500 }, (_, i) => `fixture-line-${i}`).join('\n') },
    };
    bus.emit(failure);
    await settle();
    assert.match(app.lastFrame()!, /FAILED Bash.*Cannot open fixture/);
    app.stdin.write('\u001bo'); // Option+O: latest result, without expanding earlier output
    await settle();
    assert.match(app.lastFrame()!, /Snapshot.*work continues/);
    app.stdin.write('G');
    await settle();
    assert.match(app.lastFrame()!, /fixture-line-499/);
    assert.doesNotMatch(app.lastFrame()!, /earlier lines omitted|elided/);
    app.stdin.write('q');
    await settle();
    const edit = tool(3, { call: { id: '3', name: 'edit_file', input: { path: 'example.ts' } } });
    edit.result = {
      ...edit.result,
      summary: 'Updated example.ts',
      meta: {
        ...edit.result.meta,
        diff: [
          { tag: '-', text: 'old' },
          { tag: '+', text: 'new' },
        ],
      },
    };
    bus.emit(edit);
    await settle();
    assert.match(app.lastFrame()!, /DONE Update.*\+1 −1/);
  } finally {
    app.unmount();
  }
});

test('activity inspection protects the draft and Escape returns without interrupting work', async () => {
  const bus = new EventBus();
  const app = render(React.createElement(TuiApp, { opts: opts(bus) }));
  try {
    await settle();
    app.stdin.write('unfinished draft');
    bus.emit(tool(1));
    await settle();
    app.stdin.write('\x0f');
    await settle();
    assert.match(app.lastFrame()!, /Activity\n/);
    app.stdin.write('z');
    app.stdin.write('\x1b[200~PASTE INTO DETAILS\x1b[201~');
    bus.emit(tool(2));
    await settle();
    assert.match(app.lastFrame()!, /1 command/); // snapshot does not jump on incoming events
    app.stdin.write('\u001b');
    await settle();
    assert.match(app.lastFrame()!, /unfinished draft/);
    assert.doesNotMatch(app.lastFrame()!, /unfinished draftz/);
    assert.doesNotMatch(app.lastFrame()!, /PASTE INTO DETAILS/);
    assert.match(app.lastFrame()!, /Working… · 2 commands/);
  } finally {
    app.unmount();
  }
});

test('finishing one of two overlapping calls keeps the other visible', async () => {
  const bus = new EventBus();
  const app = render(React.createElement(TuiApp, { opts: opts(bus) }));
  try {
    await settle();
    const first = tool(1),
      second = tool(2);
    bus.emit({ type: 'tool_start', call: first.call, risk: 'exec' });
    bus.emit({ type: 'tool_start', call: second.call, risk: 'exec' });
    await settle();
    assert.match(app.lastFrame()!, /example-2.txt.*\+1 active/);
    bus.emit(first);
    await settle();
    assert.match(app.lastFrame()!, /Bash.*example-2.txt/);
    assert.doesNotMatch(app.lastFrame()!, /\+1 active|Waiting for model/);
    bus.emit(second);
    await settle();
    assert.match(app.lastFrame()!, /Working… · 2 commands/);
  } finally {
    app.unmount();
  }
});

test('stream preview keeps the formatted code gutter and list indentation when taking its tail', () => {
  for (const text of [
    '```ts\nconst long = "' + 'value '.repeat(30) + '";\n```',
    '- ' + 'list item '.repeat(40),
  ]) {
    const item = { id: -1, kind: 'assistant' as const, text, tight: true };
    const props = { item, cols: 40, collapsed: false, continuation: true };
    const full = render(React.createElement(FlatItem, props));
    const tail = render(React.createElement(FlatItem, { ...props, maxRows: 3 }));
    try {
      assert.equal(tail.lastFrame(), full.lastFrame()!.split('\n').slice(-3).join('\n'));
      assert.ok(
        tail
          .lastFrame()!
          .split('\n')
          .every((line) => (text.startsWith('```') ? line.includes('│ ') : /^\s{5,}/.test(line))),
      );
    } finally {
      full.unmount();
      tail.unmount();
    }
  }
});

test('table expansion is independent of activity details', async () => {
  const bus = new EventBus();
  const app = render(React.createElement(TuiApp, { opts: opts(bus) }));
  try {
    await settle();
    bus.emit(tool(1));
    const table =
      '| Item | State |\n| --- | --- |\n' +
      Array.from({ length: 10 }, (_, i) => `| row-${i} | ready |`).join('\n');
    bus.emit({ type: 'assistant_done', text: table });
    await settle();
    const id = app.lastFrame()!.match(/\/expand (\d+)/)?.[1];
    assert.ok(id, 'the table advertises its own expansion command');
    app.stdin.write(`/expand ${id}`);
    app.stdin.write('\r');
    await settle();
    assert.match(app.lastFrame()!, /row-9/);
    assert.doesNotMatch(app.lastFrame()!, /first\nsecond|stdout:/);
  } finally {
    app.unmount();
  }
});

test('display grouping checks compound commands and preserves unknown actions', () => {
  assert.equal(
    isRoutineCall('run_shell', { command: 'ls -la /Applications 2>&1 | head -30' }),
    true,
  );
  assert.equal(
    isRoutineCall('run_shell', { command: 'cat /tmp/example; printf changed > /tmp/output' }),
    false,
  );
  assert.equal(isRoutineCall('run_shell', { command: 'npm test' }), false);
  assert.equal(isRoutineCall('memory', { action: 'remember' }), false);
});

test('detail journal preserves full records and reset invalidates old IDs', () => {
  const history = new ActivityHistory();
  try {
    const e = tool(1);
    e.result.data = { stdout: 'BEGIN\n' + 'data\n'.repeat(500) + 'END' };
    history.tool(e);
    const first = history.close()!;
    const entry = history.entries(first.id)[0]!;
    assert.match(history.read(entry.id), /BEGIN[\s\S]*END/);
    history.reset();
    history.tool(tool(2));
    assert.notEqual(history.summary()!.id, first.id);
    assert.match(history.read(entry.id), /no longer available/);
  } finally {
    history.reset();
  }
});

test('detail view fits a narrow terminal and keeps long Unicode output readable', async () => {
  const history = new ActivityHistory();
  history.reasoning('界面 '.repeat(100), 10);
  history.close();
  function Harness() {
    const viewer = useActivityView(history, 40, 12);
    useInput(viewer.handleKey);
    React.useEffect(() => {
      viewer.open(undefined, true);
    }, [viewer.open]);
    return viewer.view
      ? React.createElement(ActivityOverlay, { view: viewer.view, cols: 40, rows: 12 })
      : null;
  }
  const app = render(React.createElement(Harness));
  try {
    await settle();
    const lines = app.lastFrame()!.split('\n');
    assert.ok(lines.length < 12);
    assert.ok(lines.every((l) => displayWidth(l) < 40));
    assert.match(app.lastFrame()!, /界面/);
    app.stdin.write('G');
    await settle();
    assert.match(app.lastFrame()!, /界面/);
  } finally {
    app.unmount();
    history.reset();
  }
});
