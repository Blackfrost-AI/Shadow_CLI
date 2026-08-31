import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import type { Tool, ToolContext, ToolResult } from '../src/tools/types.js';
import {
  AutoDenyGate,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
} from '../src/agent/approval.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import {
  Budget,
  createBudgetState,
  decideBudgetAction,
  budgetProgressMessage,
  budgetExceededDetail,
  BUDGET_CONTINUE_LABEL,
} from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';

// ── Pure state machine ───────────────────────────────────────────────────────

test('absent config → no guardrails: always ok, never decides against proceeding', () => {
  const s = createBudgetState({});
  assert.equal(s.active, false);
  for (let i = 0; i < 1000; i++) s.recordStep();
  s.recordCost(9999);
  assert.equal(s.status(), 'ok');
  assert.equal(decideBudgetAction(s, { interactive: true }), 'proceed');
  assert.equal(decideBudgetAction(s, { interactive: false }), 'proceed');
});

test('counts steps and accumulates cost', () => {
  const s = createBudgetState({ maxSteps: 100, maxCostUsd: 10 });
  s.recordStep();
  s.recordStep();
  s.recordStep();
  s.recordCost(0.5);
  s.recordCost(0.25);
  s.recordCost(-1); // non-positive increments are ignored
  const snap = s.snapshot();
  assert.equal(snap.steps, 3);
  assert.equal(snap.costUsd, 0.75);
  assert.equal(snap.maxSteps, 100);
  assert.equal(snap.maxCostUsd, 10);
  assert.equal(snap.warnRatio, 0.8);
  assert.equal(snap.warnings, 0);
  assert.equal(snap.continuations, 0);
});

test('warn fires exactly once at warnRatio (default 0.8)', () => {
  const s = createBudgetState({ maxSteps: 10 });
  for (let i = 0; i < 7; i++) s.recordStep();
  assert.equal(s.status(), 'ok');
  s.recordStep(); // step 8 of 10 = 80%
  assert.equal(s.status(), 'warned');
  assert.equal(decideBudgetAction(s, { interactive: true }), 'warn');
  // Second consult at the same crossing: already announced → proceed.
  assert.equal(s.status(), 'warned'); // still in the warn band…
  assert.equal(decideBudgetAction(s, { interactive: true }), 'proceed'); // …but no second warning
  assert.equal(s.snapshot().warnings, 1);
});

test('exceeded on either limit', () => {
  const steps = createBudgetState({ maxSteps: 3, maxCostUsd: 100 });
  steps.recordStep();
  steps.recordStep();
  assert.equal(steps.status(), 'ok');
  steps.recordStep();
  assert.equal(steps.status(), 'exceeded');

  const cost = createBudgetState({ maxCostUsd: 1 });
  cost.recordCost(0.75);
  assert.equal(cost.status(), 'ok');
  cost.recordCost(0.25);
  assert.equal(cost.status(), 'exceeded');
});

test('a single jump past warn lands in the right band (no double-fire)', () => {
  const s = createBudgetState({ maxSteps: 10, maxCostUsd: 10 });
  s.recordCost(8.5); // straight into the warn band
  assert.equal(s.status(), 'warned');
  assert.equal(decideBudgetAction(s, { interactive: true }), 'warn');
  s.recordCost(2); // crosses the cap
  assert.equal(s.status(), 'exceeded');
  assert.equal(s.snapshot().warnings, 1);
});

test('custom warnRatio', () => {
  const s = createBudgetState({ maxSteps: 4, warnRatio: 0.5 });
  s.recordStep();
  assert.equal(s.status(), 'ok');
  s.recordStep(); // 2/4 = 50%
  assert.equal(s.status(), 'warned');
});

test('decision: exceeded → ask when interactive, stop when not', () => {
  const a = createBudgetState({ maxSteps: 1 });
  a.recordStep();
  assert.equal(decideBudgetAction(a, { interactive: true }), 'ask');

  const h = createBudgetState({ maxSteps: 1 });
  h.recordStep();
  assert.equal(decideBudgetAction(h, { interactive: false }), 'stop');
});

test('continue-grant resets the window once (same limits again, warn re-armed)', () => {
  const s = createBudgetState({ maxSteps: 5 });
  for (let i = 0; i < 5; i++) s.recordStep();
  assert.equal(s.status(), 'exceeded');
  s.grantContinuation();
  assert.equal(s.snapshot().continuations, 1);
  assert.equal(s.status(), 'ok');
  assert.equal(s.snapshot().steps, 0);
  // The fresh window has the same limits and can warn + exceed again.
  for (let i = 0; i < 4; i++) s.recordStep();
  assert.equal(s.status(), 'warned'); // 4/5 ≥ 0.8
  assert.equal(decideBudgetAction(s, { interactive: true }), 'warn');
  s.recordStep();
  assert.equal(s.status(), 'exceeded');
  assert.equal(decideBudgetAction(s, { interactive: true }), 'ask');
});

