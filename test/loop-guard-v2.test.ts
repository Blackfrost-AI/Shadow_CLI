/**
 * Loop guard v2 — INTERLEAVED runaway detection (frosty-spark incident, 2026-11-07).
 *
 * The consecutive-identical guard (LOOP_GUARD_LIMIT) is evaded by interleaving: the incident
 * measured 27 identical failing verify commands interleaved with greps/edits — 455 auto-
 * continued turns in 34 minutes, stopped only by max_tokens. Guard v2 counts CUMULATIVE
 * failures per (tool, args) key across the run:
 *
 *   NUDGE (4): the 4th identical FAILING call is refused with an explicit redirect; the run
 *              continues (the model holds 3 full error transcripts in context).
 *   FATAL (8): attempts reaching 8 stop the run via the existing fatal_tool_error plumbing.
 *   success of that call clears its record; a genuine user steer clears all records.
 *
 * Env knob: SHADOW_LOOP_GUARD_MAX_FAILS sets both limits (tests, live diagnostics).
 */
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
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import type { Tool } from '../src/tools/types.js';
import { ok, fail } from '../src/tools/types.js';

function buildLoop(
  provider: Provider,
  tools: Tool[],
  opts: { maxIterations?: number } = {},
): { loop: AgentLoop; events: LoopEvent[] } {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const budget = new Budget(
    { maxIterations: opts.maxIterations ?? 40 },
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
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: process.cwd(),
    dryRun: false,
    maxToolResultChars: 16384,
    contextBudget: 1_000_000,
    sleep: async () => {},
  };
  return { loop: new AgentLoop(deps, 'full'), events };
}

/** A tool that ALWAYS FAILS with the same error and records each executed attempt. */
function failingTool(onRun?: (arg: string) => void): Tool<{ arg: string }, { never: string }> {
  return {
    name: 'doomed',
    description: 'always fails',
    risk: 'read',
    inputSchema: z.object({ arg: z.string() }),
    run: async (input) => {
      onRun?.(input.arg);
      return fail('doomed', 'read', 1, 'nonzero_exit', 'the script is corrupted: SyntaxError');
    },
  };
}

/** A benign tool so interleaving is possible (the evasion pattern from the incident). */
function benignTool(onRun?: (arg: string) => void): Tool<{ arg: string }, { ok: string }> {
  return {
    name: 'inspect',
    description: 'inspects state',
    risk: 'read',
    inputSchema: z.object({ arg: z.string() }),
    run: async (input) => {
      onRun?.(input.arg);
      return ok('inspect', 'read', 1, `inspected: ${input.arg}`, { ok: input.arg });
    },
  };
}

const doomedCall = (input: unknown) => ({
  type: 'tool_call' as const,
  call: { id: 'd', name: 'doomed', input: input as { arg: string } },
});
const inspectCall = (arg: string) => ({
  type: 'tool_call' as const,
  call: { id: 'i', name: 'inspect', input: { arg } },
});
const done = { type: 'done' as const, stopReason: 'tool_use' as const };
const finalAnswer = [{ type: 'text' as const, delta: 'gave up properly.' }, { type: 'done' as const, stopReason: 'end_turn' as const }];

// ─────────────────────────────────────────────────────────────────────────────────────

test('v2 nudge: 4th cumulative identical FAILURE is refused, run continues (interleaved evasion fails)', async () => {
  const executed: string[] = [];
  // Interleaved evasion from the incident: doomed(fail) → inspect → doomed(fail) → inspect…
  // The consecutive guard never trips (different calls between), but v2 counts cumulatively.
  const provider = new MockProvider([
    [doomedCall({ arg: 'attempt' }), done],
    [inspectCall('grep'), done],
    [doomedCall({ arg: 'attempt' }), done],
    [inspectCall('grep'), done],
    [doomedCall({ arg: 'attempt' }), done],
    [inspectCall('grep'), done],
    [doomedCall({ arg: 'attempt' }), done], // 4th cumulative failure → NUDGE refuses it
    finalAnswer,
  ]);
  const { loop, events } = buildLoop(provider, [
    failingTool((a) => executed.push(a)),
    benignTool(),
  ]);
  const res = await loop.run();

  assert.equal(executed.filter((a) => a === 'attempt').length, 3, 'attempts 1-3 execute; the 4th failing attempt is refused');
  const denials = events.filter((e) => e.type === 'tool_denied');
  assert.ok(denials.length >= 1, 'v2 refusal surfaces as tool_denied');
  assert.match(denials.at(-1)!.reason, /loop guard v2/, 'denial carries the v2 reason');
  assert.equal(res.stopReason, 'end_turn', 'the NUDGE does not stop the run');
  assert.equal(res.finalAnswer, 'gave up properly.');
});

