/**
 * Ink Ctrl+N — work-center parity with Snowfall's Ctrl+N work overlay.
 *
 * The binding routes to the SAME /work slash surface (read-only), so it must
 * also work mid-turn: checking background work is exactly what an operator
 * does while a turn runs. The submit path's SLASH_WHILE_RUNNING gate does not
 * apply to the keybinding handler.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink-testing-library';
import { isolateHome } from './helpers/isolateHome.js';

isolateHome('ink-work-key');

const { TuiApp } = await import('../src/tui.js');
const { EventBus } = await import('../src/agent/events.js');
const { Context } = await import('../src/agent/context.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { loadConfig } = await import('../src/config.js');
const { WorkCenter } = await import('../src/app/workCenter.js');
const { BgRegistry } = await import('../src/tools/bgShell.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function baseProps() {
  const cfg = loadConfig(ROOT, { provider: 'mock', model: 'm' });
  return {
    provider: {
      name: 'mock',
      async *send() { yield { type: 'text' as const, delta: 'ok' }; },
      estimateTokens: () => 1,
    },
    context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
    system: 'test',
    registry: new ToolRegistry(),
    bus: new EventBus(),
    cfg,
    workspaceRoot: ROOT,
    autonomy: 'manual' as const,
    bypass: false,
    version: 'test',
    sessionLog: { record() {}, recordSnapshot() {}, path: undefined, title: undefined } as never,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => wait(150);
async function until(pred: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await wait(40);
  }
  return pred();
}

/** Streams tokens slowly enough that keystrokes land mid-turn, then ends. */
function slowStream() {
  return {
    name: 'slow',
    estimateTokens: () => 1,
    async *send() {
      for (let i = 0; i < 25; i++) {
        yield { type: 'text' as const, delta: `tok${i} ` };
        await wait(60);
      }
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
}

test('Ctrl+N opens the work center in Ink', async () => {
  const opts = { ...baseProps(), workCenter: new WorkCenter(), bgRegistry: new BgRegistry() };
  const { lastFrame, stdin, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await settle();
    assert.ok(!lastFrame()!.includes('No work items'), 'work center must not be open before the keypress');
    stdin.write('\x0e'); // Ctrl+N
    await settle();
    assert.match(lastFrame()!, /No work items/, 'Ctrl+N must open the /work surface');
  } finally {
    unmount();
  }
});

test('Ctrl+N opens the work center MID-TURN (the keybinding bypasses SLASH_WHILE_RUNNING)', async () => {
  const opts = { ...baseProps(), provider: slowStream(), workCenter: new WorkCenter(), bgRegistry: new BgRegistry() };
  const { lastFrame, stdin, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await settle();
    stdin.write('do the thing');
    await wait(80);
    stdin.write('\r'); // submit — starts a ~1.5s turn
    assert.ok(await until(() => (lastFrame() ?? '').includes('tok0')), 'turn must be in flight');
    stdin.write('\x0e'); // Ctrl+N while the turn runs
    assert.ok(await until(() => (lastFrame() ?? '').includes('No work items')),
      'Ctrl+N must open the work center while a turn is running');
    // The turn keeps streaming — the work center did not interrupt or capture it.
    assert.ok(await until(() => (lastFrame() ?? '').includes('tok5')), 'turn must keep streaming after Ctrl+N');
  } finally {
    unmount();
  }
});