test('full decision lifecycle: proceed → warn → proceed → ask → grant → … → stop', () => {
  const s = createBudgetState({ maxSteps: 2, warnRatio: 0.5 });
  assert.equal(decideBudgetAction(s, { interactive: true }), 'proceed');
  s.recordStep(); // 1/2 = warn band
  assert.equal(decideBudgetAction(s, { interactive: true }), 'warn');
  assert.equal(decideBudgetAction(s, { interactive: true }), 'proceed'); // warn-once
  s.recordStep(); // 2/2 = exceeded
  assert.equal(decideBudgetAction(s, { interactive: true }), 'ask');
  s.grantContinuation();
  assert.equal(decideBudgetAction(s, { interactive: true }), 'proceed');
  s.recordStep();
  assert.equal(decideBudgetAction(s, { interactive: true }), 'warn'); // re-armed in window 2
  s.recordStep();
  assert.equal(decideBudgetAction(s, { interactive: false }), 'stop'); // headless: clean stop
});

test('messages include only configured limits', () => {
  const both = createBudgetState({ maxSteps: 10, maxCostUsd: 1 }).snapshot();
  assert.equal(budgetProgressMessage({ ...both, steps: 8, costUsd: 0.8 }), 'Budget 80%: 8/10 steps · $0.80/$1.00');
  assert.equal(budgetExceededDetail({ ...both, steps: 10, costUsd: 1.2 }), '10/10 steps · $1.20/$1.00');

  const stepsOnly = createBudgetState({ maxSteps: 5 }).snapshot();
  assert.equal(budgetProgressMessage({ ...stepsOnly, steps: 4 }), 'Budget 80%: 4/5 steps');

  const costOnly = createBudgetState({ maxCostUsd: 2, warnRatio: 0.5 }).snapshot();
  assert.equal(budgetProgressMessage({ ...costOnly, costUsd: 1 }), 'Budget 50%: $1.00/$2.00');
});

// ── Loop wiring (integration-ish) ────────────────────────────────────────────

function makeNoopTool(): Tool {
  return {
    name: 'noop',
    description: 'does nothing',
    risk: 'read',
    inputSchema: z.object({}),
    async run(_input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      return { ok: true, summary: 'ok', meta: { tool: 'noop', durationMs: 0, risk: 'read' } };
    },
  };
}

function makeEventProvider(turns: ProviderEvent[][]): Provider & { calls(): number } {
  const queue = [...turns];
  let calls = 0;
  return {
    name: 'evented',
    async *send() {
      calls += 1;
      for (const ev of queue.shift() ?? [{ type: 'done', stopReason: 'end_turn' }]) yield ev;
    },
    estimateTokens() {
      return 1;
    },
    calls: () => calls,
  };
}

class RecordingGate implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];
  private i = 0;
  constructor(private readonly decisions: ApprovalDecision[]) {}
  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(req);
    return Promise.resolve(this.decisions[this.i++] ?? 'deny');
  }
}

let callSeq = 0;
const noopTurn = (): ProviderEvent[] => [
  { type: 'tool_call', call: { id: `c${++callSeq}`, name: 'noop', input: {} } },
  { type: 'done', stopReason: 'tool_use' },
];
const noopTurnWithUsage = (): ProviderEvent[] => [
  { type: 'tool_call', call: { id: `c${++callSeq}`, name: 'noop', input: {} } },
  { type: 'usage', inputTokens: 100, outputTokens: 100 },
  { type: 'done', stopReason: 'tool_use' },
];

function buildGuardLoop(opts: {
  provider: Provider;
  gate: ApprovalGate;
  spendGuard?: LoopDeps['spendGuard'];
  priceTable?: Record<string, { input: number; output: number }>;
}): { loop: AgentLoop; events: LoopEvent[] } {
  const registry = new ToolRegistry();
  registry.register(makeNoopTool());
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'work' }] });
  const deps: LoopDeps = {
    provider: opts.provider,
    registry,
    gate: opts.gate,
    bus,
    budget: new Budget({ maxIterations: 50 }, 'mock', opts.priceTable ?? { mock: { input: 1, output: 1 } }, Date.now()),
    context,
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: process.cwd(),
    dryRun: false,
    maxToolResultChars: 16_384,
    contextBudget: 1_000_000,
    spendGuard: opts.spendGuard,
  };
  return { loop: new AgentLoop(deps, 'full'), events };
}

