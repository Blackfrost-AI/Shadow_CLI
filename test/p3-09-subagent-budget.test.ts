/**
 * P3-09 (F04-08) — Sub-agent budget ceilings + accrual to the parent.
 *
 * Before this, a sub-agent's Budget had NO token/cost ceilings (only iterations + a 30-minute
 * wall-clock backstop) and its spend NEVER accrued to the parent's maxCostUSD / maxTotalTokens —
 * so a fleet of sub-agents could burn unbounded cost the parent's ceiling never saw. These tests
 * pin the fix:
 *   - Budget keeps sub-agent spend in separate accumulators so checkSpending() bounds OWN +
 *     rolled-up spend, while snapshot() (the source of per-turn `usage` events) stays OWN-only —
 *     the sub-agent's spend reaches /cost via its own `subagent_usage` event, never double-counted.
 *   - inheritableCeilings() reports the parent's REMAINING headroom (clamped at 0); a sub-agent
 *     inherits it at admission via applyInheritedCeilings() (never widens a ceiling).
 *   - the `agent` tool accrues the sub-agent's TOTAL spend back into the parent budget on every
 *     exit path, so the parent's spending checks see the whole delegation tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { AgentLoop } from '../src/agent/loop.js';
import type { LoopDeps } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { makeAgentTool } from '../src/tools/agentTool.js';
import { ok as okResult } from '../src/tools/types.js';
import type { ToolContext } from '../src/tools/types.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import { estimateTokensFromMessages } from '../src/provider/provider.js';
import type { CompletionRequest, Message, Provider, ProviderEvent } from '../src/provider/provider.js';
import { registerBuiltinTools } from '../src/tools/index.js';

// $1 per 1M tokens on both axes → cost = (in + out) / 1e6.
const PRICE = { mock: { input: 1, output: 1 } };
const t0 = Date.now();
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Accrued cost in whole micro-USD — sums of per-agent costs need rounding (float addition noise). */
const microUSD = (b: Budget) => Math.round(b.accruedSubagentCostUSD * 1e6);

function makeSubDeps(ws: string, provider: Provider, bus: EventBus): LoopDeps {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  return {
    provider,
    registry,
    gate: new ScriptedApprovalGate([], 'approve'),
    bus,
    budget: new Budget({ maxIterations: 5 }, 'mock', PRICE, t0),
    context: new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 256,
    workspaceRoot: ws,
    dryRun: false,
    maxToolResultChars: 16_000,
    contextBudget: 1_000_000,
  };
}

function makeTool(ws: string, provider: Provider, bus: EventBus, subagentConcurrency?: number) {
  return makeAgentTool({
    makeLoopDeps: () => makeSubDeps(ws, provider, bus),
    getAutonomy: () => 'full' as const,
    contextBudget: 1_000_000,
    triggerRatio: 0.75,
    keepLastTurns: 6,
    maxIterations: 5,
    priceTable: PRICE,
    subagentConcurrency,
  });
}

/** Real nested-delegation harness: the sub-loop registry carries the SAME `agent` tool (as in
 *  production — one shared session registry), and each launched loop consumes the next provider
 *  from a queue. Drives top → A → B through the REAL tool instead of hand-simulated accrual. */
function makeNestedHarness(ws: string, bus: EventBus, providers: Provider[], subagentConcurrency?: number) {
  const makeDeps = (): LoopDeps => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    registry.register(tool); // nested `agent` calls resolve back into this same tool
    return {
      ...makeSubDeps(ws, providers.shift()!, bus),
      registry,
    };
  };
  const tool = makeAgentTool({
    makeLoopDeps: makeDeps,
    getAutonomy: () => 'full' as const,
    contextBudget: 1_000_000,
    triggerRatio: 0.75,
    keepLastTurns: 6,
    maxIterations: 5,
    priceTable: PRICE,
    subagentConcurrency,
  });
  return tool;
}

