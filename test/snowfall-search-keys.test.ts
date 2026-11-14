/**
 * Ctrl+G ownership across the transcript-search and external-editor surfaces.
 *
 * The pi engine claims Ctrl+G for "next search match" while the search overlay
 * is focused (tui-alt-screen.js handleViewportInput), and its viewport input
 * listener is registered before any app listener, so a consumed key never
 * reaches ShadowApp's handler. The app additionally defers on ANY open overlay
 * before its own Ctrl+G external-editor branch. These tests pin both layers
 * end-to-end through a real alt-screen Tui + the real ShadowApp listener, so a
 * future reorder (or a search bar that stops being an overlay) fails here
 * instead of silently opening $EDITOR mid-search.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome } from './helpers/isolateHome.js';
import { HeadlessTerminal } from './helpers/snowfallTerminal.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';

const isolated = isolateHome('search-keys');
const { ShadowApp } = await import('../src/app/app.js');
const { loadConfig } = await import('../src/config.js');
const { Context } = await import('../src/agent/context.js');
const { EventBus } = await import('../src/agent/events.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { SessionLog } = await import('../src/state/session.js');
after(async () => { await removeFixtureTree(isolated.home); });

const CTRL_G = '\x07';

const until = async (fn: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!fn() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(fn());
};

async function fixture(name: string) {
  const root = join(isolated.home, name); mkdirSync(root);
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const context = new Context({ contextBudget: 32768, triggerRatio: .8, keepLastTurns: 4 });
  const log = SessionLog.open(root); const terminal = new HeadlessTerminal(120, 40);
  const app = new ShadowApp({ provider: { name: 'mock', estimateTokens: () => 1,
    async *send() { yield { type: 'text', delta: 'unexpected model call' }; } }, cfg,
    bus: new EventBus(), registry: new ToolRegistry(), sessionLog: log, context, system: 'fixture',
    workspaceRoot: root, autonomy: 'manual', bypass: false, offline: true, version: 'test' }, terminal);
  const run = app.run();
  const screen = () => terminal.lines().join('\n');
  const dispose = async () => { app.stop(); await run; log.close(); terminal.screen.dispose(); };
  return { app, terminal, screen, dispose };
}

type AppInternals = {
  tui: {
    hasOverlay(): boolean;
    toggleSearch(): void;
    setFocus(component: unknown): void;
    addInputListener(listener: (data: string) => { consume?: boolean } | undefined): void;
  };
  editor: unknown;
  onTextDelta(delta: string): void;
  flushStreamToTranscript(): void;
  openExternalEditor(): void;
};

/** Two assistant turns containing a unique token so the query has ≥2 matches. */
function seedTranscript(internals: AppInternals): void {
  for (const text of ['alpha needle token here', 'beta needle token here']) {
    internals.onTextDelta(text);
    internals.flushStreamToTranscript();
  }
}

test('focused search consumes Ctrl+G before any later-registered app listener', async () => {
  const { app, terminal, screen, dispose } = await fixture('focused');
  const internals = app as unknown as AppInternals;
  try {
    seedTranscript(internals);
    await terminal.flush();
    let laterSawCtrlG = 0;
    // Registered AFTER the app listener — exactly where a future feature would sit.
    internals.tui.addInputListener((data) => {
      if (data === CTRL_G) laterSawCtrlG += 1;
      return undefined;
    });
    internals.tui.toggleSearch();
    await terminal.flush();
    assert.equal(internals.tui.hasOverlay(), true, 'search bar must be a real overlay');
    terminal.input('needle');
    await until(() => screen().includes('1/2'));

    terminal.input(CTRL_G);
    await until(() => screen().includes('2/2'));
    assert.equal(laterSawCtrlG, 0, 'engine consumed Ctrl+G — app listeners never see it');
  } finally { await dispose(); }
});

test('open-but-unfocused search still defers: the overlay guard blocks the editor branch', async () => {
  const { app, terminal, dispose } = await fixture('unfocused');
  const internals = app as unknown as AppInternals;
  try {
    let editorCalls = 0;
    internals.openExternalEditor = () => { editorCalls += 1; };
    internals.tui.toggleSearch();
    await terminal.flush();
    // Move focus off the search input back to the composer; the overlay stays open.
    internals.tui.setFocus(internals.editor);
    await terminal.flush();
    assert.equal(internals.tui.hasOverlay(), true);

    terminal.input(CTRL_G);
    await terminal.flush();
    assert.equal(editorCalls, 0, 'hasOverlay() guard must defer before the Ctrl+G editor branch');
  } finally { await dispose(); }
});

test('idle Ctrl+G still opens the external editor when no overlay is open', async () => {
  const { app, terminal, dispose } = await fixture('idle');
  const internals = app as unknown as AppInternals;
  try {
    let editorCalls = 0;
    internals.openExternalEditor = () => { editorCalls += 1; };
    assert.equal(internals.tui.hasOverlay(), false);
    terminal.input(CTRL_G);
    await until(() => editorCalls === 1);
  } finally { await dispose(); }
});
