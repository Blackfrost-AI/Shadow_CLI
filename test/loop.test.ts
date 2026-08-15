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
  opts: {
    autonomy?: AutonomyLevel;
    maxIterations?: number;
    signal?: AbortSignal;
    parallelTools?: boolean;
    autoClassifier?: boolean;
    models?: LoopDeps['models'];
    fallbackModel?: string;
    resolveFallback?: LoopDeps['resolveFallback'];
    sleep?: LoopDeps['sleep'];
    model?: string;
    priorStopReason?: LoopDeps['priorStopReason'];
  } = {},
): { loop: AgentLoop; events: LoopEvent[]; context: Context; budget: Budget } {
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
    model: opts.model ?? 'mock',
    priorStopReason: opts.priorStopReason,
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: process.cwd(),
    dryRun: false,
    maxToolResultChars: 16384,
    contextBudget: 1_000_000,
    parallelTools: opts.parallelTools,
    autoClassifier: opts.autoClassifier,
    models: opts.models,
    fallbackModel: opts.fallbackModel,
    resolveFallback: opts.resolveFallback,
    // Tests must not depend on real timer delays; the retry event still carries the honest delayMs.
    sleep: opts.sleep ?? (async () => {}),
  };
  return { loop: new AgentLoop(deps, opts.autonomy ?? 'full'), events, context, budget };
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

test('a clean empty end_turn retries twice, charges every attempt, then accepts a real answer', async () => {
  let sends = 0;
  const provider: Provider = {
    name: 'empty-then-answer',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      sends += 1;
      yield { type: 'usage', inputTokens: 5, outputTokens: sends === 3 ? 2 : 0 };
      if (sends === 3) yield { type: 'text', delta: 'Recovered answer.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const { loop, events, budget } = buildLoop(provider, [], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(sends, 3, 'initial request plus two bounded retries');
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.finalAnswer, 'Recovered answer.');
  assert.deepEqual(
    events
      .filter((e) => e.type === 'retry')
      .map((e) => (e.type === 'retry' ? [e.attempt, e.reason] : null)),
    [
      [1, 'empty response'],
      [2, 'empty response'],
    ],
  );
  const spent = budget.snapshot(Date.now());
  assert.equal(spent.iterations, 3, 'empty responses consume the normal iteration budget');
  assert.equal(spent.inputTokens, 15, 'usage from every empty attempt is retained');
  assert.equal(spent.outputTokens, 2);
});

test('empty end_turn sends a corrective nudge once plus a bounded increasing backoff, then recovers', async () => {
  let sends = 0;
  const provider: Provider = {
    name: 'empty-nudge',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      sends += 1;
      yield { type: 'usage', inputTokens: 5, outputTokens: 0 };
      if (sends === 3) yield { type: 'text', delta: 'Recovered.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const { loop, events, context } = buildLoop(provider, [], new AutoApproveGate(), { sleep: async () => {} });
  const res = await loop.run();

  assert.equal(sends, 3);
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.finalAnswer, 'Recovered.');

  // The corrective nudge is appended to the user history EXACTLY once per recovery sequence,
  // and only after we actually retried — never leaked into the final accepted turn as noise.
  const nudges = context
    .messages()
    .filter((m) => m.role === 'user')
    .filter((m) =>
      Array.isArray(m.content) &&
      (m.content as Array<{ type: string; text?: string }>).some(
        (b) => b.type === 'text' && /previous response was empty/i.test(b.text ?? ''),
      ),
    );
  assert.equal(nudges.length, 1, 'exactly one corrective nudge per recovery sequence');

  // Bounded backoff is honestly reported on every retry and strictly increases.
  const retries = events.filter((e) => e.type === 'retry' && e.reason === 'empty response');
  assert.equal(retries.length, 2);
  const delays = retries.map((r) => (r.type === 'retry' ? r.delayMs : -1));
  assert.ok(delays.every((d) => d > 0), 'each retry reports a bounded non-zero backoff delay');
  assert.ok(delays[0]! < delays[1]!, 'backoff increases between consecutive attempts');
});

test('the corrective nudge resets between separate empty-response recovery sequences', async () => {
  let sends = 0;
  const provider: Provider = {
    name: 'empty-twice-recover-twice',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      sends += 1;
      yield { type: 'usage', inputTokens: 5, outputTokens: 0 };
      // Seq 1: sends 1,2 empty; send 3 recovers via a substantive tool call.
      if (sends === 3) {
        yield { type: 'tool_call', call: { id: 't1', name: 'echo', input: { msg: 'recover' } } };
      }
      // Seq 2: sends 4,5 empty; send 6 recovers with a final answer.
      if (sends === 6) yield { type: 'text', delta: 'Second answer.' };
      yield { type: 'done', stopReason: sends === 3 ? 'tool_use' : 'end_turn' };
    },
  };
  const { loop, context } = buildLoop(provider, [echoTool(() => {})], new AutoApproveGate(), {
    sleep: async () => {},
  });
  const res = await loop.run();

  assert.equal(sends, 6);
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.finalAnswer, 'Second answer.');
  const nudges = context
    .messages()
    .filter((m) => m.role === 'user')
    .filter((m) =>
      Array.isArray(m.content) &&
      (m.content as Array<{ type: string; text?: string }>).some(
        (b) => b.type === 'text' && /previous response was empty/i.test(b.text ?? ''),
      ),
    );
  assert.equal(nudges.length, 2, 'a fresh corrective nudge is sent for each recovery sequence');
});

