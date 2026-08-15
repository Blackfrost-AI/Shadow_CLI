/**
 * P2-04 loop guardrails batch (v6.13.0) — one section per spec behavior:
 *
 *  A. F04-06 — the healer drops duplicate tool_results silently; the pin: it keeps LAST
 *              (not first) and the drop is surfaced (bus debug event + session log), once
 *              per assistant message.
 *  B. F04-07 — parallel turns: steer CAN stop not-yet-started calls (sequential admission,
 *              parallel execution); the loop-guard counter is frozen WITHIN a batch (identical
 *              siblings cannot trip it on each other), but the batch still counts as ONE step
 *              in the cross-turn guard — a stuck loop retrying in pairs cannot evade it.
 *  C. F04-09 — schedule_wakeup has a 30s minimum floor (raised requests report the
 *              effective delay) and a per-session fire-time rate ceiling.
 *  D. F04-10 — spending ceilings (tokens/cost/wall-clock) are enforced IN-CALL, not only
 *              between turns; the iteration cap still bounds provider turns only, so the
 *              final turn's tools are entitled to run.
 *  E. F04-11 — compaction failure is VISIBLE: a failed summarizer degrades to local
 *              truncation ('truncated') or reports 'failed' — never a silent false — and
 *              the loop surfaces a warning + session-log entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget, type BudgetLimits } from '../src/agent/budget.js';
import { Context, TRUNCATED_RESULT_SENTINEL } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import {
  estimateTokensFromMessages,
  type ContentBlock,
  type Message,
  type Provider,
  type ProviderEvent,
} from '../src/provider/provider.js';
import type { Tool, ToolContext } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';
import { SessionLog } from '../src/state/session.js';
import {
  WakeupScheduler,
  MIN_WAKEUP_DELAY_SEC,
  MAX_WAKEUPS_PER_WINDOW,
  WAKEUP_RATE_WINDOW_MS,
} from '../src/agent/wakeup.js';
import { makeScheduleWakeupTool } from '../src/tools/scheduleWakeup.js';

function buildGuardLoop(
  provider: Provider,
  tools: Tool[],
  opts: {
    parallelTools?: boolean;
    sleep?: (ms: number) => Promise<void>;
    budgetLimits?: BudgetLimits;
    context?: Context;
    sessionLog?: SessionLog;
    /** Injectable clock — Budget start and the loop's spending checks both read it. */
    now?: () => number;
  } = {},
): { loop: AgentLoop; events: LoopEvent[]; context: Context; budget: Budget } {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const budget = new Budget(
    opts.budgetLimits ?? { maxIterations: 25 },
    'mock',
    { mock: { input: 1, output: 1 } },
    opts.now ? opts.now() : Date.now(),
  );
  const context =
    opts.context ??
    new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6, microcompact: false });
  if (context.messages().length === 0) {
    context.pinTask({ role: 'user', content: [{ type: 'text', text: 'do the thing' }] });
  }
  const deps: LoopDeps = {
    provider,
    registry,
    gate: new AutoApproveGate(),
    bus,
    budget,
    context,
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: process.cwd(),
    dryRun: false,
    maxToolResultChars: 16384,
    contextBudget: context.budget(),
    parallelTools: opts.parallelTools,
    // No real timers in tests — admission ticks resolve instantly unless a test gates them.
    sleep: opts.sleep ?? (async () => {}),
    sessionLog: opts.sessionLog,
    now: opts.now,
  };
  return { loop: new AgentLoop(deps, 'full'), events, context, budget };
}

function echoTool(onRun?: (msg: string) => void): Tool<{ msg: string }, { echoed: string }> {
  return {
    name: 'echo',
    description: 'echoes a message',
    risk: 'read',
    inputSchema: z.object({ msg: z.string() }),
    run: async (input) => {
      onRun?.(input.msg);
      return ok('echo', 'read', 1, `echoed: ${input.msg}`, { echoed: input.msg });
    },
  };
}

