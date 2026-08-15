/**
 * /cost session accounting (P1B-03 / F02-01).
 *
 * The old readout showed only the LAST turn's usage but labeled it "(session)". These tests drive
 * the real TuiApp bus and assert: session tokens accumulate across usage events (delta math, no
 * double-count within a turn), sub-agent tokens accrue to the session total, and /clear resets it.
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

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');
async function until(pred: () => boolean, ms = 2500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await tick(40); }
  return pred();
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
    cfg,
    autonomy: 'manual',
    bypass: false,
    version: '0.0.0',
    ...over,
  };
}

async function runSlash(stdin: { write: (s: string) => void }, cmd: string): Promise<void> {
  stdin.write(cmd);
  await tick();
  stdin.write('\r');
  await tick(120);
}

test('/cost sums session tokens (delta-safe), accrues sub-agent tokens, and separates last-turn', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cost-'));
  const opts = baseOpts({ workspaceRoot: ws });
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    // Two cumulative usage events in the SAME turn — the second supersedes the first (delta math),
    // so the session must read 150/60, never 250/100.
    opts.bus.emit({ type: 'usage', inputTokens: 100, outputTokens: 40, costUSD: 0, contextPct: 0.1 });
    opts.bus.emit({ type: 'usage', inputTokens: 150, outputTokens: 60, costUSD: 0, contextPct: 0.1 });
    // A sub-agent's total spend accrues to the session too.
    opts.bus.emit({ type: 'subagent_usage', costUSD: 0, subagent: 'explore', taskId: 'a1', inputTokens: 200, outputTokens: 80 });
    await runSlash(stdin, '/cost');
    assert.ok(await until(() => /Session \(/.test(strip(lastFrame() ?? ''))), '/cost prints a session line');
    const f = strip(lastFrame() ?? '');
    // 150 + 200 = 350 in, 60 + 80 = 140 out.
    assert.match(f, /350 in/, 'session input tokens = last-turn delta + sub-agent (no double count)');
    assert.match(f, /140 out/, 'session output tokens summed');
    assert.match(f, /Last turn:/, 'a separate last-turn line is shown');
    assert.doesNotMatch(f, /\(session\)/, 'the old (session) mislabel on the per-turn line is gone');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('/clear resets the session usage readout', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'cost-clear-'));
  const opts = baseOpts({ workspaceRoot: ws });
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    opts.bus.emit({ type: 'usage', inputTokens: 500, outputTokens: 200, costUSD: 0, contextPct: 0.2 });
    await runSlash(stdin, '/clear');
    await runSlash(stdin, '/cost');
    assert.ok(await until(() => /No usage recorded/.test(strip(lastFrame() ?? ''))), '/cost after /clear reports no usage');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});