/** A provider that blocks until `gate` resolves, recording each admission as it starts. */
function mkDeferred(gate: Promise<void>, admitted: string[], tag: string, spend: { input: number; output: number }): Provider {
  return {
    name: 'mock',
    async *send(): AsyncIterable<ProviderEvent> {
      admitted.push(tag);
      await gate;
      yield { type: 'usage', inputTokens: spend.input, outputTokens: spend.output };
      yield { type: 'text', delta: `${tag} done` };
      yield { type: 'done', stopReason: 'end_turn' };
    },
    estimateTokens: (messages: Message[]) => estimateTokensFromMessages(messages),
  };
}

// ── Budget unit behaviour ────────────────────────────────────────────────────────────────

test('checkSpending bounds OWN + rolled-up sub-agent spend (tokens and cost)', () => {
  const b = new Budget({ maxIterations: 10, maxTotalTokens: 100, maxCostUSD: 0.0001 }, 'mock', PRICE, t0);
  // Own spend alone is under both ceilings.
  b.recordUsage({ inputTokens: 40, outputTokens: 10 }, t0); // 50 tokens, 50/1e6 cost
  assert.equal(b.checkSpending(t0), null, 'own spend only is within ceilings');
  // Rolling up a sub-agent's 60 tokens pushes the total to 110 ≥ 100.
  b.accrueSubagent({ inputTokens: 60, outputTokens: 0, costUSD: 0 });
  assert.equal(b.checkSpending(t0), 'budget', 'own + sub-agent tokens now cross maxTotalTokens');

  const c = new Budget({ maxIterations: 10, maxCostUSD: 0.0001 }, 'mock', PRICE, t0);
  c.recordUsage({ inputTokens: 50, outputTokens: 0 }, t0); // 50/1e6
  assert.equal(c.checkSpending(t0), null);
  c.accrueSubagent({ costUSD: 60 / 1e6 });
  assert.equal(c.checkSpending(t0), 'budget', 'own + sub-agent cost now crosses maxCostUSD');
});

test('inheritableCeilings reports remaining headroom, clamps at zero, omits unconfigured axes', () => {
  const b = new Budget(
    { maxIterations: 10, maxTotalTokens: 1000, maxCostUSD: 0.001, maxWallClockSec: 600 },
    'mock',
    PRICE,
    t0,
  );
  b.recordUsage({ inputTokens: 300, outputTokens: 100 }, t0); // 400 tokens, 400/1e6 cost
  b.accrueSubagent({ inputTokens: 100, outputTokens: 0, costUSD: 100 / 1e6 });

  const c = b.inheritableCeilings(t0 + 100_000); // 100s elapsed
  assert.equal(c.maxTotalTokens, 1000 - (400 + 100), 'remaining tokens subtract own + sub spend');
  assert.equal(c.maxCostUSD, 0.001 - (400 / 1e6 + 100 / 1e6), 'remaining cost subtracts own + sub spend');
  assert.equal(c.maxWallClockSec, 600 - 100, 'remaining wall-clock subtracts elapsed');

  // Exhausted parent clamps at zero, never negative.
  const d = new Budget({ maxIterations: 1, maxCostUSD: 0.00001 }, 'mock', PRICE, t0);
  d.recordUsage({ inputTokens: 100, outputTokens: 0 }, t0); // 100/1e6 ≫ ceiling
  assert.equal(d.inheritableCeilings(t0).maxCostUSD, 0, 'exhausted parent yields a zero (not negative) ceiling');

  // An axis never configured inherits none.
  const e = new Budget({ maxIterations: 1 }, 'mock', PRICE, t0);
  const ec = e.inheritableCeilings(t0);
  assert.equal(ec.maxTotalTokens, undefined);
  assert.equal(ec.maxCostUSD, undefined);
  assert.equal(ec.maxWallClockSec, undefined);
});