function summarizeProvider(mode: 'throw' | 'empty' | 'ok'): Provider {
  return {
    name: 'summarizer-mock',
    estimateTokens: (m) => estimateTokensFromMessages(m),
    async *send(): AsyncIterable<ProviderEvent> {
      if (mode === 'throw') throw new Error('summarizer unavailable');
      if (mode === 'ok') yield { type: 'text', delta: 'TASK: do the thing\nALREADY DONE: step 1' };
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
}

const BIG = 'x'.repeat(2000);

function bigResultContext(): Context {
  const ctx = new Context({ contextBudget: 100, triggerRatio: 0.75, keepLastTurns: 1, microcompact: false });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'objective' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { msg: 'x' } }] });
  ctx.append({
    role: 'user',
    content: [{ type: 'tool_result', toolCallId: 't1', ok: true, content: BIG }],
  });
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// A. F04-06 — healer dup tool_result: last wins, drop is surfaced, once per message
// ─────────────────────────────────────────────────────────────────────────────────────

test('A1: healer keeps the LAST duplicate tool_result and reports the drop exactly once', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-lg-a1-'));
  const log = SessionLog.open(ws);
  const captured: Message[][] = [];
  const provider = new MockProvider([
    (messages) => {
      captured.push(messages);
      return [
        { type: 'tool_call', call: { id: 't2', name: 'echo', input: { msg: 'second' } } },
        { type: 'usage', inputTokens: 5, outputTokens: 2 },
        { type: 'done', stopReason: 'tool_use' },
      ];
    },
    (messages) => {
      captured.push(messages);
      return [
        { type: 'text', delta: 'Done.' },
        { type: 'usage', inputTokens: 5, outputTokens: 2 },
        { type: 'done', stopReason: 'end_turn' },
      ];
    },
  ]);
  const { loop, events, context } = buildGuardLoop(provider, [echoTool()], { sessionLog: log });
  // Seed history with a DUPLICATE tool_result for t1 — the retried call's outcome.
  context.append({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { msg: 'x' } }] });
  context.append({
    role: 'user',
    content: [
      { type: 'tool_result', toolCallId: 't1', ok: false, content: 'old stale body' },
      { type: 'tool_result', toolCallId: 't1', ok: true, content: 'new result body' },
    ],
  });

  const res = await loop.run();
  assert.equal(res.stopReason, 'end_turn');

  // Every request the healer built carries EXACTLY ONE result for t1 — and it is the LAST
  // duplicate ('new result body'), not the first.
  assert.ok(captured.length >= 2, 'two provider requests were built');
  for (const req of captured) {
    const t1Results = req
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result' && b.toolCallId === 't1');
    assert.equal(t1Results.length, 1, 'the duplicate was collapsed to a single result');
    assert.equal(t1Results[0]!.type === 'tool_result' && t1Results[0]!.content, 'new result body', 'LAST wins');
  }

  // The drop is surfaced — but only ONCE per assistant message, even though the healer runs
  // on every request build.
  const debugEvents = events.filter((e) => e.type === 'debug' && e.code === 'healer_dup_tool_result');
  assert.equal(debugEvents.length, 1, 'the dup drop is reported exactly once across both turns');
  assert.match(debugEvents[0]!.type === 'debug' ? debugEvents[0]!.message : '', /t1/);
  assert.match(debugEvents[0]!.type === 'debug' ? debugEvents[0]!.message : '', /last result wins/);

  // And persisted to the session log.
  const logBody = readFileSync(log.path, 'utf8');
  assert.ok(logBody.includes('healer_dup_tool_result'), 'the drop is durable, not chat-only');
  assert.ok(logBody.includes('last-wins'));
});

// ─────────────────────────────────────────────────────────────────────────────────────
// B. F04-07 — steer reaches not-yet-admitted parallel siblings; loop guard batch freeze
// ─────────────────────────────────────────────────────────────────────────────────────

