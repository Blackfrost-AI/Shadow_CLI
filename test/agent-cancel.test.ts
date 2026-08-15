import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAgentTool } from '../src/tools/agentTool.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import type { LoopDeps } from '../src/agent/loop.js';
import type { ToolContext } from '../src/tools/types.js';

const PRICE = { mock: { input: 1, output: 1 } };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await tick(20); }
  return pred();
}

/** A provider whose turn blocks until the request signal aborts — models a long-running bg agent. */
const blockingProvider: Provider = {
  name: 'blocking',
  estimateTokens: () => 0,
  async *send(req): AsyncIterable<ProviderEvent> {
    await new Promise<void>((resolve, reject) => {
      if (req.signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
      const t = setTimeout(resolve, 30_000);
      req.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
    });
    yield { type: 'done', stopReason: 'end_turn' };
  },
};

test('F10-02: a background sub-agent can be cancelled via cancel_subagent (was uncancellable)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-cancel-'));
  try {
    const bus = new EventBus();
    const events: LoopEvent[] = [];
    bus.on((e) => events.push(e));
    const makeLoopDeps = (): LoopDeps => ({
      provider: blockingProvider,
      registry: new ToolRegistry(),
      gate: new ScriptedApprovalGate([], 'approve'),
      bus,
      budget: new Budget({ maxIterations: 2 }, 'mock', PRICE, Date.now()),
      context: new Context({ contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2 }),
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 256,
      workspaceRoot: ws,
      dryRun: false,
      maxToolResultChars: 1000,
      contextBudget: 100000,
    });
    const tool = makeAgentTool({ makeLoopDeps, getAutonomy: () => 'full', contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 2, priceTable: PRICE });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };

    const res = await tool.run({ prompt: 'long bg task', run_in_background: true } as any, ctx);
    assert.ok(res.ok);
    const taskId = (res.data as { taskId: string }).taskId;

    // The agent is now blocking. Confirm it started, then cancel it.
    assert.ok(await until(() => events.some((e) => e.type === 'subagent_start' && e.taskId === taskId)), 'bg agent started');
    bus.emit({ type: 'cancel_subagent', taskId });

    // Cancellation must end the agent (ok:false) rather than let it run to the 30s block.
    assert.ok(
      await until(() => events.some((e) => e.type === 'subagent_end' && e.taskId === taskId && e.ok === false)),
      'cancel_subagent aborted the bg agent (subagent_end ok:false)',
    );
    // And a task-notification is delivered so the parent context sees the outcome.
    assert.ok(events.some((e) => e.type === 'task_notification' && e.taskId === taskId), 'a task-notification was delivered');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('cancel with the * wildcard cancels a running background agent', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-cancel-all-'));
  try {
    const bus = new EventBus();
    const events: LoopEvent[] = [];
    bus.on((e) => events.push(e));
    const makeLoopDeps = (): LoopDeps => ({
      provider: blockingProvider,
      registry: new ToolRegistry(),
      gate: new ScriptedApprovalGate([], 'approve'),
      bus,
      budget: new Budget({ maxIterations: 2 }, 'mock', PRICE, Date.now()),
      context: new Context({ contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2 }),
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 256,
      workspaceRoot: ws,
      dryRun: false,
      maxToolResultChars: 1000,
      contextBudget: 100000,
    });
    const tool = makeAgentTool({ makeLoopDeps, getAutonomy: () => 'full', contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 2, priceTable: PRICE });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'x', run_in_background: true } as any, ctx);
    const taskId = (res.data as { taskId: string }).taskId;
    assert.ok(await until(() => events.some((e) => e.type === 'subagent_start')), 'started');
    bus.emit({ type: 'cancel_subagent', taskId: '*' });
    assert.ok(await until(() => events.some((e) => e.type === 'subagent_end' && e.taskId === taskId && e.ok === false)), 'wildcard cancelled the agent');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
