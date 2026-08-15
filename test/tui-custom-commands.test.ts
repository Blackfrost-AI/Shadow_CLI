/**
 * Custom slash commands (F10-07) end-to-end through the real TuiApp: a `.shadow/commands/*.md` file
 * shows in the slash menu and, on submit, expands its body (with $ARGUMENTS) into a turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { loadConfig } from '../src/config.js';
import { MockProvider } from '../src/provider/mock.js';

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');
async function until(pred: () => boolean, ms = 2500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await tick(40); }
  return pred();
}

function makeWs(): string {
  const ws = mkdtempSync(join(tmpdir(), 'cc-'));
  mkdirSync(join(ws, '.shadow/commands'), { recursive: true });
  writeFileSync(join(ws, '.shadow/commands/greet.md'), '---\ndescription: Draft a greeting\n---\nGreet $ARGUMENTS warmly.');
  return ws;
}

function baseOpts(ws: string, provider: TuiOpts['provider']): TuiOpts {
  const cfg = loadConfig(ws, { provider: 'mock', model: 'm' });
  return {
    provider,
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
    sessionLog: { record() {}, recordSnapshot() {}, path: undefined } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    cfg,
    autonomy: 'manual',
    bypass: false,
    version: '0.0.0',
    workspaceRoot: ws,
  };
}

test('a .shadow/commands/*.md file appears in the slash menu', async () => {
  const ws = makeWs();
  const opts = baseOpts(ws, {} as TuiOpts['provider']);
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('/gree');
    assert.ok(await until(() => /\/greet/.test(strip(lastFrame() ?? ''))), 'the custom command shows in the dropdown');
    assert.match(strip(lastFrame() ?? ''), /Draft a greeting/, 'its description shows');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('submitting a custom command expands its body (with $ARGUMENTS) into a turn', async () => {
  const ws = makeWs();
  // A mock provider that just ends the turn — we assert on the SUBMITTED user text.
  const provider = new MockProvider([[{ type: 'text', delta: 'ok' }, { type: 'done', stopReason: 'end_turn' }] as never]) as unknown as TuiOpts['provider'];
  const opts = baseOpts(ws, provider);
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('/greet Ada');
    await tick();
    stdin.write('\r');
    // The expanded body is submitted as the user turn — the ❯ line shows the substituted prompt,
    // NOT the literal "/greet …" command.
    assert.ok(await until(() => /Greet Ada warmly/.test(strip(lastFrame() ?? ''))), 'the expanded prompt was submitted as a turn');
    assert.doesNotMatch(strip(lastFrame() ?? ''), /Unknown command/, 'never treated as an unknown command');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a custom command cannot override a builtin (/clear stays the builtin)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cc-clash-'));
  mkdirSync(join(ws, '.shadow/commands'), { recursive: true });
  writeFileSync(join(ws, '.shadow/commands/clear.md'), 'THIS SHOULD NOT RUN as a prompt');
  const opts = baseOpts(ws, {} as TuiOpts['provider']);
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('/clear');
    await tick();
    stdin.write('\r');
    await tick(120);
    // The builtin /clear ran (conversation reset banner), not the custom prompt.
    assert.doesNotMatch(strip(lastFrame() ?? ''), /THIS SHOULD NOT RUN/, 'builtin wins — repo cannot hijack /clear');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});