test('provider reasoning wire state is attached only to a successfully committed assistant turn', async () => {
  const provider = new MockProvider([
    [
      { type: 'thinking', delta: 'private reasoning' },
      { type: 'reasoning_block', text: 'private reasoning', field: 'reasoning_content' },
      { type: 'text', delta: 'Visible answer.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, context } = buildLoop(provider, [], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(res.stopReason, 'end_turn');
  const assistant = context.messages().find((m) => m.role === 'assistant');
  assert.deepEqual(assistant?.providerReasoning, {
    text: 'private reasoning',
    field: 'reasoning_content',
    model: 'mock',
  });
});

test('three consecutive clean empty end_turn responses fail actionably without committing a blank turn', async () => {
  let sends = 0;
  const provider: Provider = {
    name: 'always-empty',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      sends += 1;
      yield { type: 'usage', inputTokens: 4, outputTokens: 0 };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const { loop, events, context, budget } = buildLoop(provider, [], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(sends, 3, 'empty-response recovery is bounded to three total requests');
  assert.equal(res.stopReason, 'provider_error');
  assert.equal(res.finalAnswer, '');
  assert.equal(events.filter((e) => e.type === 'retry' && e.reason === 'empty response').length, 2);
  const errors = events.filter((e) => e.type === 'error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.type === 'error');
  assert.match(errors[0].message, /empty response after 3 attempts/i);
  // P1A-08 honest diagnosis: the endpoint DID answer, so the old "check the model name and
  // endpoint" misdiagnosis is gone; an unknown non-reasoner gets the served-model-id steer.
  assert.match(errors[0].message, /model id matches what this server actually serves/i);
  assert.equal(context.messages().filter((m) => m.role === 'assistant').length, 0, 'blank assistant turns are not persisted');
  const spent = budget.snapshot(Date.now());
  assert.equal(spent.iterations, 3);
  assert.equal(spent.inputTokens, 12);
});

test('an empty max_tokens turn keeps max_tokens handling and is not retried as an empty response', async () => {
  let sends = 0;
  const provider: Provider = {
    name: 'empty-max-tokens',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      sends += 1;
      yield { type: 'done', stopReason: 'max_tokens' };
    },
  };
  const { loop, events } = buildLoop(provider, [], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(sends, 1);
  assert.equal(res.stopReason, 'max_tokens');
  assert.equal(events.some((e) => e.type === 'retry' && e.reason === 'empty response'), false);
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

test('a NON-recoverable provider error is surfaced EXACTLY ONCE and stops cleanly (regression: it used to throw + double-render)', async () => {
  // Before: the `case 'error'` handler emitted an `'error'` bus event AND threw for a
  // non-recoverable error. The bus event rendered it once; the throw escaped loop.run() into
  // runOne's catch (TUI) / the REPL catch (headless) and rendered the SAME message a SECOND
  // time, and crashed --task/--web runs that had no catch. Now the error is rendered ONLY by the
  // bus event; the loop run() RESOLVES with the provider_error stop reason.
  const provider = new MockProvider([
    [
      { type: 'error', recoverable: false, code: 'http_502', message: 'upstream blew up' },
      { type: 'done', stopReason: 'end_turn' }, // empty turn → providerError cleanup branch fires
    ],
  ]);
  const { loop, events } = buildLoop(provider, [], new AutoApproveGate());
  // Must RESOLVE, not reject — the whole point: a non-recoverable provider error must never throw.
  const res = await loop.run();

  const errs = events.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1, 'the provider error is emitted ONCE, not twice');
  assert.match((errs[0] as { message: string }).message, /http_502/, 'it is the provider error');
  assert.equal(res.stopReason, 'provider_error', 'stops cleanly with the provider_error reason');
});

test('a provider error after partial text preserves that text once and discards every tool call from the failed turn', async () => {
  let ran = 0;
  const provider = new MockProvider([
    [
      { type: 'text', delta: 'Partial answer.' },
      { type: 'reasoning_block', text: 'incomplete private reasoning', field: 'reasoning_content' },
      { type: 'tool_call', call: { id: 'unsafe-partial-call', name: 'echo', input: { msg: 'must not run' } } },
      { type: 'error', recoverable: false, code: 'http_502', message: 'stream failed after partial output' },
      { type: 'done', stopReason: 'tool_use' },
    ],
  ]);
  const { loop, events, context } = buildLoop(provider, [echoTool(() => (ran += 1))], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(res.stopReason, 'provider_error');
  assert.equal(res.finalAnswer, 'Partial answer.');
  assert.equal(ran, 0, 'a tool call from a failed stream must never execute');
  assert.equal(events.some((e) => e.type === 'tool_start'), false);
  assert.equal(
    events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.delta : '')).join(''),
    'Partial answer.',
    'stream events preserve the partial text exactly once',
  );
  assert.equal(
    events.filter((e) => e.type === 'assistant_done').length,
    0,
    'assistant_done is suppressed because the provider error already closed the streamed row',
  );
  const assistantTurns = context.messages().filter((m) => m.role === 'assistant');
  assert.equal(assistantTurns.length, 1, 'partial text is persisted as one assistant turn');
  assert.deepEqual(assistantTurns[0]?.content, [{ type: 'text', text: 'Partial answer.' }]);
  assert.equal(assistantTurns[0]?.interrupted, true, 'failed partial turns are explicitly marked interrupted');
  assert.equal(assistantTurns[0]?.providerReasoning, undefined, 'incomplete provider reasoning is never replayed');
  assert.equal(
    context.messages().some((m) => m.content.some((b) => b.type === 'tool_use')),
    false,
    'no tool_use from the incomplete provider turn reaches history',
  );
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

test('recoverable nameless_tool_call errors ride the corrective ladder, NOT a provider error (P1A-07)', async () => {
  // A stream that omits the function name is recoverable — the fix is a corrective resend, not a
  // poisoned turn. Repeated nameless calls must behave exactly like repeated bad JSON: bounded
  // repair retries, then a clean fatal_tool_error stop (never a silent provider_error stop).
  const alwaysNameless: Provider = {
    name: 'nameless',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      yield { type: 'error', recoverable: true, code: 'nameless_tool_call', message: 'tool call streamed without a name' };
      yield { type: 'done', stopReason: 'tool_use' };
    },
  };
  const { loop, events } = buildLoop(alwaysNameless, [echoTool(() => {})], new AutoApproveGate(), {
    maxIterations: 25,
  });
  const res = await loop.run();
  const retries = events.filter((e) => e.type === 'retry').length;
  assert.equal(retries, 3, 'nameless calls are bounded to exactly 3 repair attempts like bad JSON');
  assert.equal(res.stopReason, 'fatal_tool_error', 'terminates via the corrective ladder, not a provider error');
});

test('a nameless call prompts a corrective resend and the retry succeeds (P1A-07)', async () => {
  let ranWith = '';
  const provider = new MockProvider([
    [
      { type: 'error', recoverable: true, code: 'nameless_tool_call', message: 'tool call streamed without a name' },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'tool_call', call: { id: 't1', name: 'echo', input: { msg: 'retry' } } },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'Done.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events, context } = buildLoop(provider, [echoTool((m) => (ranWith = m))], new AutoApproveGate());
  const res = await loop.run();

  assert.equal(ranWith, 'retry', 'the corrective retry was executed after the nameless error');
  assert.equal(res.finalAnswer, 'Done.');
  assert.ok(events.some((e) => e.type === 'retry'), 'a corrective retry was scheduled');
  // The corrective nudge must be HONEST for a nameless call: it instructs re-sending WITH the
  // tool name, not the misleading "invalid JSON" phrasing used for malformed-args calls.
  const corrective = context
    .messages()
    .filter((m) => m.role === 'user')
    .map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))
    .find((t) => t.includes('tool name'));
  assert.ok(corrective, 'the corrective message surfaces the missing tool name to the model');
  assert.match(corrective as string, /WITH the tool name/, 'tells the model to re-send WITH a name');
});

test('mixed turn: one nameless error + two valid calls → both execute, the broken one is fed back (P1A-07 AC1)', async () => {
  const ran: string[] = [];
  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 't1', name: 'echo', input: { msg: 'first' } } },
      { type: 'error', recoverable: true, code: 'nameless_tool_call', message: 'tool call streamed without a name' },
      { type: 'tool_call', call: { id: 't2', name: 'echo', input: { msg: 'second' } } },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'Done.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events, context } = buildLoop(provider, [echoTool((m) => ran.push(m))], new AutoApproveGate());
  const res = await loop.run();

  assert.deepEqual(ran, ['first', 'second'], 'valid sibling calls executed despite the nameless one');
  assert.equal(res.finalAnswer, 'Done.');
  assert.equal(res.stopReason, 'end_turn', 'the turn continues — no provider_error poisoning');
  // The broken sibling is fed back in the SAME turn's results so the model can re-send it.
  const feedback = context
    .messages()
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .find((t) => t.includes('could not be run'));
  assert.ok(feedback, 'the mixed-turn note reaches the model');
  assert.match(feedback as string, /Re-send those calls correctly/);
  assert.equal(events.some((e) => e.type === 'stop' && e.reason === 'provider_error'), false);
});

test('empty×3 on a known reasoner names the output budget, not the endpoint (P1A-08)', async () => {
  const empty: Provider = {
    name: 'empty',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const { loop, events } = buildLoop(empty, [], new AutoApproveGate(), { model: 'deepseek-r1' });
  await loop.run();
  const err = events.find((e) => e.type === 'error' && /empty response after 3 attempts/i.test(e.message));
  assert.ok(err && err.type === 'error', 'terminal empty-response error emitted');
  assert.match(err.message, /output budget/i, 'reasoning models get the budget diagnosis');
  assert.match(err.message, /maxOutputTokens/, 'the concrete fix is named');
  assert.doesNotMatch(err.message, /model name/i, 'no wrong-endpoint misdiagnosis');
});

test('empty×3 right after a max_tokens stop names the budget even on an unknown model (P1A-08)', async () => {
  const empty: Provider = {
    name: 'empty',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const { loop, events } = buildLoop(empty, [], new AutoApproveGate(), {
    model: 'my-vllm-alias',
    priorStopReason: 'max_tokens',
  });
  await loop.run();
  const err = events.find((e) => e.type === 'error' && /empty response after 3 attempts/i.test(e.message));
  assert.ok(err && err.type === 'error');
  assert.match(err.message, /previous turn already stopped at the output-token cap/i);
  assert.match(err.message, /maxOutputTokens/);

  // Control: an unknown model with NO prior length stop keeps the endpoint-mismatch wording.
  const { loop: loop2, events: events2 } = buildLoop(empty, [], new AutoApproveGate(), { model: 'my-vllm-alias' });
  await loop2.run();
  const err2 = events2.find((e) => e.type === 'error' && /empty response after 3 attempts/i.test(e.message));
  assert.ok(err2 && err2.type === 'error');
  assert.match(err2.message, /model id matches what this server actually serves/i);
  assert.doesNotMatch(err2.message, /output budget/i);
});

test('the nameless-call retry HUD label is honest — not the JSON wording (P1A-07)', async () => {
  const provider = new MockProvider([
    [
      { type: 'error', recoverable: true, code: 'nameless_tool_call', message: 'tool call streamed without a name' },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'Done.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildLoop(provider, [echoTool(() => {})], new AutoApproveGate());
  await loop.run();
  const retry = events.find((e) => e.type === 'retry');
  assert.ok(retry && retry.type === 'retry');
  assert.equal(retry.reason, 'tool call missing its name');
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

test('loop guard: repeated identical unknown-tool calls stop the run and list the real tools', async () => {
  // F04-05: the unknown-tool early return used to skip the loop guard entirely, so a model
  // hallucinating the SAME unknown name spun all the way to maxIterations. Alternating names
  // is a changing signature, so the guard never trips and only the iteration cap bounds it.
  const cases: Array<{ names: string[]; stop: string; turns: number }> = [
    { names: ['ghost_gizmo'], stop: 'fatal_tool_error', turns: 3 }, // same name every turn → 3rd strike stops the run
    { names: ['ghost_a', 'ghost_b'], stop: 'max_iterations', turns: 4 }, // alternating names → cap, not the guard
  ];
  for (const c of cases) {
    let turn = 0;
    const hallucinator: Provider = {
      name: 'hallucinator',
      estimateTokens: () => 0,
      async *send(): AsyncIterable<ProviderEvent> {
        const name = c.names[turn % c.names.length];
        turn += 1;
        yield { type: 'tool_call', call: { id: `u${turn}`, name, input: { probe: true } } };
        yield { type: 'done', stopReason: 'tool_use' };
      },
    };
    const { loop, events } = buildLoop(hallucinator, [echoTool(() => {})], new AutoApproveGate(), {
      maxIterations: 4,
    });
    const res = await loop.run();
    assert.equal(res.stopReason, c.stop, `${c.names.join('/')}: expected stop reason ${c.stop}`);
    assert.equal(turn, c.turns, `${c.names.join('/')}: iteration count stayed small`);
    if (c.stop === 'fatal_tool_error') {
      assert.ok(
        events.some((e) => e.type === 'tool_denied' && /loop guard/.test(e.reason)),
        'the guard trip surfaces as tool_denied',
      );
      const ends = events.filter((e) => e.type === 'tool_end');
      const last = ends[ends.length - 1];
      assert.ok(last && last.type === 'tool_end' && !last.result.ok);
      assert.equal(last.result.error?.recoverable, false, 'the 3rd strike is non-recoverable');
      assert.match(last.result.error?.message ?? '', /Available tools: echo/, 'the stop result lists the registered tool names');
    }
  }
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

test('steering an in-flight model preserves text only and discards incomplete reasoning and tool intent', async () => {
  let ready!: () => void;
  const streamReady = new Promise<void>((resolve) => (ready = resolve));
  let ran = 0;
  const provider: Provider = {
    name: 'steer-partial',
    estimateTokens: () => 0,
    async *send(req): AsyncIterable<ProviderEvent> {
      yield { type: 'thinking', delta: 'private scratch' };
      yield { type: 'thinking_block', thinking: 'private scratch', signature: 'signed-but-incomplete' };
      yield { type: 'reasoning_block', text: 'provider-private', field: 'reasoning_content' };
      yield { type: 'text', delta: 'Useful partial.' };
      yield { type: 'tool_call', call: { id: 'unsafe', name: 'echo', input: { msg: 'do not run' } } };
      ready();
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) resolve();
        else req.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
  const { loop, events, context } = buildLoop(
    provider,
    [echoTool(() => (ran += 1))],
    new AutoApproveGate(),
  );

  const running = loop.run();
  await streamReady;
  loop.requestSteer();
  const res = await running;

  assert.equal(res.stopReason, 'interrupted');
  assert.equal(ran, 0, 'incomplete tool intent is never executed');
  assert.deepEqual(context.messages().filter((m) => m.role === 'assistant'), [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Useful partial.' }],
      interrupted: true,
    },
  ]);
  assert.equal(
    context.messages().some((m) => m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result')),
    false,
    'an incomplete native tool call leaves no protocol fragments in history',
  );
  assert.equal(events.some((e) => e.type === 'assistant_done'), false, 'partial stream is not closed as a complete answer');
  assert.equal(events.some((e) => e.type === 'reasoning_done'), false, 'incomplete private reasoning is not surfaced or replayed');
});

test('steering sanitizes a partial textual tool call instead of recovering or executing it', async () => {
  let ready!: () => void;
  const streamReady = new Promise<void>((resolve) => (ready = resolve));
  let ran = 0;
  const provider: Provider = {
    name: 'steer-text-tool',
    estimateTokens: () => 0,
    async *send(req): AsyncIterable<ProviderEvent> {
      yield { type: 'text', delta: 'I started checking.\n<tool_call>{"name":"echo","arguments":{"msg":"unsafe"}}' };
      ready();
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) resolve();
        else req.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
  const { loop, context } = buildLoop(provider, [echoTool(() => (ran += 1))], new AutoApproveGate());

  const running = loop.run();
  await streamReady;
  loop.requestSteer();
  await running;

  assert.equal(ran, 0);
  assert.deepEqual(context.messages().filter((m) => m.role === 'assistant'), [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'I started checking.' }],
      interrupted: true,
    },
  ]);
});

test('steering during a tool lets the active call settle, skips later calls, and stops before another model request', async () => {
  let sends = 0;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => (firstStarted = resolve));
  let firstFinished = false;
  let secondRan = false;
  const slowFirst: Tool<Record<string, never>, { done: boolean }> = {
    name: 'slow_first',
    description: 'finishes one already-started side effect',
    risk: 'read',
    inputSchema: z.object({}),
    async run() {
      firstStarted();
      await new Promise((resolve) => setTimeout(resolve, 80));
      firstFinished = true;
      return ok('slow_first', 'read', 80, 'first finished', { done: true });
    },
  };
  const second: Tool<Record<string, never>, { done: boolean }> = {
    name: 'second',
    description: 'must be skipped after steering',
    risk: 'read',
    inputSchema: z.object({}),
    async run() {
      secondRan = true;
      return ok('second', 'read', 1, 'second ran', { done: true });
    },
  };
  const provider: Provider = {
    name: 'tool-steer',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      sends += 1;
      yield { type: 'tool_call', call: { id: 'first', name: 'slow_first', input: {} } };
      yield { type: 'tool_call', call: { id: 'second', name: 'second', input: {} } };
      yield { type: 'done', stopReason: 'tool_use' };
    },
  };
  const hardAbort = new AbortController();
  const { loop, context } = buildLoop(provider, [slowFirst, second], new AutoApproveGate(), {
    signal: hardAbort.signal,
    parallelTools: false,
  });

  const running = loop.run();
  await started;
  loop.requestSteer();
  const res = await running;

  assert.equal(hardAbort.signal.aborted, false, 'steering does not hard-abort an active tool');
  assert.equal(firstFinished, true, 'the already-running call settles before the loop releases');
  assert.equal(secondRan, false, 'a not-yet-started serial call is skipped');
  assert.equal(sends, 1, 'no follow-up provider request starts before the pending user message');
  assert.equal(res.stopReason, 'interrupted');
  const results = context.messages().flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
  assert.equal(results.length, 2, 'every committed tool_use remains paired');
  assert.equal(results.find((b) => b.type === 'tool_result' && b.toolCallId === 'first')?.ok, true);
  const skipped = results.find((b) => b.type === 'tool_result' && b.toolCallId === 'second');
  assert.equal(skipped?.ok, false);
  if (skipped?.type === 'tool_result') assert.match(skipped.content, /new message/i);
});

test('steering an error-frame unwind suppresses fallback and remains an interrupt', async () => {
  let errorSeen!: () => void;
  const sawError = new Promise<void>((resolve) => (errorSeen = resolve));
  let sends = 0;
  let fallbackActivations = 0;
  const provider: Provider = {
    name: 'error-then-wait',
    estimateTokens: () => 0,
    async *send(req): AsyncIterable<ProviderEvent> {
      sends += 1;
      yield { type: 'error', recoverable: true, code: '529', message: 'provider overloaded' };
      errorSeen();
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) resolve();
        else req.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
  const { loop } = buildLoop(provider, [], new AutoApproveGate(), {
    models: [
      { label: 'primary', provider: 'mock', model: 'mock', fallback: 'backup' },
      { label: 'backup', provider: 'mock', model: 'backup' },
    ],
    fallbackModel: 'backup',
    resolveFallback: async () => {
      fallbackActivations += 1;
      return { provider, model: 'backup' };
    },
  });

  const running = loop.run();
  await sawError;
  loop.requestSteer();
  const result = await running;

  assert.equal(result.stopReason, 'interrupted');
  assert.equal(sends, 1, 'the obsolete turn never sends a fallback request');
  assert.equal(fallbackActivations, 0, 'fallback activation is skipped after steering');
});

test('steering during automatic compaction stops before the ordinary provider request', async () => {
  let compacting!: () => void;
  const compactStarted = new Promise<void>((resolve) => (compacting = resolve));
  let sends = 0;
  const provider: Provider = {
    name: 'must-not-send',
    estimateTokens: () => 0,
    async *send(): AsyncIterable<ProviderEvent> {
      sends += 1;
      yield { type: 'text', delta: 'stale' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const { loop, context } = buildLoop(provider, [], new AutoApproveGate());
  const before = structuredClone(context.messages());
  context.maybeSummarize = async (_provider, _model, _force, signal) => {
    compacting();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    return false;
  };

  const running = loop.run();
  await compactStarted;
  loop.requestSteer();
  const result = await running;

  assert.equal(result.stopReason, 'interrupted');
  assert.equal(sends, 0, 'no normal completion starts after the compaction abort');
  assert.deepEqual(context.messages(), before, 'the interrupted compaction leaves history atomic');
});

test('steering or hard abort during classifier work never starts the tool', async () => {
  for (const mode of ['steer', 'hard-abort'] as const) {
    let classifierEntered!: () => void;
    const classifierStarted = new Promise<void>((resolve) => (classifierEntered = resolve));
    let sends = 0;
    let toolRuns = 0;
    const provider: Provider = {
      name: `classifier-${mode}`,
      estimateTokens: () => 0,
      async *send(req): AsyncIterable<ProviderEvent> {
        sends += 1;
        if (sends === 1) {
          yield { type: 'tool_call', call: { id: 'classified', name: 'echo', input: { msg: mode } } };
          yield { type: 'done', stopReason: 'tool_use' };
          return;
        }
        classifierEntered();
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) resolve();
          else req.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        if (!req.signal?.aborted) {
          yield { type: 'text', delta: 'ALLOW | safe' };
          yield { type: 'done', stopReason: 'end_turn' };
        }
      },
    };
    const hardAbort = new AbortController();
    const { loop, context } = buildLoop(
      provider,
      [echoTool(() => (toolRuns += 1))],
      new AutoApproveGate(),
      { autoClassifier: true, signal: hardAbort.signal, parallelTools: false },
    );

    const running = loop.run();
    await classifierStarted;
    if (mode === 'steer') loop.requestSteer();
    else hardAbort.abort();
    const result = await running;

    assert.equal(result.stopReason, 'interrupted', mode);
    assert.equal(toolRuns, 0, `${mode}: tool.run was never invoked`);
    const paired = context.messages().flatMap((m) => m.content).find(
      (b) => b.type === 'tool_result' && b.toolCallId === 'classified',
    );
    assert.ok(paired && paired.type === 'tool_result' && !paired.ok, `${mode}: tool_use remains paired`);
  }
});
