/**
 * B2 — the type-ahead approval leak, driven through the REAL TuiApp.
 *
 * "Keep typing your next message while the agent works" is an advertised workflow, and a permission
 * gate can open MID-SENTENCE. Every in-flight keystroke was then routed into the dialog as a
 * DECISION. Typing "also fix the failing test" while a run_shell gate opened hit:
 *   - `f` → approve-for-prefix, a SESSION-WIDE grant on the pending command
 *   - `a` → raise autonomy
 *   - `y` → approve
 * The tool ran and the dialog vanished before the user's eyes reached it.
 *
 * The guard: a key only counts as a decision if it was pressed AFTER the dialog was on screen.
 * These tests assert both halves — the leak is closed, AND a real (post-arming) keypress still
 * works, because a guard that swallowed genuine answers would be its own bug.
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

// NOT zeroed here: this file is the one that must exercise the real guard.
if (process.env.SHADOW_TYPEAHEAD_UNGUARDED !== '1') delete process.env.SHADOW_DIALOG_ARM_MS;

const ARM_MS = 275;
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
    context: new Context({
      contextBudget: cfg.contextBudget,
      triggerRatio: cfg.summarizeTriggerRatio,
      keepLastTurns: cfg.keepLastTurns,
    }),
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

test('B2: a sentence typed as the dialog opens approves nothing and stays in the composer', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'typeahead-'));
  const registry = new ToolRegistry();
  registry.register(gatedProbe());
  const opts = baseOpts({
    registry,
    workspaceRoot: ws,
    autonomy: 'manual',
    provider: toolThenDone({ id: 'w', name: 'write_probe', input: {} }),
  });
  const evts: LoopEvent['type'][] = [];
  opts.bus.on((e) => evts.push(e.type));
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => /Permission required/.test(strip(lastFrame() ?? ''))), 'the gate opened');

    // The user was mid-sentence when it opened. Every one of these is a live dialog binding:
    // y=approve, n=deny, s=approve-for-session, f=approve-for-prefix, a=raise autonomy.
    for (const chunk of 'also ') stdin.write(chunk);
    await tick(ARM_MS + 80); // the rest of this SAME typing burst lands after the old fixed window
    for (const chunk of 'fix the failing test') stdin.write(chunk);
    await tick(120);

    assert.ok(!evts.includes('tool_start'), 'no keystroke may have approved the call');
    assert.ok(!evts.includes('tool_denied'), 'no keystroke may have denied it either');
    assert.ok(
      /Permission required/.test(strip(lastFrame() ?? '')),
      'the dialog must still be open — the user has not answered it yet',
    );
    // The sentence went where the user aimed it.
    assert.ok(
      strip(lastFrame() ?? '').includes('also fix the failing test'),
      `the typed text must survive in the composer, frame:\n${strip(lastFrame() ?? '')}`,
    );
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('B2: a deliberate keypress after the arming window still approves', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'typeahead-ok-'));
  const registry = new ToolRegistry();
  registry.register(gatedProbe());
  const opts = baseOpts({
    registry,
    workspaceRoot: ws,
    autonomy: 'manual',
    provider: toolThenDone({ id: 'w', name: 'write_probe', input: {} }),
  });
  const evts: LoopEvent['type'][] = [];
  opts.bus.on((e) => evts.push(e.type));
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => /Permission required/.test(strip(lastFrame() ?? ''))), 'the gate opened');

    await tick(ARM_MS + 120); // the human reads the dialog, then answers
    stdin.write('y');

    assert.ok(await until(() => evts.includes('tool_start')), 'a real answer must still approve');
    assert.ok(!evts.includes('tool_denied'), 'approved, not denied');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('reserved chord: Ctrl-C reaches the app while an approval dialog holds focus', async () => {
  // Ctrl-C used to sit BELOW the dialog branch, which returns on every key — so it was dead for
  // the whole life of a modal, on a screen still advertising "Ctrl-C ×2 quits". It is now
  // dispatched above every focus owner, and above the type-ahead guard, so the escape hatch can
  // never be the thing that gets swallowed.
  const ws = mkdtempSync(join(tmpdir(), 'ctrlc-dialog-'));
  const registry = new ToolRegistry();
  registry.register(gatedProbe());
  const opts = baseOpts({
    registry,
    workspaceRoot: ws,
    autonomy: 'manual',
    provider: toolThenDone({ id: 'w', name: 'write_probe', input: {} }),
  });
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => /Permission required/.test(strip(lastFrame() ?? ''))), 'the gate opened');

    stdin.write('\x03'); // Ctrl-C, immediately — inside the arming window on purpose
    assert.ok(
      await until(() => /press Ctrl-C again to quit/.test(strip(lastFrame() ?? ''))),
      `Ctrl-C must be heard while the dialog has focus, frame:\n${strip(lastFrame() ?? '')}`,
    );
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});