test('B1: a steer mid-batch cancels the not-yet-started sibling (paired with the steer result)', async () => {
  const loopRef: { current?: AgentLoop } = {};
  let aRanResolve!: () => void;
  const aRan = new Promise<void>((r) => (aRanResolve = r));
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => (releaseGate = r));
  let zeroSleeps = 0;
  // Gate ONLY the admission ticks (sleep(0)): the first admission proceeds, every later one
  // blocks until the test releases it — by which time tool A has already requested the steer.
  const sleep = async (ms: number): Promise<void> => {
    if (ms > 0) return;
    zeroSleeps += 1;
    if (zeroSleeps >= 2) await gate;
  };
  const steerOnRun: Tool<{ msg: string }, { echoed: string }> = {
    name: 'echo',
    description: 'echoes a message',
    risk: 'read',
    inputSchema: z.object({ msg: z.string() }),
    run: async (input) => {
      loopRef.current!.requestSteer();
      aRanResolve();
      return ok('echo', 'read', 1, `echoed: ${input.msg}`, { echoed: input.msg });
    },
  };
  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 'a', name: 'echo', input: { msg: 'A' } } },
      { type: 'tool_call', call: { id: 'b', name: 'echo', input: { msg: 'B' } } },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'done', stopReason: 'tool_use' },
    ],
  ]);
  const built = buildGuardLoop(provider, [steerOnRun], { sleep });
  loopRef.current = built.loop;
  const { loop, events, context } = built;

  const runP = loop.run();
  await aRan; // tool A ran and the steer is now requested; sibling B is still un-admitted
  releaseGate(); // B's admission proceeds — and must see the steer
  const res = await runP;

  assert.equal(res.stopReason, 'interrupted');
  // A ran to completion; B never started — no tool_start / tool_end for it.
  const started = events.filter((e) => e.type === 'tool_start').map((e) => (e.type === 'tool_start' ? e.call.id : ''));
  const ended = events.filter((e) => e.type === 'tool_end').map((e) => (e.type === 'tool_end' ? e.call.id : ''));
  assert.deepEqual(started, ['a']);
  assert.deepEqual(ended, ['a']);
  // B is paired with the explicit steer result so the history never dangles.
  const last = context.messages()[context.messages().length - 1]!;
  const results = last.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
  assert.equal(results.length, 2);
  const bResult = results.find((r) => r.toolCallId === 'b')!;
  assert.equal(bResult.ok, false);
  assert.match(bResult.content, /before this call started/);
});

test('B2: three legitimately identical parallel calls all run (guard frozen per sibling)', async () => {
  let ran = 0;
  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 'c1', name: 'echo', input: { msg: 'same' } } },
      { type: 'tool_call', call: { id: 'c2', name: 'echo', input: { msg: 'same' } } },
      { type: 'tool_call', call: { id: 'c3', name: 'echo', input: { msg: 'same' } } },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'Done.' },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildGuardLoop(provider, [echoTool(() => (ran += 1))]);
  const res = await loop.run();

  assert.equal(res.stopReason, 'end_turn');
  assert.equal(ran, 3, 'identical siblings must not trip the guard on each other');
  assert.ok(!events.some((e) => e.type === 'tool_denied'), 'no loop-guard denial inside one batch');
});

