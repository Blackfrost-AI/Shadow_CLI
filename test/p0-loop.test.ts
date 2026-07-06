import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import type { Message, Provider, ProviderEvent } from '../src/provider/provider.js';
import type { Tool } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';
import type { AutonomyLevel } from '../src/safety/permissions.js';

function buildLoop(
  provider: Provider,
  tools: Tool[],
  opts: { autonomy?: AutonomyLevel; maxIterations?: number; signal?: AbortSignal } = {},
): { loop: AgentLoop; events: LoopEvent[]; context: Context } {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const budget = new Budget(
    { maxIterations: opts.maxIterations ?? 25 },
    'mock',
    { mock: { input: 1, output: 1 } },
    Date.now(),
  );
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'do the thing' }] });
  const deps: LoopDeps = {
    provider,
    registry,
    gate: new AutoApproveGate(),
    bus,
    budget,
    context,
    signal: opts.signal ?? new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: process.cwd(),
    dryRun: false,
    maxToolResultChars: 16384,
    contextBudget: 1_000_000,
  };
  return { loop: new AgentLoop(deps, opts.autonomy ?? 'full'), events, context };
}

/** A read-risk tool (no gating) that records the `msg` of every call it runs. */
function echoTool(onRun: (msg: string) => void): Tool<{ msg: string }, { echoed: string }> {
  return {
    name: 'echo', // a non-aliased name so the foreign adapter leaves it intact
    description: 'echoes a message',
    risk: 'read',
    inputSchema: z.object({ msg: z.string() }),
    run: async (input) => {
      onRun(input.msg);
      return ok('echo', 'read', 1, `echoed: ${input.msg}`, { echoed: input.msg });
    },
  };
}

/** Every committed tool_use must have a matching tool_result somewhere in history. */
function assertAllToolUsesPaired(messages: Message[]): void {
  const resultIds = new Set<string>();
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_result') resultIds.add(b.toolCallId);
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        assert.ok(resultIds.has(b.id), `tool_use ${b.id} has a matching tool_result`);
      }
    }
  }
}

// ---- P0-12: loop guard counts CONSECUTIVE, not cumulative, identical calls ----

test('P0-12 loop guard: an intervening different call resets the consecutive counter', async () => {
  const ran: string[] = [];
  // echo{a} → echo{b} → echo{a} → echo{b} → echo{a} → done. The echo{a} call repeats
  // three times but never back-to-back, so the loop guard must NOT trip. The old
  // cumulative counter tripped echo{a} on its third (non-consecutive) appearance,
  // which is exactly the edit→test→edit cycle this fix restores.
  const callA = { type: 'tool_call' as const, call: { id: 'a', name: 'echo', input: { msg: 'a' } } };
  const callB = { type: 'tool_call' as const, call: { id: 'b', name: 'echo', input: { msg: 'b' } } };
  const done = { type: 'done' as const, stopReason: 'tool_use' as const };
  const provider = new MockProvider([
    [callA, done],
    [callB, done],
    [callA, done],
    [callB, done],
    [callA, done],
    [{ type: 'text', delta: 'all green.' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const { loop, events } = buildLoop(provider, [echoTool((m) => ran.push(m))]);
  const res = await loop.run();

  assert.equal(ran.filter((m) => m === 'a').length, 3, 'all three non-consecutive echo{a} calls ran — guard did not trip');
  assert.equal(ran.filter((m) => m === 'b').length, 2);
  assert.equal(res.finalAnswer, 'all green.');
  assert.ok(!events.some((e) => e.type === 'tool_denied'), 'loop guard never fired on alternating calls');
});

test('P0-12 loop guard: still trips on three back-to-back identical calls', async () => {
  let ran = 0;
  const sameCall: Provider = {
    name: 'stuck',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      yield { type: 'tool_call', call: { id: 's', name: 'echo', input: { msg: 'same' } } };
      yield { type: 'done', stopReason: 'tool_use' };
    },
  };
  const { loop, events } = buildLoop(sameCall, [echoTool(() => (ran += 1))], { maxIterations: 10 });
  const res = await loop.run();

  assert.equal(ran, 2, 'first two consecutive identical calls run; the 3rd+ are guarded');
  assert.ok(events.some((e) => e.type === 'tool_denied'), 'loop guard surfaces as tool_denied');
  assert.equal(res.stopReason, 'max_iterations');
});

// ---- P0-11: an interrupted tool turn must leave every tool_use paired ----

test('P0-11 interrupt: a tool_use committed before ESC is paired with a synthetic tool_result', async () => {
  const controller = new AbortController();
  // The model streams a tool_use, then the user hits ESC (abort) before the tool runs.
  const provider: Provider = {
    name: 'abort-after-call',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      yield { type: 'tool_call', call: { id: 'k1', name: 'echo', input: { msg: 'hi' } } };
      controller.abort();
      yield { type: 'text', delta: 'ignored after abort' };
      yield { type: 'done', stopReason: 'tool_use' };
    },
  };
  let ran = 0;
  const { loop, context } = buildLoop(provider, [echoTool(() => (ran += 1))], {
    signal: controller.signal,
  });
  const res = await loop.run();

  assert.equal(res.stopReason, 'interrupted', 'reports interrupted');
  assert.equal(ran, 0, 'the tool never executed (interrupted first)');
  // The committed tool_use must not be left dangling — it would 400 every later request.
  assertAllToolUsesPaired(context.messages());
  const lastUser = [...context.messages()].reverse().find((m) => m.role === 'user');
  assert.ok(
    lastUser?.content.some((b) => b.type === 'tool_result' && b.toolCallId === 'k1' && b.ok === false),
    'a synthetic {ok:false} tool_result was appended for the orphaned tool_use',
  );
});

test('P0-11 defense-in-depth: a history ending in a dangling tool_use is healed before the next request', async () => {
  let seen: Message[] = [];
  const provider: Provider = {
    name: 'capture',
    estimateTokens: () => 0,
    async *send(req: { messages: Message[] }): AsyncIterable<ProviderEvent> {
      seen = req.messages;
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const { loop, context } = buildLoop(provider, [echoTool(() => {})]);
  // Simulate resuming from a corrupt snapshot: history ends on an assistant tool_use
  // with no matching tool_result.
  context.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'echo', input: { msg: 'x' } }] });
  await loop.run();

  assertAllToolUsesPaired(seen);
  const healed = seen.some(
    (m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result' && b.toolCallId === 'orphan'),
  );
  assert.ok(healed, 'the request sent to the provider paired the dangling tool_use');
});