test('applyInheritedCeilings adopts missing axes, takes the tighter of two, never widens', () => {
  const b = new Budget({ maxIterations: 10, maxCostUSD: 0.002, maxWallClockSec: 1800 }, 'mock', PRICE, t0);
  // Inherited: cost tighter, tokens new, wall-clock looser.
  b.applyInheritedCeilings({ maxCostUSD: 0.0005, maxTotalTokens: 500, maxWallClockSec: 9999 });
  const c = b.inheritableCeilings(t0);
  assert.equal(c.maxCostUSD, 0.0005, 'cost takes the tighter inherited value');
  assert.equal(c.maxTotalTokens, 500, 'a missing tokens axis is adopted');
  assert.equal(c.maxWallClockSec, 1800, 'wall-clock keeps its own tighter ceiling (never widens)');

  // Re-applying a looser cost must not widen it.
  b.applyInheritedCeilings({ maxCostUSD: 5 });
  assert.equal(b.inheritableCeilings(t0).maxCostUSD, 0.0005, 'a looser inherited ceiling cannot widen an existing one');
});

test('snapshot and currentCostUSD stay OWN-only after accrual (no /cost double-count)', () => {
  const b = new Budget({ maxIterations: 10, maxCostUSD: 1 }, 'mock', PRICE, t0);
  b.recordUsage({ inputTokens: 100, outputTokens: 50 }, t0); // own: 150/1e6
  b.accrueSubagent({ inputTokens: 500, outputTokens: 250, costUSD: 750 / 1e6 });

  const snap = b.snapshot(t0);
  assert.equal(snap.inputTokens, 100, 'snapshot reports own input only');
  assert.equal(snap.outputTokens, 50, 'snapshot reports own output only');
  assert.equal(snap.costUSD, 150 / 1e6, 'snapshot reports own cost only');
  assert.equal(b.currentCostUSD, 150 / 1e6, 'currentCostUSD is own-only');

  // …while the total getters expose own + sub for ceiling enforcement / upward accrual.
  assert.equal(b.totalInputTokens, 600);
  assert.equal(b.totalOutputTokens, 300);
  assert.equal(b.totalCostUSD, 900 / 1e6);
  assert.equal(b.accruedSubagentCostUSD, 750 / 1e6);
});

// ── loop seam: ctx.parentBudget ──────────────────────────────────────────────────────────