test('B3: a parallel batch counts as ONE step in the cross-turn loop guard — never N, never zero', async () => {
  let ran = 0;
  const call = (id: string): ProviderEvent => ({
    type: 'tool_call',
    call: { id, name: 'echo', input: { msg: 'x' } },
  });
  const provider = new MockProvider([
    [call('s1'), { type: 'usage', inputTokens: 5, outputTokens: 2 }, { type: 'done', stopReason: 'tool_use' }],
    [
      call('p1'),
      call('p2'),
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [call('s2'), { type: 'usage', inputTokens: 5, outputTokens: 2 }, { type: 'done', stopReason: 'tool_use' }],
    [call('s3'), { type: 'usage', inputTokens: 5, outputTokens: 2 }, { type: 'done', stopReason: 'tool_use' }],
    [
      { type: 'text', delta: 'gave up' },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildGuardLoop(provider, [echoTool(() => (ran += 1))]);
  const res = await loop.run();

  // Turn 1 (single, repeats=1) runs. Turn 2's batch: each sibling sees the frozen pre-batch
  // count (repeats=2 < limit), so BOTH run — identical siblings never trip the guard on each
  // other — but the UNIFORM batch then advances the cross-turn counter by ONE (repeats=2).
  // Turn 3's single is the third consecutive repetition → denied; turn 4 denied again.
  // (The pre-fix restore handed the snapshot back, so pair-retrying evaded the guard forever.)
  assert.equal(ran, 3);
  const denied = events.filter((e) => e.type === 'tool_denied');
  assert.equal(denied.length, 2, 'turns 3 and 4 denied; never inside the batch itself');
  assert.deepEqual(
    denied.map((d) => (d.type === 'tool_denied' ? d.call.id : '')),
    ['s2', 's3'],
  );
  assert.match(denied[0]!.type === 'tool_denied' ? denied[0]!.reason : '', /repeated identical call/);
  assert.equal(res.stopReason, 'end_turn');
});

test('B4: a stuck loop that retries in identical pairs cannot evade the loop guard', async () => {
  let ran = 0;
  const turns: ProviderEvent[][] = [];
  for (let i = 0; i < 5; i++) {
    turns.push([
      { type: 'tool_call', call: { id: `a${i}`, name: 'echo', input: { msg: 'x' } } },
      { type: 'tool_call', call: { id: `b${i}`, name: 'echo', input: { msg: 'x' } } },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  }
  turns.push([
    { type: 'text', delta: 'gave up' },
    { type: 'usage', inputTokens: 5, outputTokens: 2 },
    { type: 'done', stopReason: 'end_turn' },
  ]);
  const { loop, events } = buildGuardLoop(new MockProvider(turns), [echoTool(() => (ran += 1))]);
  const res = await loop.run();

  // Uniform pairs: turn 1 → repeats 1, turn 2 → repeats 2 (both calls still run), turns 3-5 →
  // every sibling counts to ≥3 inside the frozen snapshot and is denied. Under the pre-fix
  // restore this exact pattern ran to the iteration cap with ZERO denials.
  assert.equal(ran, 4);
  const denied = events.filter((e) => e.type === 'tool_denied');
  assert.equal(denied.length, 6, 'three pair-turns × two denials');
  assert.equal(res.stopReason, 'end_turn');
});

// ─────────────────────────────────────────────────────────────────────────────────────
// C. F04-09 — wakeup minimum floor + fire-time rate ceiling
// ─────────────────────────────────────────────────────────────────────────────────────

test('C1: sub-minimum wakeups are raised to the 30s floor; longer delays pass through', () => {
  const t0 = 5_000_000;
  const s = new WakeupScheduler({ now: () => t0 });
  assert.equal(s.effectiveDelay(1), MIN_WAKEUP_DELAY_SEC);
  assert.equal(s.effectiveDelay(29), MIN_WAKEUP_DELAY_SEC);
  assert.equal(s.effectiveDelay(30), 30);
  assert.equal(s.effectiveDelay(31), 31);
  // Malformed model output must clamp to the floor, never produce a NaN/Infinity timer.
  assert.equal(s.effectiveDelay(Number.NaN), MIN_WAKEUP_DELAY_SEC);
  assert.equal(s.effectiveDelay(Number.POSITIVE_INFINITY), MIN_WAKEUP_DELAY_SEC);
  assert.equal(s.effectiveDelay(-5), MIN_WAKEUP_DELAY_SEC);
  const job = s.schedule(1, 'floor check', 'task', () => {});
  assert.equal(job.delaySec, MIN_WAKEUP_DELAY_SEC, 'the job carries the EFFECTIVE delay');
  assert.equal(job.at, t0 + MIN_WAKEUP_DELAY_SEC * 1000);
  s.clear(); // kill the real timer
});

test('C2: the rolling rate ceiling drops the 31st fire and reports it; the window recycles', () => {
  let clock = 1_000_000;
  const limited: string[] = [];
  const fired: string[] = [];
  const s = new WakeupScheduler({
    now: () => clock,
    onRateLimited: (job) => limited.push(job.task),
  });
  const jobs = [];
  for (let i = 0; i <= MAX_WAKEUPS_PER_WINDOW; i++) {
    jobs.push(s.schedule(MIN_WAKEUP_DELAY_SEC, `r${i}`, `task-${i}`, () => {}));
  }
  s.clear(); // real timers off — drive the fire decision directly

  for (let i = 0; i < MAX_WAKEUPS_PER_WINDOW; i++) {
    assert.equal(s.tryFire(jobs[i]!, (task) => fired.push(task)), true, `fire ${i + 1} passes`);
  }
  assert.equal(fired.length, MAX_WAKEUPS_PER_WINDOW);

  // The 31st fire inside the window is dropped — never executed — and reported.
  assert.equal(s.tryFire(jobs[MAX_WAKEUPS_PER_WINDOW]!, (task) => fired.push(task)), false);
  assert.equal(fired.length, MAX_WAKEUPS_PER_WINDOW, 'the dropped wakeup did not execute');
  assert.deepEqual(limited, ['task-30']);

  // Once the rolling window has passed, firing is allowed again.
  clock += WAKEUP_RATE_WINDOW_MS + 1;
  assert.equal(s.tryFire(jobs[0]!, (task) => fired.push(task)), true);
  assert.equal(fired.length, MAX_WAKEUPS_PER_WINDOW + 1);
});

test('C3: the tool reports the effective delay when a request is raised to the floor', async () => {
  const s = new WakeupScheduler({ now: () => 0 });
  const tool = makeScheduleWakeupTool(s, () => {});
  const ctx: ToolContext = { workspaceRoot: process.cwd(), signal: new AbortController().signal, log: () => {}, dryRun: false };
  const raised = await tool.run({ delay_seconds: 5, reason: 'quick poll', task: 'check the job' }, ctx);
  assert.ok(raised.ok);
  assert.match(raised.summary, /30s/);
  assert.match(raised.summary, /raised to the 30s minimum/);
  if (raised.data) s.cancel(raised.data.id);

  const normal = await tool.run({ delay_seconds: 60, reason: 'idle wait', task: 'check later' }, ctx);
  assert.ok(normal.ok);
  assert.match(normal.summary, /Wakeup scheduled in 60s/);
  assert.ok(!normal.summary.includes('raised'), 'an above-floor request is not annotated');
  if (normal.data) s.cancel(normal.data.id);
});

// ─────────────────────────────────────────────────────────────────────────────────────
// D. F04-10 — spending ceilings enforced in-call; iteration cap bounds turns only
// ─────────────────────────────────────────────────────────────────────────────────────

test('D1: Budget.checkSpending covers tokens/cost/wall-clock but NOT the iteration cap', () => {
  const t0 = 1_000;
  const cost = new Budget({ maxIterations: 5, maxCostUSD: 0.01 }, 'mock', { mock: { input: 1, output: 1 } }, t0);
  assert.equal(cost.checkSpending(t0), null);
  cost.recordUsage({ inputTokens: 20_000, outputTokens: 0 }, t0); // $0.02 > $0.01 ceiling
  assert.equal(cost.checkSpending(t0), 'budget');
  assert.equal(cost.check(t0), 'budget');

  const wall = new Budget({ maxIterations: 5, maxWallClockSec: 1 }, 'mock', {}, t0);
  assert.equal(wall.checkSpending(t0 + 500), null);
  assert.equal(wall.checkSpending(t0 + 1_500), 'budget');

  const iter = new Budget({ maxIterations: 1 }, 'mock', {}, t0);
  iter.tick();
  assert.equal(iter.check(t0), 'max_iterations');
  assert.equal(iter.checkSpending(t0), null, 'the iteration cap is NOT a spending stop — final-turn tools still run');
});

test('D2: a cost ceiling crossed mid-turn skips the whole SERIAL batch with an explicit reason', async () => {
  let ran = 0;
  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 'a', name: 'echo', input: { msg: 'A' } } },
      { type: 'tool_call', call: { id: 'b', name: 'echo', input: { msg: 'B' } } },
      // cost = (10 + 5) / 1e6 = 1.5e-5 > the 1e-6 ceiling — recorded DURING the stream,
      // i.e. before tool dispatch.
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', stopReason: 'tool_use' },
    ],
  ]);
  const { loop, events, context } = buildGuardLoop(provider, [echoTool(() => (ran += 1))], {
    parallelTools: false,
    budgetLimits: { maxIterations: 25, maxCostUSD: 0.000001 },
  });
  const res = await loop.run();

  assert.equal(res.stopReason, 'budget');
  assert.equal(ran, 0, 'no call is enlisted once the ceiling is crossed');
  assert.ok(!events.some((e) => e.type === 'tool_start' || e.type === 'tool_end'));
  const last = context.messages()[context.messages().length - 1]!;
  const results = last.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
  assert.equal(results.length, 2, 'every skipped call is paired with a synthetic result');
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.match(r.content, /session budget/, 'the model sees WHY the call did not run');
  }
});