type FindingEvent = Extract<LoopEvent, { type: 'finding' }>;
const findings = (events: LoopEvent[]): FindingEvent[] =>
  events.filter((e): e is FindingEvent => e.type === 'finding');

test('loop: warn-once, then deny at the gate ends the run gracefully (reason=budget)', async () => {
  const provider = makeEventProvider([noopTurn(), noopTurn(), noopTurn(), noopTurn(), noopTurn()]);
  const gate = new RecordingGate(['deny']);
  const { loop, events } = buildGuardLoop({ provider, gate, spendGuard: { maxSteps: 5 } });
  const result = await loop.run();

  assert.equal(result.stopReason, 'budget');
  assert.equal(provider.calls(), 5); // exactly 5 model calls, guard caught the 6th
  const warns = findings(events).filter((e) => e.type === 'finding' && e.severity === 'warn');
  assert.equal(warns.length, 2); // one threshold warning + the graceful-stop summary
  assert.match(warns[0]!.title, /^Budget 80%: 4\/5 steps$/);
  assert.match(warns[1]!.title, /^Budget exhausted — run stopped \(5\/5 steps\)$/);
  assert.equal(gate.requests.length, 1);
  assert.equal(gate.requests[0]!.kind, 'user_question');
  assert.match(gate.requests[0]!.questions![0]!.question, /Budget reached \(5\/5 steps\)\. Continue this task\?/);
});

test('loop: approving continue grants one more window, then the guard asks again', async () => {
  const provider = makeEventProvider([noopTurn(), noopTurn(), noopTurn(), noopTurn()]);
  const gate = new RecordingGate([
    { answers: [{ question: 'irrelevant', selected: [BUDGET_CONTINUE_LABEL] }] },
    'deny',
  ]);
  const { loop, events } = buildGuardLoop({ provider, gate, spendGuard: { maxSteps: 2, warnRatio: 0.5 } });
  const result = await loop.run();

  assert.equal(result.stopReason, 'budget');
  assert.equal(provider.calls(), 4); // 2 in window 1 + 2 in the granted window
  const warnFindings = findings(events).filter((e) => e.type === 'finding' && e.severity === 'warn' && /^Budget 50%/.test(e.title));
  assert.equal(warnFindings.length, 2); // warned once per window
  const extended = findings(events).filter((e) => e.type === 'finding' && /Budget extended/.test(e.title));
  assert.equal(extended.length, 1);
  assert.equal(gate.requests.length, 2); // re-asked when the second window ran out
});

test('loop: cost accrues from provider usage and trips the cost limit', async () => {
  const provider = makeEventProvider([noopTurnWithUsage(), noopTurnWithUsage(), noopTurnWithUsage()]);
  const gate = new RecordingGate(['deny']);
  const { loop, events } = buildGuardLoop({
    provider,
    gate,
    spendGuard: { maxCostUsd: 0.5, warnRatio: 0.75 },
    priceTable: { mock: { input: 1000, output: 1000 } }, // $0.20 per turn
  });
  const result = await loop.run();

  assert.equal(result.stopReason, 'budget');
  assert.equal(provider.calls(), 3);
  const warn = findings(events).find((e) => e.type === 'finding' && /^Budget 75%/.test(e.title));
  assert.ok(warn, 'expected the 75% cost warning');
  assert.equal(warn!.title, 'Budget 75%: $0.40/$0.50');
  const summary = findings(events).find((e) => e.type === 'finding' && /^Budget exhausted/.test(e.title));
  assert.match(summary!.title, /\$0\.60\/\$0\.50/);
});

test('loop: headless gate (AutoDenyGate) stops cleanly at the budget', async () => {
  const provider = makeEventProvider([noopTurn()]);
  const { loop, events } = buildGuardLoop({ provider, gate: new AutoDenyGate(), spendGuard: { maxSteps: 1 } });
  const result = await loop.run();

  assert.equal(result.stopReason, 'budget');
  assert.equal(provider.calls(), 1);
  assert.ok(findings(events).some((e) => e.type === 'finding' && /^Budget exhausted/.test(e.title)));
});

test('loop: no spend guard (or empty config) → unaffected run', async () => {
  const provider = makeEventProvider([
    [{ type: 'text', delta: 'done.' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const gate = new RecordingGate([]);
  const { loop, events } = buildGuardLoop({ provider, gate, spendGuard: {} });
  const result = await loop.run();

  assert.equal(result.stopReason, 'end_turn');
  assert.equal(findings(events).length, 0);
  assert.equal(gate.requests.length, 0);
});
