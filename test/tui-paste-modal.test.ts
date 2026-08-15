/**
 * P1A-14 (F03-01) — bracketed paste is a TRANSPORT above the modal focus owners.
 *
 * Before the fix, the approval-dialog and model-picker branches returned for EVERY key BEFORE the
 * bracketed-paste detector ran. A paste into an open approval dialog therefore had its \x1b[200~
 * start marker swallowed, and the paste CONTENT flowed into the decision path chunk-by-chunk — a
 * newline arriving as its own stdin chunk parsed as key.return and could APPROVE the pending call.
 * A multi-chunk paste whose end marker arrived after the dialog closed also stranded pastingRef
 * set → permanent input lockout. These tests drive the REAL Ink pipeline and pin both halves:
 * paste content can never resolve a modal, and it can never strand paste state.
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

test('P1A-14: a bracketed paste into an open approval dialog lands in the composer and NEVER approves', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'paste-modal-'));
  const registry = new ToolRegistry();
  registry.register(gatedProbe());
  const opts = baseOpts({ registry, workspaceRoot: ws, provider: toolThenDone({ id: 'w', name: 'write_probe', input: {} }) });
  const evts: LoopEvent['type'][] = [];
  opts.bus.on((e) => evts.push(e.type));
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => /Permission required/.test(strip(lastFrame() ?? ''))), 'the gate opened');

    // Paste a multi-line blob. The embedded \r used to parse as key.return → APPROVE. Split across
    // chunks so the end marker arrives separately (the realistic large-paste shape).
    stdin.write('\x1b[200~cmd one\rcmd two\r');
    await tick();
    stdin.write('cmd three\x1b[201~');
    await tick(120);

    assert.ok(!evts.includes('tool_start'), 'the pasted newlines must NOT have approved the pending call');
    assert.ok(!evts.includes('tool_denied'), 'nor denied it');
    const f = strip(lastFrame() ?? '');
    assert.ok(/Permission required/.test(f), 'the dialog is still open — paste is not a decision');
    assert.ok(f.includes('cmd one') && f.includes('cmd three'), `pasted content must land in the composer, frame:\n${f}`);
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P1A-14: an orphaned end marker (no active paste) is swallowed — no lockout, no literal marker', async () => {
  // The stranding shape: a start marker was lost (or the modal-open reset cleared an in-flight
  // paste), so the end marker arrives with nothing buffering it. It must not lock input or land as
  // literal text — insertPastable strips bare marker fragments and the transport ignores it.
  const ws = mkdtempSync(join(tmpdir(), 'paste-orphan-'));
  const opts = baseOpts({ workspaceRoot: ws, provider: toolThenDone({ id: 'w', name: 'write_probe', input: {} }) });
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('\x1b[201~'); // orphaned end marker, no paste in flight
    await tick();
    stdin.write('typing still works');
    await tick(120);
    const f = strip(lastFrame() ?? '');
    assert.ok(f.includes('typing still works'), `next keystroke must reach the composer (no lockout), frame:\n${f}`);
    assert.ok(!f.includes('201~'), 'the orphaned end marker must not appear literally in the composer');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P1A-14: after a paste lands in the composer during a dialog, a deliberate key still answers it', async () => {
  // The completed paste goes to the composer (never a decision); the dialog stays fully answerable —
  // no lockout, and a deliberate y approves. Arm window bypassed so y is a decision immediately.
  process.env.SHADOW_DIALOG_ARM_MS = '0';
  const ws = mkdtempSync(join(tmpdir(), 'paste-then-answer-'));
  const registry = new ToolRegistry();
  registry.register(gatedProbe());
  const opts = baseOpts({ registry, workspaceRoot: ws, provider: toolThenDone({ id: 'w', name: 'write_probe', input: {} }) });
  const evts: LoopEvent['type'][] = [];
  opts.bus.on((e) => evts.push(e.type));
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => /Permission required/.test(strip(lastFrame() ?? ''))), 'the gate opened');
    await tick(40);
    // A complete one-chunk paste lands in the composer while the dialog is open.
    stdin.write('\x1b[200~pasted follow-up text\x1b[201~');
    await tick(80);
    assert.ok(strip(lastFrame() ?? '').includes('pasted follow-up text'), 'paste landed in the composer');
    assert.ok(!evts.includes('tool_start'), 'the paste did not approve');
    // The dialog is still answerable by a deliberate key — no lockout.
    stdin.write('y');
    assert.ok(await until(() => evts.includes('tool_start')), 'a deliberate y after the paste still approves');
    assert.ok(!evts.includes('tool_denied'), 'approved, not denied');
  } finally {
    delete process.env.SHADOW_DIALOG_ARM_MS;
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P1A-14 regression: a plain deliberate `y` still approves (paste hoist did not break decisions)', async () => {
  // Guard bypassed so `y` is a decision immediately (this file tests the paste hoist, not the arm window).
  process.env.SHADOW_DIALOG_ARM_MS = '0';
  const ws = mkdtempSync(join(tmpdir(), 'paste-approve-'));
  const registry = new ToolRegistry();
  registry.register(gatedProbe());
  const opts = baseOpts({ registry, workspaceRoot: ws, provider: toolThenDone({ id: 'w', name: 'write_probe', input: {} }) });
  const evts: LoopEvent['type'][] = [];
  opts.bus.on((e) => evts.push(e.type));
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => /Permission required/.test(strip(lastFrame() ?? ''))), 'the gate opened');
    await tick(60);
    stdin.write('y');
    assert.ok(await until(() => evts.includes('tool_start')), 'a deliberate y still approves');
    assert.ok(!evts.includes('tool_denied'), 'approved, not denied');
  } finally {
    delete process.env.SHADOW_DIALOG_ARM_MS;
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});