test('D3: the iteration cap does not rob the final turn of its tools', async () => {
  let ran = 0;
  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 'a', name: 'echo', input: { msg: 'A' } } },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', stopReason: 'tool_use' },
    ],
  ]);
  const { loop, events } = buildGuardLoop(provider, [echoTool(() => (ran += 1))], {
    budgetLimits: { maxIterations: 1 },
  });
  const res = await loop.run();

  assert.equal(ran, 1, 'the final turn\'s tool still executes');
  const ended = events.find((e) => e.type === 'tool_end');
  assert.ok(ended && ended.type === 'tool_end' && ended.result.ok);
  assert.equal(res.stopReason, 'max_iterations');
});

test('D4: a cost ceiling crossed mid-turn skips PARALLEL siblings at admission', async () => {
  let ran = 0;
  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 'a', name: 'echo', input: { msg: 'A' } } },
      { type: 'tool_call', call: { id: 'b', name: 'echo', input: { msg: 'B' } } },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', stopReason: 'tool_use' },
    ],
  ]);
  const { loop, events, context } = buildGuardLoop(provider, [echoTool(() => (ran += 1))], {
    // parallelTools unset → parallel path
    budgetLimits: { maxIterations: 25, maxCostUSD: 0.000001 },
  });
  const res = await loop.run();

  assert.equal(res.stopReason, 'budget');
  assert.equal(ran, 0);
  assert.ok(!events.some((e) => e.type === 'tool_start' || e.type === 'tool_end'));
  const last = context.messages()[context.messages().length - 1]!;
  const results = last.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.match(r.content, /session budget/);
  }
});

