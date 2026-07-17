/**
 * Dialog KEY-PATH integration tests — the approval + question dialogs are driven through the REAL
 * TuiApp (ink-testing-library), pressing keys and asserting the gate resolves. This locks the
 * keybinding-resolver routing added when the dialogs were migrated onto the resolver: bound keys
 * (y/n for Confirmation, enter/number-jump for QuestionDialog) must still approve/answer, with the
 * legacy inline path as the fallback. Previously only the gate LOGIC was tested, never the keystrokes.
 *
 * Assertions target what the REFACTOR governs — routing a keypress to a dialog resolution — via
 * bus events + dialog closure, not full turn completion (the async loop's tail doesn't settle
 * deterministically under ink-testing-library, so we abort the turn at the end for a clean exit).
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
import { makeAskUserQuestionTool } from '../src/tools/askUser.js';
import { loadConfig } from '../src/config.js';
import type { ProviderEvent, Provider } from '../src/provider/provider.js';
import type { Tool } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';

const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');
/** Poll a predicate up to `ms`, checking every 40ms — robust against async-loop timing jitter. */
async function until(pred: () => boolean, ms = 2500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await tick(40);
  }
  return pred();
}

/** A provider that yields a scripted tool_call on the FIRST turn, then ends cleanly. */
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
  const cfg = loadConfig(over.workspaceRoot, { provider: 'mock', model: 'm' });
  return {
    provider: {} as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
    sessionLog: { record() {}, recordSnapshot() {}, path: undefined } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: over.workspaceRoot,
    cfg,
    autonomy: 'manual',
    bypass: false,
    version: '0.0.0',
    ...over,
  };
}

test('approval dialog: "y" routes through the resolver → approves → the tool starts (not denied)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dlg-approve-'));
  const probe: Tool<Record<string, never>, { ran: boolean }> = {
    name: 'write_probe',
    description: 'probe',
    risk: 'write',
    inputSchema: z.object({}),
    async run() {
      return ok('write_probe', 'write', 1, 'ran', { ran: true });
    },
  };
  const registry = new ToolRegistry();
  registry.register(probe);
  const opts = baseOpts({ registry, workspaceRoot: ws, autonomy: 'manual', provider: toolThenDone({ id: 'w', name: 'write_probe', input: {} }) });
  const evts: LoopEvent['type'][] = [];
  opts.bus.on((e) => evts.push(e.type));
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');
    // The approval dialog opens (tool gated at autonomy=manual).
    assert.ok(await until(() => /Permission required/.test(strip(lastFrame() ?? ''))), 'approval dialog opened');
    assert.ok(!evts.includes('tool_start'), 'the tool has NOT started — it is waiting on approval');

    stdin.write('y'); // approve via the keybinding resolver (Confirmation → confirm:yes)
    // Approval routed correctly ⟺ the dialog closes AND execution begins (tool_start). A DENY would
    // instead emit tool_denied and never start the tool, so tool_start is the approve-vs-deny proof.
    assert.ok(await until(() => evts.includes('tool_start')), 'pressing y approved: the tool started');
    assert.ok(!evts.includes('tool_denied'), 'the tool was approved, not denied');
    assert.ok(!/Permission required/.test(strip(lastFrame() ?? '')), 'the approval dialog closed after y');
  } finally {
    stdin.write('\x1b'); // Esc — abort the turn so the loop terminates and the process can exit
    await tick(120);
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('question dialog: number-jump + Enter routes through the resolver and closes the dialog', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'dlg-question-'));
  const registry = new ToolRegistry();
  registry.register(makeAskUserQuestionTool());
  const opts = baseOpts({
    registry,
    workspaceRoot: ws,
    autonomy: 'full',
    provider: toolThenDone({ id: 'q', name: 'ask_user_question', input: { questions: [{ question: 'Which target?', options: [{ label: 'Alpha' }, { label: 'Bravo' }] }] } }),
  });
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => /Which target\?/.test(strip(lastFrame() ?? ''))), 'question dialog opened');

    stdin.write('2'); // number-jump to option 2 (inline fallback path)
    await tick();
    stdin.write('\r'); // confirm via the resolver (QuestionDialog → question:confirm)
    // The confirm routed correctly ⟺ the question dialog closes (answer submitted to the gate).
    assert.ok(await until(() => !/Which target\?/.test(strip(lastFrame() ?? ''))), 'the question dialog closed after Enter');
  } finally {
    stdin.write('\x1b');
    await tick(120);
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});
