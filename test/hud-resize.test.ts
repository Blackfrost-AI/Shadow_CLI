import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';

// ── A stdout Ink will actually render into, WITH a real `rows` (which ink-testing-library omits) ──
// Ink wipes the whole screen + scrollback on every render when outputHeight >= stdout.rows
// (node_modules/ink/build/ink.js:121) — the split-pane/resize flicker. We capture every byte Ink
// writes and assert its scrollback-wipe escape (\x1b[3J, part of ansiEscapes.clearTerminal) NEVER
// appears: i.e. the live frame stays under the terminal height at a small size.
class SizedStdout extends EventEmitter {
  writes: string[] = [];
  columns = 80;
  constructor(public rows: number) { super(); }
  write = (s: string): boolean => { this.writes.push(s); return true; };
  get isTTY(): boolean { return true; }
}
class FakeStdin extends EventEmitter {
  isTTY = true;
  write = (): void => {};
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): unknown => null;
}

function makeOpts(bus: EventBus): TuiOpts {
  return {
    provider: {} as TuiOpts['provider'],
    registry: {} as TuiOpts['registry'],
    bus,
    context: {} as TuiOpts['context'],
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: '',
    workspaceRoot: '/tmp/ws',
    cfg: { provider: 'mock', model: 'claude-opus-4-8' } as unknown as TuiOpts['cfg'],
    autonomy: 'auto-edit',
    bypass: false,
    version: '9.9.9',
  };
}

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SCROLLBACK_WIPE = '\x1b[3J'; // the distinctive part of Ink's clearTerminal fallback

async function mount(bus: EventBus, rows: number) {
  const stdout = new SizedStdout(rows);
  const app = render(React.createElement(TuiApp, { opts: makeOpts(bus) }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { stdout, app };
}
const wipes = (s: SizedStdout): number => s.writes.filter((w) => w.includes(SCROLLBACK_WIPE)).length;

test('short/split-pane terminal: streaming steady-state never trips the scrollback-wipe', async () => {
  for (const rows of [6, 8, 10, 12]) {
    const bus = new EventBus();
    const { stdout, app } = await mount(bus, rows);
    await tick();
    bus.emit({ type: 'thinking', delta: 'considering the options here\nand some more' });
    bus.emit({ type: 'text', delta: 'Here is a long streaming answer.\nline two\nline three\nline four\nline five' });
    await tick(80);
    const w = wipes(stdout); app.unmount();
    assert.equal(w, 0, `streaming HUD wiped ${w}× at a steady ${rows}-row terminal`);
  }
});

test('after a resize DOWN settles, streaming does not flicker (no persistent wipe)', async () => {
  const bus = new EventBus();
  const { stdout, app } = await mount(bus, 12);
  await tick();
  bus.emit({ type: 'text', delta: 'streaming answer line one\nline two\nline three' });
  await tick(60);
  stdout.rows = 7; stdout.emit('resize'); // shrink to a small pane mid-stream
  await tick(80);
  stdout.writes.length = 0; // ignore the one-frame resize transient; measure STEADY STATE from here
  // more renders at the new size (further streaming + a spinner-like status change)
  bus.emit({ type: 'text', delta: '\nline four\nline five\nline six' });
  await tick(80);
  const w = wipes(stdout); app.unmount();
  assert.equal(w, 0, `post-resize steady state wiped ${w}× — the frame does not fit the 7-row pane`);
});

test('short terminal: an idle pinned task list never trips the scrollback-wipe', async () => {
  const bus = new EventBus();
  const { stdout, app } = await mount(bus, 8);
  await tick();
  bus.emit({ type: 'todo', items: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, subject: `task number ${i} to do`, status: i === 0 ? 'in_progress' : 'pending' })) });
  await tick(80);
  const w = wipes(stdout); app.unmount();
  assert.equal(w, 0, `idle pinned task list wiped ${w}× on an 8-row terminal`);
});

test('normal terminal renders fine (control): still no spurious wipe at 40 rows', async () => {
  const bus = new EventBus();
  const stdout = new SizedStdout(40);
  const stdin = new FakeStdin();
  const app = render(React.createElement(TuiApp, { opts: makeOpts(bus) }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await tick();
  bus.emit({ type: 'text', delta: 'answer streaming in…\nmore\nmore' });
  await tick(60);
  const wiped = stdout.writes.filter((w) => w.includes(SCROLLBACK_WIPE)).length;
  app.unmount();
  assert.equal(wiped, 0);
});