test('D5: a serial batch that crosses the wall-clock ceiling MID-BATCH stops enlisting calls', async () => {
  // Pins the in-call check's reason to exist: the ceiling is crossed by the FIRST call's own
  // runtime, between dispatches — not before the turn starts (D2/D4 cover that side).
  let clock = 1_000_000;
  const ranMsgs: string[] = [];
  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 'w1', name: 'echo', input: { msg: 'a' } } },
      { type: 'tool_call', call: { id: 'w2', name: 'echo', input: { msg: 'b' } } },
      { type: 'tool_call', call: { id: 'w3', name: 'echo', input: { msg: 'c' } } },
      { type: 'usage', inputTokens: 5, outputTokens: 2 },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [{ type: 'text', delta: 'unreached' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const { loop, events, context } = buildGuardLoop(
    provider,
    [
      echoTool((msg) => {
        ranMsgs.push(msg);
        clock += 11_000; // each call burns 11s of the fake wall clock; the ceiling is 10s
      }),
    ],
    {
      parallelTools: false,
      now: () => clock,
      budgetLimits: { maxIterations: 25, maxWallClockSec: 10 },
    },
  );
  const res = await loop.run();

  assert.deepEqual(ranMsgs, ['a'], 'only the first call ran; the ceiling crossed mid-batch');
  assert.equal(res.stopReason, 'budget');
  const starts = events.filter((e) => e.type === 'tool_start');
  assert.equal(starts.length, 1, 'the skipped calls never started');
  const last = context.messages()[context.messages().length - 1]!;
  const results = last.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
  assert.equal(results.length, 3, 'every tool_use stays paired');
  assert.equal(results[0]!.ok, true);
  for (const r of results.slice(1)) {
    assert.equal(r.ok, false);
    assert.match(r.content, /session budget/);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// E. F04-11 — compaction failure is visible: degrade to local truncation, never silent
// ─────────────────────────────────────────────────────────────────────────────────────

test('E1: a throwing summarizer degrades to local truncation (oldest tool_result tombstoned)', async () => {
  const ctx = bigResultContext();
  const res = await ctx.maybeSummarize(summarizeProvider('throw'), 'mock', true);
  assert.equal(res, 'truncated');

  const msgs = ctx.messages();
  assert.equal(msgs.length, 3, 'structure is preserved — no message is dropped');
  const block = msgs[2]!.content[0]!;
  assert.equal(block.type, 'tool_result');
  if (block.type === 'tool_result') {
    assert.equal(block.content, TRUNCATED_RESULT_SENTINEL);
    assert.equal(block.toolCallId, 't1', 'pairing id survives the tombstone');
    assert.equal(block.ok, true, 'the ok flag survives the tombstone');
  }
});

test('E2: an EMPTY summary is a failure too and degrades to truncation', async () => {
  const ctx = bigResultContext();
  const res = await ctx.maybeSummarize(summarizeProvider('empty'), 'mock', true);
  assert.equal(res, 'truncated');
  const block = ctx.messages()[2]!.content[0]!;
  assert.equal(block.type === 'tool_result' && block.content, TRUNCATED_RESULT_SENTINEL);
});

test('E3: with nothing reclaimable left, the failure is reported as failed (not a silent no-op)', async () => {
  const ctx = new Context({ contextBudget: 100, triggerRatio: 0.75, keepLastTurns: 1, microcompact: false });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'objective' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: BIG }] });
  ctx.append({ role: 'user', content: [{ type: 'text', text: BIG }] });
  const res = await ctx.maybeSummarize(summarizeProvider('throw'), 'mock', true);
  assert.equal(res, 'failed', 'no tool_result bodies to drop → visible failure, not false');
});

