import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { AutoApproveGate, AutoDenyGate } from '../src/agent/approval.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ok } from '../src/tools/types.js';

function fixture(overrides: Partial<LoopDeps> = {}, autonomy: 'manual' | 'full' = 'full') {
  let executions = 0; let requests = 0;
  const registry = new ToolRegistry();
  registry.register({ name: 'run_shell', risk: 'exec', description: 'Controlled fixture, executes no shell', inputSchema: z.object({ command: z.string() }),
    async run(input) { executions++; return ok('run_shell', 'exec', 1, (input as { command: string }).command, { exitCode: 0, marker: 'raw structured output' }); } });
  const deps: LoopDeps = { registry, bus: new EventBus(), gate: new AutoApproveGate(), signal: new AbortController().signal,
    budget: new Budget({ maxIterations: 0 }, 'mock', {}, Date.now()), context: new Context({ contextBudget: 10000, triggerRatio: .8, keepLastTurns: 3 }),
    provider: { name: 'fixture', estimateTokens: () => 1, async *send() { requests++; yield { type: 'done' as const, stopReason: 'end_turn' as const }; } },
    model: 'mock', system: 'fixture', workspaceRoot: process.cwd(), dryRun: false, maxOutputTokens: 256, maxToolResultChars: 8000, contextBudget: 10000, temperature: 0, ...overrides };
  return { loop: new AgentLoop(deps, autonomy), executed: () => executions, requests: () => requests };
}

test('explicit native action returns structured evidence without a provider round trip', async () => {
  const f = fixture();
  const result = await f.loop.runToolCall({ id: 'explicit-1', name: 'run_shell', input: { command: 'fixture' } });
  assert.equal(result.ok, true); assert.deepEqual(result.data, { exitCode: 0, marker: 'raw structured output' });
  assert.equal(f.executed(), 1); assert.equal(f.requests(), 0);
});

test('explicit native actions retain rules, catastrophic block, gate denial and cancellation', async () => {
  for (const [overrides, autonomy] of [
    [{ permissionRules: [{ tool: 'run_shell', action: 'deny' }] }, 'full'],
    [{ forceConfirm: () => 'fixture hard block' }, 'full'],
    [{ gate: new AutoDenyGate() }, 'manual'],
    [{ signal: AbortSignal.abort() }, 'full'],
  ] as [Partial<LoopDeps>, 'manual' | 'full'][]) {
    const f = fixture(overrides, autonomy);
    const result = await f.loop.runToolCall({ id: 'explicit-blocked', name: 'run_shell', input: { command: 'fixture' } });
    assert.equal(result.ok, false); assert.equal(f.executed(), 0); assert.equal(f.requests(), 0);
  }
});
