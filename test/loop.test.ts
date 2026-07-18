import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ScriptedApprovalGate, AutoApproveGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import type { Tool } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';
import type { AutonomyLevel } from '../src/safety/permissions.js';

function buildLoop(
  provider: Provider,
  tools: Tool[],
  gate: { request: (...a: never[]) => Promise<never> } | import('../src/agent/approval.js').ApprovalGate,
  opts: { autonomy?: AutonomyLevel; maxIterations?: number; signal?: AbortSignal } = {},
): { loop: AgentLoop; events: LoopEvent[] } {
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
    gate: gate as import('../src/agent/approval.js').ApprovalGate,
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
  return { loop: new AgentLoop(deps, opts.autonomy ?? 'full'), events };
}

function echoTool(onRun: (msg: string) => void): Tool<{ msg: string }, { echoed: string }> {
  return {
    name: 'echo',
    description: 'echoes a message',
    risk: 'read',
    inputSchema: z.object({ msg: z.string() }),
    run: async (input) => {
      onRun(input.msg);
      return ok('echo', 'read', 1, `echoed: ${input.msg}`, { echoed: input.msg });
    },
  };
}

test('runs reason→act→observe and terminates with the final answer', async () => {
  let ranWith = '';
  const provider = new MockProvider([
    [
      { type: 'text', delta: 'Let me check. ' },
      { type: 'tool_call', call: { id: 't1', name: 'echo', input: { msg: 'hi' } } },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'Done.' },
      { type: 'usage', inputTokens: 12, outputTokens: 3 },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildLoop(provider, [echoTool((m) => (ranWith = m))], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(ranWith, 'hi', 'tool executed with the requested input');
  assert.equal(res.finalAnswer, 'Done.');
  assert.equal(res.stopReason, 'end_turn');
  const ended = events.find((e) => e.type === 'tool_end');
  assert.ok(ended && ended.type === 'tool_end' && ended.result.ok);
});

test('a denied tool returns a recoverable result and the loop still terminates', async () => {
  let ran = false;
  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 't1', name: 'echo', input: { msg: 'x' } } },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'ok, skipped.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildLoop(
    provider,
    [echoTool(() => (ran = true))],
    new ScriptedApprovalGate(['deny']),
    { autonomy: 'manual' },
  );
  const res = await loop.run();

  assert.equal(ran, false, 'denied tool must not run');
  assert.equal(res.finalAnswer, 'ok, skipped.');
  assert.ok(events.some((e) => e.type === 'tool_denied'));
});

test('hitting maxIterations stops with a partial-progress reason', async () => {
  // A provider that always asks for a tool → the loop only ends on the budget cap.
  const alwaysTool: Provider = {
    name: 'always',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      yield { type: 'tool_call', call: { id: 't', name: 'echo', input: { msg: 'loop' } } };
      yield { type: 'done', stopReason: 'tool_use' };
    },
  };
  const { loop } = buildLoop(alwaysTool, [echoTool(() => {})], new AutoApproveGate(), {
    maxIterations: 3,
  });
  const res = await loop.run();
  assert.equal(res.stopReason, 'max_iterations');
});

test('unknown tool name returns recoverable unknown_tool and the loop continues', async () => {
  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 'u1', name: 'nonexistent_gizmo', input: { probe: true } } },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'continuing after unknown tool.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildLoop(provider, [echoTool(() => {})], new AutoApproveGate());
  const res = await loop.run();

  const ended = events.find((e) => e.type === 'tool_end');
  assert.ok(ended && ended.type === 'tool_end');
  assert.equal(ended.result.ok, false);
  assert.equal(ended.result.error?.code, 'unknown_tool');
  assert.match(ended.result.summary, /unknown tool: nonexistent_gizmo/);
  assert.equal(ended.result.error?.recoverable, true);
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.finalAnswer, 'continuing after unknown tool.');
});

