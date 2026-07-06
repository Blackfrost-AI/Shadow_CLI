import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { Budget } from '../src/agent/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import type { ProviderEvent } from '../src/provider/provider.js';
import { z } from 'zod';
import type { Tool } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';

test('approveForSession skips repeat permission prompt for same tool', async () => {
  const ws = process.cwd();
  const tool: Tool<{ n: number }, { v: number }> = {
    name: 'probe_session',
    description: 'probe',
    risk: 'write',
    inputSchema: z.object({ n: z.number() }),
    async run(i) {
      return ok('probe_session', 'write', 1, String(i.n), { v: i.n });
    },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  let asks = 0;
  const gate = new ScriptedApprovalGate([{ approveForSession: true }, 'approve']);
  const origRequest = gate.request.bind(gate);
  gate.request = async (req) => {
    asks++;
    return origRequest(req);
  };
  const provider = {
    name: 'p',
    estimateTokens: () => 1,
    async *send(): AsyncGenerator<ProviderEvent> {
      yield {
        type: 'tool_call',
        call: { id: '1', name: 'probe_session', input: { n: 1 } },
      };
      yield { type: 'done', stopReason: 'tool_use' };
      yield {
        type: 'tool_call',
        call: { id: '2', name: 'probe_session', input: { n: 2 } },
      };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  const deps: LoopDeps = {
    provider: provider as LoopDeps['provider'],
    registry,
    gate,
    bus: new EventBus(),
    budget: new Budget({ maxIterations: 4 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
    context,
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: ws,
    dryRun: false,
    maxToolResultChars: 16_384,
    contextBudget: 1_000_000,
    autonomy: 'manual',
  } as LoopDeps;
  await new AgentLoop(deps, 'manual').run();
  assert.equal(asks, 1, 'second identical-tool call should be session-approved');
});