test('the loop stamps ctx.parentBudget with its own budget (immediate parent of any sub-agent)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-seam-'));
  try {
    let captured: Budget | undefined;
    let capturedRoot: Budget | undefined;
    const registry = new ToolRegistry();
    registry.register({
      name: 'capture_budget',
      description: 'captures ctx.parentBudget and ctx.rootBudget',
      risk: 'read',
      inputSchema: z.object({}),
      async run(_input: unknown, ctx: ToolContext) {
        captured = ctx.parentBudget;
        capturedRoot = ctx.rootBudget;
        return okResult('capture_budget', 'read', 0, 'captured');
      },
    });
    const budget = new Budget({ maxIterations: 5 }, 'mock', PRICE, t0);
    const provider = new MockProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'capture_budget', input: {} } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const deps: LoopDeps = {
      provider,
      registry,
      gate: new ScriptedApprovalGate([], 'approve'),
      bus: new EventBus(),
      budget,
      context: new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 256,
      workspaceRoot: ws,
      dryRun: false,
      maxToolResultChars: 16_000,
      contextBudget: 1_000_000,
    };
    await new AgentLoop(deps, 'full').run();
    assert.equal(captured, budget, 'ctx.parentBudget must be the running loop\'s own budget');
    assert.equal(
      capturedRoot,
      budget,
      'a top-level loop (no rootBudget in deps) must stamp its OWN budget as ctx.rootBudget',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── agent tool: inheritance + accrual ────────────────────────────────────────────────────

test('an exhausted parent yields a zero ceiling — the sub-agent stops BEFORE any provider call', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-exhaust-'));
  try {
    const bus = new EventBus();
    const usages: Array<{ costUSD: number }> = [];
    bus.on((e) => {
      if (e.type === 'subagent_usage') usages.push({ costUSD: e.costUSD });
    });
    // Parent with a cost ceiling it has already spent in full → remaining = 0.
    const parentBudget = new Budget({ maxIterations: 10, maxCostUSD: 0.00001 }, 'mock', PRICE, t0);
    parentBudget.recordUsage({ inputTokens: 10, outputTokens: 0 }, t0); // 10/1e6 == ceiling

    const provider = new MockProvider([
      [{ type: 'text', delta: 'should never run' }, { type: 'usage', inputTokens: 10, outputTokens: 5 }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeTool(ws, provider, bus);
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false, parentBudget };
    const res = await tool.run({ prompt: 'work' }, ctx);

    assert.ok(res.ok, 'a budget-stopped sub-agent still returns a clean tool result');
    assert.match(res.summary, /budget/, 'the summary must say the sub-agent hit its ceiling');
    assert.ok(!res.summary.includes('should never run'), 'the provider must NOT have been called');
    assert.equal(parentBudget.accruedSubagentCostUSD, 0, 'zero spend accrues');
    assert.equal(usages.length, 1, 'subagent_usage still reported once');
    assert.equal(usages[0]!.costUSD, 0, 'the reported spend is zero');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a sub-agent that runs normally accrues its spend into the parent budget', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-accrue-'));
  try {
    const bus = new EventBus();
    const usages: Array<{ costUSD: number; in?: number; out?: number }> = [];
    bus.on((e) => {
      if (e.type === 'subagent_usage') usages.push({ costUSD: e.costUSD, in: e.inputTokens, out: e.outputTokens });
    });
    const parentBudget = new Budget({ maxIterations: 10, maxCostUSD: 1, maxTotalTokens: 1_000_000 }, 'mock', PRICE, t0);

    const provider = new MockProvider([
      [{ type: 'text', delta: 'sub answer' }, { type: 'usage', inputTokens: 10, outputTokens: 5 }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeTool(ws, provider, bus);
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false, parentBudget };
    const res = await tool.run({ prompt: 'answer' }, ctx);

    assert.ok(res.ok);
    assert.match(res.summary, /sub answer/, 'the sub-agent answer is delivered');
    assert.equal(parentBudget.accruedSubagentInputTokens, 10, 'input tokens accrue to the parent');
    assert.equal(parentBudget.accruedSubagentOutputTokens, 5, 'output tokens accrue to the parent');
    assert.equal(parentBudget.accruedSubagentCostUSD, 15 / 1e6, 'cost accrues to the parent');
    assert.equal(parentBudget.totalCostUSD, 15 / 1e6, 'the parent total reflects the sub-agent');
    assert.equal(usages.length, 1, 'subagent_usage reported once');
    assert.equal(usages[0]!.costUSD, 15 / 1e6, 'the reported spend matches');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a sub-agent inherits the parent REMAINING cost ceiling, then its accrual trips the parent', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-inherit-'));
  try {
    const bus = new EventBus();
    // Parent leaves 20/1e6 of cost. Each sub provider call costs 15/1e6, so the sub-agent can
    // afford ONE call and must stop at its second budget check — it inherited the remainder.
    const parentBudget = new Budget({ maxIterations: 10, maxCostUSD: 20 / 1e6 }, 'mock', PRICE, t0);

    // Real read_file tool calls so the loop genuinely continues across iterations (the budget is
    // enforced BETWEEN provider calls and in-call, so the agent spends one call past its remainder
    // before the check trips).
    writeFileSync(join(ws, 'a.ts'), 'export const x = 1;\n');
    const provider = new MockProvider([
      [
        { type: 'tool_call', call: { id: 'r1', name: 'read_file', input: { path: 'a.ts' } } },
        { type: 'usage', inputTokens: 10, outputTokens: 5 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'tool_call', call: { id: 'r2', name: 'read_file', input: { path: 'a.ts' } } },
        { type: 'usage', inputTokens: 10, outputTokens: 5 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'usage', inputTokens: 10, outputTokens: 5 }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeTool(ws, provider, bus);
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false, parentBudget };
    const res = await tool.run({ prompt: 'burn' }, ctx);

    assert.ok(res.ok);
    assert.match(res.summary, /budget/, 'the sub-agent reports it hit its (inherited) ceiling');
    // Two calls spent (30/1e6) before the check tripped — slightly past the inherited 20/1e6,
    // which is expected: the ceiling is enforced BETWEEN provider calls.
    assert.equal(parentBudget.accruedSubagentCostUSD, 30 / 1e6, 'the actual spend accrues');
    assert.equal(parentBudget.checkSpending(t0), 'budget', 'the parent now sees the sub-agent spend against its ceiling');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a background sub-agent also accrues its spend into the parent budget', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-bg-'));
  try {
    const bus = new EventBus();
    const parentBudget = new Budget({ maxIterations: 10, maxCostUSD: 1 }, 'mock', PRICE, t0);
    const provider = new MockProvider([
      [{ type: 'text', delta: 'bg done' }, { type: 'usage', inputTokens: 7, outputTokens: 3 }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeTool(ws, provider, bus);
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false, parentBudget };
    const res = await tool.run({ prompt: 'bg', run_in_background: true }, ctx);
    assert.ok(res.ok);
    // Let the fire-and-forget promise settle (the mock is synchronous-fast).
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(parentBudget.accruedSubagentCostUSD, 10 / 1e6, 'bg sub-agent cost accrues to the parent');
    assert.equal(parentBudget.accruedSubagentInputTokens, 7, 'bg input tokens accrue');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── chained delegation: each level counted exactly once ──────────────────────────────────

test('nested accrual rolls each level up exactly once (no double-count up the tree)', () => {
  const top = new Budget({ maxIterations: 10, maxCostUSD: 1 }, 'mock', PRICE, t0);
  const a = new Budget({ maxIterations: 5, maxCostUSD: 0.5 }, 'mock', PRICE, t0);
  const b = new Budget({ maxIterations: 5, maxCostUSD: 0.25 }, 'mock', PRICE, t0);

  b.recordUsage({ inputTokens: 100, outputTokens: 50 }, t0); // B own: 150/1e6
  a.recordUsage({ inputTokens: 200, outputTokens: 100 }, t0); // A own: 300/1e6

  // B finishes → rolls into A. A finishes → rolls its TOTAL (own + B) into top.
  a.accrueSubagent({ inputTokens: b.totalInputTokens, outputTokens: b.totalOutputTokens, costUSD: b.totalCostUSD });
  top.accrueSubagent({ inputTokens: a.totalInputTokens, outputTokens: a.totalOutputTokens, costUSD: a.totalCostUSD });

  assert.equal(a.accruedSubagentCostUSD, 150 / 1e6, 'A sees B');
  assert.equal(top.accruedSubagentCostUSD, (300 + 150) / 1e6, 'top sees A+B exactly once');
  assert.equal(top.totalCostUSD, (300 + 150) / 1e6, 'top total = A own + B own, B not double-counted');
});

// ── real nested delegation through the tool (end-to-end) ─────────────────────────────────

test('nested delegation (real tool): the TREE total accrues to the top budget, not own-only', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-nested-sync-'));
  try {
    const bus = new EventBus();
    const parentBudget = new Budget({ maxIterations: 10, maxCostUSD: 1 }, 'mock', PRICE, t0);

    // Providers are consumed in launch order: A first, then its child B.
    const providerA = new MockProvider([
      [
        { type: 'tool_call', call: { id: 'a1', name: 'agent', input: { prompt: 'b work' } } },
        { type: 'usage', inputTokens: 10, outputTokens: 5 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', delta: 'A done' }, { type: 'usage', inputTokens: 10, outputTokens: 5 }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const providerB = new MockProvider([
      [{ type: 'text', delta: 'B done' }, { type: 'usage', inputTokens: 100, outputTokens: 50 }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeNestedHarness(ws, bus, [providerA, providerB]);
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false, parentBudget };
    const res = await tool.run({ prompt: 'a work' }, ctx);

    assert.ok(res.ok);
    assert.match(res.summary, /A done/);
    // A own (30/1e6) + B own (150/1e6): B's spend rides A's finish-time roll-up up to the TOP
    // budget. An own-only accrual (currentCostUSD instead of total*) would leave the top at 30/1e6.
    assert.equal(microUSD(parentBudget), 180, 'the tree total (A + B) accrues to the top');
    assert.equal(parentBudget.accruedSubagentInputTokens, 120, 'input tokens roll up the whole tree');
    assert.equal(parentBudget.accruedSubagentOutputTokens, 60, 'output tokens roll up the whole tree');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a background grandchild accrues to the ROOT budget even after its parent finished', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-bg-root-'));
  try {
    const bus = new EventBus();
    const parentBudget = new Budget({ maxIterations: 10, maxCostUSD: 1 }, 'mock', PRICE, t0);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    // A launches B in the background, then finishes while B is still blocked in its provider call.
    const providerA = new MockProvider([
      [
        { type: 'tool_call', call: { id: 'a1', name: 'agent', input: { prompt: 'b work', run_in_background: true } } },
        { type: 'usage', inputTokens: 10, outputTokens: 5 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', delta: 'A done' }, { type: 'usage', inputTokens: 10, outputTokens: 5 }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const providerB = mkDeferred(gate, [], 'B', { input: 100, output: 50 });
    const tool = makeNestedHarness(ws, bus, [providerA, providerB]);
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false, parentBudget };
    const res = await tool.run({ prompt: 'a work' }, ctx);

    assert.ok(res.ok);
    assert.match(res.summary, /A done/);
    // A's own 30/1e6 has rolled up; B is still blocked in its provider call, nothing accrued yet.
    assert.equal(parentBudget.accruedSubagentCostUSD, 30 / 1e6, 'A own spend accrued; B still running');

    release(); // B finishes AFTER A's loop is already gone.
    await tick(80);
    // B's spend must land in the ROOT (parentBudget) — accruing into A's dead budget would lose it.
    assert.equal(microUSD(parentBudget), 180, 'late bg spend reaches the root budget, not the already-finished parent');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('nested fan-out is width-capped: at most subagentConcurrency siblings admitted at once', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-nested-width-'));
  try {
    const bus = new EventBus();
    const parentBudget = new Budget({ maxIterations: 10, maxCostUSD: 1 }, 'mock', PRICE, t0);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const admitted: string[] = [];

    // A emits THREE background agent calls in a single assistant message; each child blocks in its
    // provider call until release, recording its admission as the generator starts.
    const providerA = new MockProvider([
      [
        { type: 'tool_call', call: { id: 'b1', name: 'agent', input: { prompt: 'b1', run_in_background: true } } },
        { type: 'tool_call', call: { id: 'b2', name: 'agent', input: { prompt: 'b2', run_in_background: true } } },
        { type: 'tool_call', call: { id: 'b3', name: 'agent', input: { prompt: 'b3', run_in_background: true } } },
        { type: 'usage', inputTokens: 2, outputTokens: 1 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', delta: 'A done' }, { type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeNestedHarness(
      ws,
      bus,
      [
        providerA,
        mkDeferred(gate, admitted, 'b1', { input: 10, output: 5 }),
        mkDeferred(gate, admitted, 'b2', { input: 10, output: 5 }),
        mkDeferred(gate, admitted, 'b3', { input: 10, output: 5 }),
      ],
      2, // per-parent gate admits at most 2 children at once
    );
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false, parentBudget };
    const res = await tool.run({ prompt: 'fan out' }, ctx);

    assert.ok(res.ok);
    await tick(50);
    assert.equal(admitted.length, 2, 'only subagentConcurrency nested siblings are admitted at once; the third queues');
    release();
    await tick(80);
    assert.equal(admitted.length, 3, 'the queued sibling is admitted once a permit frees');
    // A own 6/1e6 + 3 × 15/1e6 — all three nested bg agents accrue to the root.
    assert.equal(microUSD(parentBudget), 51, 'every nested agent accrues to the root exactly once');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── exit paths: error + cancellation still accrue ────────────────────────────────────────

test('a provider error mid-run still accrues the spend via the catch path', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-err-'));
  try {
    const bus = new EventBus();
    const parentBudget = new Budget({ maxIterations: 10, maxCostUSD: 1 }, 'mock', PRICE, t0);
    const provider: Provider = {
      name: 'mock',
      async *send(): AsyncIterable<ProviderEvent> {
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
        throw new Error('boom');
      },
      estimateTokens: (messages: Message[]) => estimateTokensFromMessages(messages),
    };
    const tool = makeTool(ws, provider, bus);
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false, parentBudget };
    const res = await tool.run({ prompt: 'work' }, ctx);

    assert.equal(res.ok, false, 'the tool result surfaces the failure');
    assert.match(res.summary, /boom/);
    assert.equal(parentBudget.accruedSubagentCostUSD, 15 / 1e6, 'the catch path accrues the spend already made');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('cancelling a background sub-agent mid-run accrues the spend made so far', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-bg-cancel-'));
  try {
    const bus = new EventBus();
    const parentBudget = new Budget({ maxIterations: 10, maxCostUSD: 1 }, 'mock', PRICE, t0);
    const notifications: Array<{ taskId: string; answer: string }> = [];
    bus.on((e) => {
      if (e.type === 'task_notification') notifications.push({ taskId: e.taskId, answer: e.answer });
    });
    const provider: Provider = {
      name: 'mock',
      // Yields its usage, then blocks until the request is aborted.
      async *send(req: CompletionRequest): AsyncIterable<ProviderEvent> {
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
        await new Promise<void>((r) => {
          if (req.signal?.aborted) return r();
          req.signal?.addEventListener('abort', () => r(), { once: true });
        });
        yield { type: 'done', stopReason: 'end_turn' };
      },
      estimateTokens: (messages: Message[]) => estimateTokensFromMessages(messages),
    };
    const tool = makeTool(ws, provider, bus);
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false, parentBudget };
    const res = await tool.run({ prompt: 'long bg', run_in_background: true }, ctx);

    assert.ok(res.ok);
    const taskId = res.data?.taskId;
    assert.ok(taskId, 'the bg agent reports its taskId');
    await tick(30); // let it reach the blocked provider call

    bus.emit({ type: 'cancel_subagent', taskId: taskId! });
    await tick(80);

    assert.equal(parentBudget.accruedSubagentCostUSD, 15 / 1e6, 'the cancelled agent still accrues its spend');
    const note = notifications.filter((n) => n.taskId === taskId).at(-1);
    assert.equal(note?.answer, 'agent cancelled by user', 'the cancel notification is delivered');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('cancelling a background sub-agent while it waits for a slot accrues nothing for it', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p309-bg-queued-'));
  try {
    const bus = new EventBus();
    const parentBudget = new Budget({ maxIterations: 10, maxCostUSD: 1 }, 'mock', PRICE, t0);
    const notifications: Array<{ taskId: string; answer: string }> = [];
    bus.on((e) => {
      if (e.type === 'task_notification') notifications.push({ taskId: e.taskId, answer: e.answer });
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const admitted: string[] = [];
    // Concurrency 1: the holder takes the only permit and blocks; the second bg agent queues.
    const holder = mkDeferred(gate, admitted, 'holder', { input: 10, output: 5 });
    const filler = new MockProvider([
      [{ type: 'text', delta: 'filler done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeNestedHarness(ws, bus, [holder, filler], 1);
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false, parentBudget };

    const res1 = await tool.run({ prompt: 'holder', run_in_background: true }, ctx);
    const res2 = await tool.run({ prompt: 'queued', run_in_background: true }, ctx);
    assert.ok(res1.ok && res2.ok);
    const taskId2 = res2.data?.taskId;
    assert.ok(taskId2, 'the queued bg agent still has a taskId');
    await tick(30); // holder admitted + blocked; agent 2 parked in the queue

    bus.emit({ type: 'cancel_subagent', taskId: taskId2! });
    await tick(50);
    const queuedNote = notifications.filter((n) => n.taskId === taskId2).at(-1);
    assert.equal(queuedNote?.answer, 'agent cancelled while waiting for a slot', 'the queued agent is dequeued with its own notification');

    release(); // the holder now finishes.
    await tick(80);
    assert.deepEqual(admitted, ['holder'], 'the cancelled agent never got a slot and never ran');
    // Only the holder spent (15/1e6). The queued agent accrued zero via its catch path.
    assert.equal(parentBudget.accruedSubagentCostUSD, 15 / 1e6, 'only the runner accrues; the queued cancel accrues nothing');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