test('v2 fatal: 8 cumulative attempts (ignored nudge) terminate the run with fatal_tool_error', async () => {
  const executed: string[] = [];
  // 3 executed failures → nudge denials on attempts 4..7 → the 8th attempt is FATAL.
  const provider = new MockProvider([
    [doomedCall({ arg: 'attempt' }), done], // 1 executed fail
    [inspectCall('x'), done],
    [doomedCall({ arg: 'attempt' }), done], // 2
    [inspectCall('x'), done],
    [doomedCall({ arg: 'attempt' }), done], // 3
    [inspectCall('x'), done],
    [doomedCall({ arg: 'attempt' }), done], // 4 → NUDGE (denied, not executed)
    [inspectCall('x'), done],
    [doomedCall({ arg: 'attempt' }), done], // 5 → nudge
    [inspectCall('x'), done],
    [doomedCall({ arg: 'attempt' }), done], // 6 → nudge
    [inspectCall('x'), done],
    [doomedCall({ arg: 'attempt' }), done], // 7 → nudge
    [inspectCall('x'), done],
    [doomedCall({ arg: 'attempt' }), done], // 8 → FATAL
  ]);
  const { loop, events } = buildLoop(provider, [
    failingTool((a) => executed.push(a)),
    benignTool(),
  ]);
  const res = await loop.run();

  assert.equal(executed.length, 3, 'executed failures stay at 3 — later attempts were refused');
  assert.equal(res.stopReason, 'fatal_tool_error', 'the ignored nudge ends the run via the existing fatal plumbing');
  assert.ok(events.some((e) => e.type === 'stop' && e.reason === 'fatal_tool_error'));
  const fatalDenial = events
    .filter((e) => e.type === 'tool_denied')
    .find((e) => /persisted after loop guard v2/.test(e.reason));
  assert.ok(fatalDenial, 'the fatal refusal names the persisted pattern');
});

test('v2 reset: a success of the same call clears its record', async () => {
  const executed: string[] = [];
  // Rhythm F F S (fail, fail, success) repeated twice, INTERLEAVED with inspect so the old
  // consecutive guard never fires (its domain). v2 counts: fail(1), fail(2) → success clears
  // the record before the nudge limit is reached; second cycle starts from zero. A workflow
  // that eventually succeeds through retries must never be denied.
  const flaky: Tool<{ arg: string }, { r: string }> = {
    name: 'flaky',
    description: 'fails twice, succeeds on the third attempt',
    risk: 'read',
    inputSchema: z.object({ arg: z.string() }),
    run: async (input) => {
      executed.push(input.arg);
      if (executed.length % 3 !== 0) return fail('flaky', 'read', 1, 'flaky_fail', 'nope');
      return ok('flaky', 'read', 1, 'finally', { r: 'yes' });
    },
  };
  const c = () => ({ type: 'tool_call' as const, call: { id: 'f', name: 'flaky', input: { arg: 'same' } } });
  const provider = new MockProvider([
    [c(), done], [inspectCall('i'), done], // fail 1
    [c(), done], [inspectCall('i'), done], // fail 2
    [c(), done], [inspectCall('i'), done], // success → record cleared
    [c(), done], [inspectCall('i'), done], // fail (fresh count)
    [c(), done], [inspectCall('i'), done], // fail
    [c(), done], [inspectCall('i'), done], // success → cleared again
    finalAnswer,
  ]);
  const { loop, events } = buildLoop(provider, [flaky, benignTool()]);
  const res = await loop.run();

  assert.equal(executed.filter((a) => a === 'same').length, 6, 'every flaky call executes — each success resets the record');
  assert.ok(!events.some((e) => e.type === 'tool_denied'), 'a fail×2→success rhythm never trips v2');
  assert.equal(res.stopReason, 'end_turn');
});

