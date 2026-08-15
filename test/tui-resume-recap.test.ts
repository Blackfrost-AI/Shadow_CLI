/**
 * "While you were away" resume recap (F08-11): on /resume with cfg.resumeRecap enabled, Shadow asks
 * the CURRENT provider for a one-shot summary of the restored conversation and shows it boxed.
 * Opt-in; silent on error; never starts a real turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { loadConfig } from '../src/config.js';
import { SessionLog } from '../src/state/session.js';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');
async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await tick(40); }
  return pred();
}

/** Seed a resumable session (≥6 messages + a snapshot) under the workspace's sessions dir. */
function seedSession(ws: string): void {
  const log = SessionLog.open(ws);
  const ctx = new Context({ contextBudget: 100000, triggerRatio: 0.9, keepLastTurns: 4 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'Refactor the auth module' }] });
  for (let i = 0; i < 3; i++) {
    ctx.append({ role: 'assistant', content: [{ type: 'text', text: `did step ${i} of the auth refactor` }] });
    ctx.append({ role: 'user', content: [{ type: 'text', text: `now do step ${i + 1}` }] });
  }
  log.recordSnapshot(ctx, 0);
}

function recapProvider(text: string): Provider {
  return {
    name: 'recap',
    estimateTokens: () => 1,
    async *send(): AsyncIterable<ProviderEvent> {
      yield { type: 'text', delta: text };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
}

function baseOpts(ws: string, provider: TuiOpts['provider'], resumeRecap: boolean): TuiOpts {
  const cfg = loadConfig(ws, { provider: 'mock', model: 'm', resumeRecap });
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

test('resumeRecap ON: /resume shows a "while you were away" summary from the provider', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'recap-'));
  seedSession(ws);
  const opts = baseOpts(ws, recapProvider('- Refactoring auth\n- Next: finish step 3') as unknown as TuiOpts['provider'], true);
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('/resume');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => /Refactoring auth/.test(strip(lastFrame() ?? ''))), 'the provider summary appears');
    assert.match(strip(lastFrame() ?? ''), /While you were away/, 'under the recap header');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resumeRecap OFF (default): /resume shows no recap', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'recap-off-'));
  seedSession(ws);
  let called = false;
  const provider: Provider = { name: 'x', estimateTokens: () => 1, async *send() { called = true; yield { type: 'done', stopReason: 'end_turn' }; } };
  const opts = baseOpts(ws, provider as unknown as TuiOpts['provider'], false);
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('/resume');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => /Resumed/.test(strip(lastFrame() ?? ''))), 'the session resumed');
    await tick(150);
    assert.doesNotMatch(strip(lastFrame() ?? ''), /while you were away/i, 'no recap when disabled');
    assert.equal(called, false, 'the provider was not called for a recap');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});
