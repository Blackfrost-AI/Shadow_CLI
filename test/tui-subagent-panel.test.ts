/**
 * Sub-agent visibility (BUG 3 depth + F10-02), driven through the REAL TuiApp bus.
 *
 * The founder's #1 complaint: "my harness can call sub agents, but you never see those sub agents
 * or what they're doing." These tests assert the live panel shows each delegated agent's type,
 * current tool and counters, and — F10-02 — that a BACKGROUND agent stays visible after the
 * launching turn ends (it used to vanish the instant the parent turn completed).
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
  while (Date.now() < deadline) {
    if (pred()) return true;
    await tick(40);
  }
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

const call = (id: string, name: string, input: unknown) => ({ id, name, input } as never);

test('the panel shows a sub-agent type, its current tool, and a live tool-use count', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'subpanel-'));
  const opts = baseOpts({ workspaceRoot: ws });
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    opts.bus.emit({ type: 'subagent_start', taskId: 'a1', subagentType: 'explore', description: 'map the repo', background: false });
    opts.bus.emit({ type: 'tool_start', call: call('t1', 'read_file', { path: 'x.ts' }), risk: 'read', subagent: 'a1' });
    assert.ok(await until(() => /explore/.test(strip(lastFrame() ?? ''))), 'the sub-agent type shows in the panel');
    const f = strip(lastFrame() ?? '');
    assert.match(f, /read_file/, 'its current tool shows');
    assert.match(f, /1 tool/, 'the tool-use count shows');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('F10-02: a background sub-agent stays visible after the launching turn ends', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'subpanel-bg-'));
  const opts = baseOpts({ workspaceRoot: ws });
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    // A background agent is launched during a turn, then the parent turn ENDS (stop event).
    opts.bus.emit({ type: 'subagent_start', taskId: 'bg1', subagentType: 'reviewer', description: 'audit', background: true });
    opts.bus.emit({ type: 'tool_start', call: call('t1', 'grep', { pattern: 'TODO' }), risk: 'read', subagent: 'bg1' });
    assert.ok(await until(() => /reviewer/.test(strip(lastFrame() ?? ''))), 'the bg agent is visible during the turn');
    opts.bus.emit({ type: 'stop', reason: 'end_turn', finalAnswer: 'done' });
    await tick(120);
    // The bg agent must NOT vanish when the turn ends — this is the F10-02 regression.
    assert.match(strip(lastFrame() ?? ''), /reviewer/, 'the bg agent survives the turn end (F10-02)');
    // When it finishes, it lingers as Done (its result arrives later as a task-notification).
    opts.bus.emit({ type: 'subagent_usage', costUSD: 0.01, subagent: 'reviewer', taskId: 'bg1', inputTokens: 1200, outputTokens: 300 });
    opts.bus.emit({ type: 'subagent_end', taskId: 'bg1', ok: true, subagentType: 'reviewer' });
    assert.ok(await until(() => /Done/.test(strip(lastFrame() ?? ''))), 'a finished bg agent lingers as Done');
    assert.match(strip(lastFrame() ?? ''), /1\.5k tok|1\.[0-9]k tok/, 'its token scale shows');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a sync sub-agent is removed on completion (its answer commits as the tool result)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'subpanel-sync-'));
  const opts = baseOpts({ workspaceRoot: ws });
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    opts.bus.emit({ type: 'subagent_start', taskId: 's1', subagentType: 'explore', background: false });
    assert.ok(await until(() => /explore/.test(strip(lastFrame() ?? ''))), 'sync agent visible while running');
    opts.bus.emit({ type: 'subagent_end', taskId: 's1', ok: true, subagentType: 'explore' });
    assert.ok(await until(() => !/explore/.test(strip(lastFrame() ?? ''))), 'sync agent removed on end (no lingering row)');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});