test('v2 isolation: different arguments do not pool into one record', async () => {
  const executed: string[] = [];
  // 8 DISTINCT failing commands (different args each time) — a long session's legitimate
  // heterogeneous failures must NOT pool into a fatal stop.
  const provider = new MockProvider([
    [doomedCall({ arg: 'a1' }), done],
    [doomedCall({ arg: 'a2' }), done],
    [doomedCall({ arg: 'a3' }), done],
    [doomedCall({ arg: 'a4' }), done],
    [doomedCall({ arg: 'a5' }), done],
    [doomedCall({ arg: 'a6' }), done],
    [doomedCall({ arg: 'a7' }), done],
    [doomedCall({ arg: 'a8' }), done],
    finalAnswer,
  ]);
  const { loop, events } = buildLoop(provider, [failingTool((a) => executed.push(a))]);
  const res = await loop.run();

  assert.equal(executed.length, 8, 'every distinct command executes — no pooling');
  assert.ok(!events.some((e) => e.type === 'tool_denied'), 'distinct failures never trip v2');
  assert.equal(res.stopReason, 'end_turn');
});

test('v2 steer reset: a genuine user steer clears all records; a bare ESC does not', async () => {
  // Proven pattern (loop.test.ts:1085): the provider yields a failing call, then HOLDS the
  // request open until abort; the steer is armed from outside; the loop tears the request
  // down and absorbs the steer at the boundary — the path that clears all v2 records.
  const executed: string[] = [];
  const c = () => ({ type: 'tool_call' as const, call: { id: 'd', name: 'doomed', input: { arg: 'attempt' } } });
  let steerArmed!: () => void;
  const armedGate = new Promise<void>((r) => (steerArmed = r));
  let sends = 0;
  let steerTextSeen = false;
  let postSteerCallYielded = false;
  const provider: Provider = {
    name: 'steer-clear',
    estimateTokens: () => 0,
    async *send(req): AsyncIterable<ProviderEvent> {
      sends += 1;
      if (sends <= 3) {
        // Sends 1-3: one failing call + one accepted other call per turn (interleaved, the
        // incident shape) — executes and drives the v2 record to fails=3 (nudge threshold).
        yield c();
        yield { type: 'tool_call', call: { id: 'i', name: 'inspect', input: { arg: 'x' } } };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      if (sends === 4) {
        // Yield an event first (the proven loop.test.ts pattern: the stream must be pumping
        // before the abort can be observed), then hold MID-STREAM with no done event: the
        // steer aborts this request and the boundary absorbs the steer text — clearing records.
        yield { type: 'text', delta: 'reconsidering' };
        steerArmed();
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) resolve();
          else req.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      // Send 5: the steered history is visible; the IDENTICAL call must EXECUTE — without
      // the boundary clear, attempts = 3 fails + 1 ≥ nudge would refuse it. Yield it EXACTLY
      // ONCE (a postSteerDone flag), or the replay loop drives the fresh record to fatal.
      steerTextSeen = JSON.stringify(req.messages ?? []).includes('new approach');
      if (!postSteerCallYielded) {
        postSteerCallYielded = true;
        yield c(); // the discriminating execution
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text', delta: 'changed approach.' };
      yield { type: 'done', stopReason: 'end_turn' };
      return;
    },
  };
  const failing = failingTool((a) => executed.push(a));
  const registry = new ToolRegistry();
  registry.register(failing);
  registry.register(benignTool()); // the interleaved 'inspect' call must be a REAL tool
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const budget = new Budget({ maxIterations: 40 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now());
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'do the thing' }] });
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
    contextBudget: 1_000_000,
    sleep: async () => {},
  };
  const loop = new AgentLoop(deps, 'full');
  const running = loop.run();
  await armedGate;
  assert.equal(loop.requestSteer('new approach: retry it once'), true, 'text steer accepted');
  const res = await running;

  assert.ok(sends >= 5, 'three failing turns + aborted request + fresh post-steer requests');
  assert.ok(events.some((e) => e.type === 'steer_applied'), 'the boundary steer was applied');
  assert.ok(steerTextSeen, 'the post-steer request saw the steered history');
  const preSteerFailures = 3;
  assert.ok(
    executed.filter((a) => a === 'attempt').length >= preSteerFailures + 1,
    `the identical call executed post-steer (${executed.filter((a) => a === 'attempt').length} total ≥ ${preSteerFailures + 1})`,
  );
  assert.ok(
    !events.some((e) => e.type === 'tool_denied' && /loop guard v2/.test(e.reason)),
    'no v2 refusal anywhere: at fails=3, post-steer attempts MUST have been refused unless the steer cleared the records',
  );
  assert.equal(res.stopReason, 'end_turn');

  // Part 2 — bare ESC (no text): no steer_applied, run stops as interrupted, nothing clears.
  let escSeen!: () => void;
  const escGate = new Promise<void>((r) => (escSeen = r));
  const provider2: Provider = {
    name: 'bare-esc',
    estimateTokens: () => 0,
    async *send(req): AsyncIterable<ProviderEvent> {
      yield { type: 'text', delta: 'working' };
      escSeen();
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) resolve();
        else req.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
  const bus2 = new EventBus();
  const events2: LoopEvent[] = [];
  bus2.on((e) => events2.push(e));
  const deps2: LoopDeps = { ...deps, provider: provider2, bus: bus2 };
  const loop2 = new AgentLoop(deps2, 'full');
  const running2 = loop2.run();
  await escGate;
  assert.equal(loop2.requestSteer(), false, 'bare ESC carries no text');
  const res2 = await running2;
  assert.equal(res2.stopReason, 'interrupted', 'bare ESC stops the run');
  assert.ok(!events2.some((e) => e.type === 'steer_applied'), 'no steer_applied — the clearing path never ran');
});