test('E4: a healthy summarizer still returns summarized', async () => {
  const ctx = bigResultContext();
  const res = await ctx.maybeSummarize(summarizeProvider('ok'), 'mock', true);
  assert.equal(res, 'summarized');
  const progress = ctx.messages()[1]!.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  assert.match(progress, /TASK: do the thing/);
});

test('E5: a pre-aborted signal is a user action — compaction is a clean no-op', async () => {
  const ctx = bigResultContext();
  const ac = new AbortController();
  ac.abort();
  const res = await ctx.maybeSummarize(summarizeProvider('ok'), 'mock', true, ac.signal);
  assert.equal(res, false);
  const block = ctx.messages()[2]!.content[0]!;
  assert.equal(block.type === 'tool_result' && block.content, BIG, 'history untouched on abort');
});

test('E6: the loop surfaces degraded compaction — warn finding + session log + sentinel', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-lg-e6-'));
  const log = SessionLog.open(ws);
  let sends = 0;
  const provider: Provider = {
    name: 'degrade',
    estimateTokens: (m) => estimateTokensFromMessages(m),
    async *send(): AsyncIterable<ProviderEvent> {
      sends += 1;
      if (sends === 2) throw new Error('summarizer unavailable'); // the compaction round trip
      if (sends === 1) {
        yield { type: 'tool_call', call: { id: 't1', name: 'echo', input: { msg: 'x' } } };
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text', delta: 'Done despite degradation.' };
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const bigEcho: Tool<{ msg: string }, { echoed: string }> = {
    name: 'echo',
    description: 'echoes loudly',
    risk: 'read',
    inputSchema: z.object({ msg: z.string() }),
    run: async (input) => ok('echo', 'read', 1, 'X'.repeat(2000), { echoed: input.msg }),
  };
  const context = new Context({ contextBudget: 100, triggerRatio: 0.75, keepLastTurns: 1, microcompact: false });
  const { loop, events } = buildGuardLoop(provider, [bigEcho], { context, sessionLog: log });

  const res = await loop.run();
  assert.equal(res.stopReason, 'end_turn', 'degraded compaction does not kill the session');
  assert.equal(res.finalAnswer, 'Done despite degradation.');
  assert.equal(sends, 3, 'turn 1, failed summarizer attempt, turn 2');

  const warn = events.find((e) => e.type === 'finding' && e.severity === 'warn');
  assert.ok(warn, 'the degradation is surfaced as a visible warning');
  assert.equal(warn!.type === 'finding' && warn!.title, 'Compaction degraded — local truncation');
  assert.ok(events.some((e) => e.type === 'compaction'), 'the compaction event still fires on truncation');

  const logBody = readFileSync(log.path, 'utf8');
  assert.ok(logBody.includes('compaction_degraded'), 'the degradation is durable in the session log');

  const allBlocks = context.messages().flatMap((m) => m.content);
  assert.ok(
    allBlocks.some((b) => b.type === 'tool_result' && b.content === TRUNCATED_RESULT_SENTINEL),
    'the context carries the tombstone',
  );
});