test('invalid tool input is returned to the model as a recoverable error (no crash)', async () => {
  let ran = false;
  const provider = new MockProvider([
    [
      // missing required `msg`
      { type: 'tool_call', call: { id: 't1', name: 'echo', input: { wrong: 1 } } },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'corrected.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildLoop(provider, [echoTool(() => (ran = true))], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(ran, false, 'tool with invalid input must not run');
  assert.equal(res.finalAnswer, 'corrected.');
  const ended = events.find((e) => e.type === 'tool_end');
  assert.ok(ended && ended.type === 'tool_end' && !ended.result.ok);
});

test('an unrepairable tool-call JSON is fed back and the model retries (no silent stop)', async () => {
  let ranWith = '';
  const provider = new MockProvider([
    // turn 0: the model tried to call a tool but the args were unrepairable JSON.
    [
      { type: 'error', recoverable: true, code: 'bad_tool_json', message: 'tool "echo" arguments were not valid JSON' },
      { type: 'done', stopReason: 'tool_use' },
    ],
    // turn 1: after the corrective feedback, a valid call.
    [
      { type: 'tool_call', call: { id: 't1', name: 'echo', input: { msg: 'recovered' } } },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'done.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildLoop(provider, [echoTool((m) => (ranWith = m))], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(ranWith, 'recovered', 'loop continued past the bad-JSON turn and ran the corrected call');
  assert.equal(res.stopReason, 'end_turn');
  assert.ok(events.some((e) => e.type === 'retry'), 'a retry event was emitted for the bad JSON');
});

test('a recoverable provider error is surfaced EXACTLY ONCE (regression: it printed twice)', async () => {
  // The double-print bug: the loop emitted a provider error at the stream-event site (case
  // 'error') AND again at turn cleanup (the `turn.providerError && !finalAnswer` branch), so the
  // HUD showed every provider error twice. The cleanup branch must STOP without re-emitting.
  const provider = new MockProvider([
    [
      { type: 'error', recoverable: true, code: 'http_400', message: 'max_tokens=16000 cannot be greater than max_model_len=8192' },
      { type: 'done', stopReason: 'end_turn' }, // empty turn → the providerError cleanup branch fires
    ],
  ]);
  const { loop, events } = buildLoop(provider, [], new AutoApproveGate());
  const res = await loop.run();

  const errs = events.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1, 'the provider error is emitted ONCE, not twice');
  assert.match((errs[0] as { message: string }).message, /http_400/, 'it is the provider error');
  assert.equal(res.stopReason, 'provider_error', 'the turn still stops with the provider_error reason');
});

test('repeated unrepairable tool JSON terminates (bounded repair attempts, no infinite loop)', async () => {
  const alwaysBad: Provider = {
    name: 'badjson',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      yield { type: 'error', recoverable: true, code: 'bad_tool_json', message: 'nope' };
      yield { type: 'done', stopReason: 'tool_use' };
    },
  };
  const { loop, events } = buildLoop(alwaysBad, [echoTool(() => {})], new AutoApproveGate(), {
    maxIterations: 25,
  });
  const res = await loop.run();
  const retries = events.filter((e) => e.type === 'retry').length;
  assert.equal(retries, 3, 'bounded to exactly 3 repair attempts');
  assert.equal(res.stopReason, 'fatal_tool_error', 'gives up cleanly after exhausting repairs');
});

test('loop guard: identical repeated calls stop executing after the limit', async () => {
  let ran = 0;
  const sameCall: Provider = {
    name: 'stuck',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      yield { type: 'tool_call', call: { id: 't', name: 'echo', input: { msg: 'same' } } };
      yield { type: 'done', stopReason: 'tool_use' };
    },
  };
  const { loop, events } = buildLoop(sameCall, [echoTool(() => (ran += 1))], new AutoApproveGate(), {
    maxIterations: 10,
  });
  const res = await loop.run();
  assert.equal(ran, 2, 'first two identical calls run; the 3rd+ are guarded, not executed');
  assert.ok(events.some((e) => e.type === 'tool_denied'), 'loop guard surfaces as tool_denied');
  assert.equal(res.stopReason, 'max_iterations', 'still terminates on the iteration cap');
});

test('recovers a tool call emitted ONLY in the thinking/reasoning stream (qwen-class strand)', async () => {
  // The "stops mid-thinking" bug: a thinking model (a local reasoning model / RED-APEX-class) emits the
  // Hermes/Qwen <tool_call> XML inside its REASONING stream, with no content and no native
  // tool call. The old recovery only sniffed turn.text, so the call was stranded.
  let ranWith = '';
  const provider = new MockProvider([
    [
      {
        type: 'thinking',
        delta:
          'Let me inspect.\n<tool_call><function=echo><parameter=msg>from-thinking</parameter></function></tool_call>',
      },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', stopReason: 'end_turn' },
    ],
    [
      { type: 'text', delta: 'Done.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildLoop(provider, [echoTool((m) => (ranWith = m))], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(ranWith, 'from-thinking', 'the call stranded in the reasoning stream was recovered and executed');
  assert.equal(res.finalAnswer, 'Done.');
  const ended = events.find((e) => e.type === 'tool_end');
  assert.ok(ended && ended.type === 'tool_end' && ended.result.ok);
  // The recovered span is stripped from the SURFACED reasoning, leaving the prose intact.
  const reasoning = events.find((e) => e.type === 'reasoning_done');
  assert.ok(reasoning && reasoning.type === 'reasoning_done');
  assert.equal(reasoning.text, 'Let me inspect.', 'recovered call stripped from surfaced reasoning; prose preserved');
});

test('recovers a clean TEXT tool call even when a separate native attempt was malformed (badJsonMsg set)', async () => {
  // The old `!turn.badJsonMsg` guard blocked text recovery whenever any native attempt was
  // malformed — stranding a perfectly clean text call. toolCalls.length===0 already prevents
  // double-executing a real native call, so the guard was over-broad.
  let ranWith = '';
  const provider = new MockProvider([
    [
      { type: 'text', delta: 'call:echo{"msg":"clean-text"}' },
      { type: 'error', recoverable: true, code: 'bad_tool_json', message: 'tool "echo" arguments were not valid JSON' },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'Done.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildLoop(provider, [echoTool((m) => (ranWith = m))], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(ranWith, 'clean-text', 'the clean text call was recovered despite the malformed native attempt');
  assert.equal(res.finalAnswer, 'Done.');
  assert.ok(events.some((e) => e.type === 'tool_end' && e.result.ok));
});

test('aborting mid-stream interrupts promptly (the mechanism behind ESC)', async () => {
  const controller = new AbortController();
  const slow: Provider = {
    name: 'slow',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      for (let i = 0; i < 500; i++) {
        yield { type: 'text', delta: 'x' };
        await new Promise((r) => setTimeout(r, 4));
      }
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const { loop, events } = buildLoop(slow, [], new AutoApproveGate(), {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 60);
  const res = await loop.run();

  const consumed = events.filter((e) => e.type === 'text').length;
  assert.equal(res.stopReason, 'interrupted', 'reports interrupted, not end_turn');
  assert.ok(consumed < 500, `stopped early — consumed ${consumed} of 500 stream deltas`);
});