test('v2 parallel batch: identical failing siblings trip each other and terminate by the third batch', async () => {
  const executed: string[] = [];
  const failing: Tool<{ arg: string }, { never: string }> = {
    name: 'doomed',
    description: 'always fails',
    risk: 'read',
    inputSchema: z.object({ arg: z.string() }),
    run: async (input) => {
      executed.push(input.arg);
      return fail('doomed', 'read', 1, 'nonzero_exit', 'corrupted');
    },
  };
  // Batch shape: THREE identical failing calls in one turn (the parallel-batch path),
  // repeated across three turns. The v1 guard exempts identical siblings from each other;
  // v2 deliberately does NOT for failing calls — that is the incident shape.
  const batch = () => [
    { type: 'tool_call' as const, call: { id: 'b1', name: 'doomed', input: { arg: 'same' } } },
    { type: 'tool_call' as const, call: { id: 'b2', name: 'doomed', input: { arg: 'same' } } },
    { type: 'tool_call' as const, call: { id: 'b3', name: 'doomed', input: { arg: 'same' } } },
  ];
  const batchTurn = () => [...batch(), { type: 'done' as const, stopReason: 'tool_use' as const }];
  const provider = new MockProvider([
    // Batch 1: no record exists → all 3 siblings execute and fail (fails=3).
    batchTurn(),
    // Batch 2: attempts = 3 fails + 1 ≥ 4 → the whole batch is nudged (denied advances once,
    // as a uniform batch is ONE decision — the same philosophy as the v1 guard).
    batchTurn(),
    // Batches 3-5: each nudged (denied grows per batch). After enough batches the cumulative
    // attempts reach the fatal limit and the run stops via fatal_tool_error.
    batchTurn(),
    batchTurn(),
    batchTurn(),
    batchTurn(),
    // Terminal turn so a post-fatal provider consult still has a script.
    [{ type: 'text' as const, delta: 'done.' }, { type: 'done' as const, stopReason: 'end_turn' as const }],
  ]);
  const { loop, events } = buildLoop(provider, [failing]);
  const res = await loop.run();

  // Batch 1: all 3 pass their pre-checks (no record yet) → 3 executed failures recorded as one step.
  assert.equal(executed.length, 3, 'first batch executes all 3 siblings before any record exists');
  const denials = events.filter((e) => e.type === 'tool_denied' && /loop guard v2/.test(e.reason));
  assert.ok(denials.length >= 3, 'every subsequent batch is refused wholesale (fails=3 ≥ nudge limit)');
  assert.ok(
    events.some((e) => e.type === 'stop' && e.reason === 'fatal_tool_error'),
    'cumulative attempts reach the fatal limit and stop the run via the existing fatal plumbing',
  );
  assert.equal(res.stopReason, 'fatal_tool_error');
  assert.equal(executed.length, 3, 'no executed failure after the guard engaged');
});

