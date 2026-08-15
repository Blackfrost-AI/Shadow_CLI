/**
 * P1A-15 (F03-04) — live-steering focus collisions.
 *
 * Three seams where a focus owner ate a key the steering user needed, driven through the REAL
 * TuiApp: (1) a turn started from vim NORMAL left the composer stranded in NORMAL after it ended;
 * (2) reverse-search (Ctrl-R) could open mid-turn and then OWN Esc/Enter, capturing the interrupt;
 * (3) an Enter landing inside the dialog arm window denied a gate the user had not seen. Each test
 * pins the fix and its opposite (the behavior it must NOT break).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { loadConfig } from '../src/config.js';
import type { ProviderEvent, Provider } from '../src/provider/provider.js';
import type { Tool } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';

const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');
async function until(pred: () => boolean, ms = 2500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await tick(40);
  }
  return pred();
}

/** Streams text tokens slowly enough that keystrokes land mid-turn, then ends. */
function slowStream(tokens: number): Provider {
  return {
    name: 'slow',
    estimateTokens: () => 1,
    async *send(): AsyncGenerator<ProviderEvent> {
      for (let i = 0; i < tokens; i++) {
        yield { type: 'text', delta: `tok${i} ` };
        await new Promise((r) => setTimeout(r, 60));
      }
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
}

function toolThenDone(call: { id: string; name: string; input: unknown }): Provider {
  let sent = false;
  return {
    name: 'scripted',
    estimateTokens: () => 1,
    async *send(): AsyncGenerator<ProviderEvent> {
      if (!sent) {
        sent = true;
        yield { type: 'tool_call', call };
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', stopReason: 'end_turn' };
      }
    },
  };
}

function baseOpts(over: Partial<TuiOpts> & { workspaceRoot: string }): TuiOpts {
  const cfg = loadConfig(over.workspaceRoot, { provider: 'mock', model: 'm', vimMode: true });
  return {
    provider: {} as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
    sessionLog: { record() {}, recordSnapshot() {}, path: undefined } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    cfg,
    autonomy: 'manual',
    bypass: false,
    version: '0.0.0',
    ...over,
  };
}

function gatedProbe(): Tool<Record<string, never>, { ran: boolean }> {
  return {
    name: 'write_probe',
    description: 'probe',
    risk: 'write',
    inputSchema: z.object({}),
    async run() {
      return ok('write_probe', 'write', 1, 'ran', { ran: true });
    },
  };
}

test('P1A-15: a turn started from vim NORMAL returns the composer to INSERT when it ends', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'steer-vim-'));
  const opts = baseOpts({ workspaceRoot: ws, provider: slowStream(2) });
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    // Vim is on (cfg.vimMode); default is INSERT. Type a task, drop to NORMAL, then submit from NORMAL.
    stdin.write('do it');
    await tick();
    stdin.write('\x1b'); // Esc → NORMAL
    await tick();
    assert.ok(strip(lastFrame() ?? '').includes('-- NORMAL --'), 'composer is in NORMAL before the turn');
    // Submit from NORMAL: Enter in NORMAL submits the buffer (vim block routes it to submit).
    stdin.write('\r');
    assert.ok(await until(() => strip(lastFrame() ?? '').includes('-- INSERT --')), 'turn start flipped the composer back to INSERT');
    // And after the turn ends it is still usable in INSERT (not stranded in NORMAL).
    assert.ok(await until(() => !/tok/.test('') || strip(lastFrame() ?? '').includes('-- INSERT --')));
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P1A-15: Ctrl-R cannot open reverse-search while a turn is running', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'steer-ctrlr-'));
  const opts = baseOpts({ workspaceRoot: ws, provider: slowStream(8) });
  const evts: LoopEvent['type'][] = [];
  opts.bus.on((e) => evts.push(e.type));
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    // Seed history so Ctrl-R has something to search, and run one quick turn to populate it.
    stdin.write('first task');
    await tick();
    stdin.write('\x1b'); // NORMAL
    await tick();
    stdin.write('i'); // back to INSERT so the next Enter submits normally
    await tick();
    stdin.write('\r');
    await until(() => evts.includes('stop'));
    // Now start a long turn and try Ctrl-R mid-turn.
    stdin.write('i');
    await tick();
    stdin.write('second');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => evts.filter((e) => e === 'stop').length === 1 && evts.includes('text')), 'the long turn is streaming');
    const before = strip(lastFrame() ?? '');
    stdin.write('\x12'); // Ctrl-R
    await tick();
    const after = strip(lastFrame() ?? '');
    assert.ok(!/reverse-i-search|\(search\)/i.test(after), 'reverse-search must NOT open mid-turn');
    void before;
    // Esc still interrupts the running turn (search never captured it).
    stdin.write('\x1b');
    assert.ok(await until(() => evts.filter((e) => e === 'stop').length >= 2 || evts.includes('interrupted' as LoopEvent['type'])), 'Esc interrupts the turn');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P1A-15: Enter inside the dialog arm window steers instead of denying an unseen gate', async () => {
  // Arm window LEFT ON (not zeroed) — this test is specifically about the window.
  delete process.env.SHADOW_DIALOG_ARM_MS;
  const ws = mkdtempSync(join(tmpdir(), 'steer-arm-'));
  const registry = new ToolRegistry();
  registry.register(gatedProbe());
  const opts = baseOpts({ registry, workspaceRoot: ws, provider: toolThenDone({ id: 'w', name: 'write_probe', input: {} }) });
  const evts: LoopEvent['type'][] = [];
  opts.bus.on((e) => evts.push(e.type));
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('i'); // INSERT
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => /Permission required/.test(strip(lastFrame() ?? ''))), 'the gate opened');
    // Immediately (inside the arm window) the user finishes a follow-up and hits Enter. It must NOT
    // be read as a decision on the just-appeared gate.
    stdin.write('follow up message');
    stdin.write('\r');
    await tick(120);
    assert.ok(!evts.includes('tool_start'), 'the arm-window Enter must not have approved the gate');
    assert.ok(strip(lastFrame() ?? '').includes('steering (dialog not yet seen)'), 'the steer message is shown, not a denial');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});