test('v2 config: SHADOW_LOOP_GUARD_MAX_FAILS=0 turns off the nudge but keeps the fatal backstop', async () => {
  const prev = process.env.SHADOW_LOOP_GUARD_MAX_FAILS;
  process.env.SHADOW_LOOP_GUARD_MAX_FAILS = '0';
  try {
    const executed: string[] = [];
    // env=0 ⇒ nudge=0, fatal=max(0,8)=8. Reviewer blocker fix: the redirect stage is off,
    // but the incident's hard stop stays armed — one knob can never silently disarm it.
    const provider = new MockProvider([
      [doomedCall({ arg: 'attempt' }), done], // attempt 1 executes
      [inspectCall('i'), done],
      [doomedCall({ arg: 'attempt' }), done], // 2
      [inspectCall('i'), done],
      [doomedCall({ arg: 'attempt' }), done], // 3
      [inspectCall('i'), done],
      [doomedCall({ arg: 'attempt' }), done], // 4 — nudge OFF: executes (no redirect)
      [inspectCall('i'), done],
      [doomedCall({ arg: 'attempt' }), done], // 5
      [inspectCall('i'), done],
      [doomedCall({ arg: 'attempt' }), done], // 6
      [inspectCall('i'), done],
      [doomedCall({ arg: 'attempt' }), done], // 7
      [inspectCall('i'), done],
      [doomedCall({ arg: 'attempt' }), done], // 8 → attempts=8 ≥ fatal → FATAL stop
    ]);
    const { loop, events } = buildLoop(provider, [
      failingTool((a) => executed.push(a)),
      benignTool(),
    ]);
    const res = await loop.run();

    assert.equal(executed.length, 7, 'no nudge refusal: attempts 1-7 all execute');
    assert.ok(
      !events.some((e) => e.type === 'tool_denied' && /loop guard v2, \d+ failures/.test(e.reason)),
      'the nudge stage never fires',
    );
    assert.ok(
      events.some((e) => e.type === 'stop' && e.reason === 'fatal_tool_error'),
      'the fatal backstop still stops the run at attempts=8',
    );
    assert.equal(res.stopReason, 'fatal_tool_error');
  } finally {
    if (prev === undefined) delete process.env.SHADOW_LOOP_GUARD_MAX_FAILS;
    else process.env.SHADOW_LOOP_GUARD_MAX_FAILS = prev;
  }
});

test('v2 config: SHADOW_LOOP_GUARD_MAX_FAILS=2 nudges at the 2nd failure', async () => {
  const prev = process.env.SHADOW_LOOP_GUARD_MAX_FAILS;
  process.env.SHADOW_LOOP_GUARD_MAX_FAILS = '2';
  try {
    const executed: string[] = [];
    const provider = new MockProvider([
      [doomedCall({ arg: 'attempt' }), done], // fail 1 executed
      [doomedCall({ arg: 'attempt' }), done], // attempt 2 → NUDGE refusal
      finalAnswer,
    ]);
    const { loop, events } = buildLoop(provider, [failingTool((a) => executed.push(a))]);
    const res = await loop.run();

    assert.equal(executed.length, 1, 'only the first failure executes with limit 2');
    assert.ok(events.some((e) => e.type === 'tool_denied' && /loop guard v2/.test(e.reason)));
    assert.equal(res.stopReason, 'end_turn', 'nudge still does not stop the run');
  } finally {
    if (prev === undefined) delete process.env.SHADOW_LOOP_GUARD_MAX_FAILS;
    else process.env.SHADOW_LOOP_GUARD_MAX_FAILS = prev;
  }
});
