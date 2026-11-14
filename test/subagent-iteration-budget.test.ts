/**
 * Subagent iteration-exhaustion fix — regression tests.
 *
 * Root cause (observed 2026-11-12): read-only review subagents (explore/reviewer) burned their
 * whole turn budget re-reading material compaction kept deleting, then died at max_iterations
 * with salvage returning intent ("I'll re-read…") instead of findings. The fix:
 *   - Budget.iterationState() + a compaction-proof "## Iteration budget" block sent EVERY turn as
 *     the request's UNCACHED volatile system suffix (keeps the stable system prompt cache-stable and
 *     stays out of compaction continuity), with a near-ceiling "synthesize now" warning.
 *   - a budget/externalization discipline clause in the subagent system prompt (read-only agents
 *     are told to deliver findings in the final answer, not write files they have no tool for).
 *   - salvage falls back to the last substantive assistant text when the closing pass is empty.
 *   - explore/reviewer ceilings raised (12→30, 10→20), still parent-capped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { makeAgentTool } from '../src/tools/agentTool.js';
import { resolveAgentDef } from '../src/agent/defs.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import { estimateTokensFromMessages, type CompletionRequest, type Provider, type ProviderEvent } from '../src/provider/provider.js';
import type { ToolContext } from '../src/tools/types.js';

const PRICE = { mock: { input: 1, output: 1 } };

/** A provider that records the system prompt AND volatile suffix of every request, then replays scripted turns. */
class CapturingProvider implements Provider {
  readonly name = 'mock';
  readonly systems: string[] = [];
  readonly suffixes: string[] = [];
  private i = 0;
  constructor(private readonly turns: ProviderEvent[][]) {}
  async *send(req: CompletionRequest): AsyncIterable<ProviderEvent> {
    this.systems.push(req.system ?? '');
    this.suffixes.push(req.systemVolatileSuffix ?? '');
    const turn = this.turns[this.i] ?? [{ type: 'done', stopReason: 'end_turn' }];
    this.i += 1;
    for (const e of turn) yield e;
  }
  estimateTokens(messages: Parameters<Provider['estimateTokens']>[0]): number {
    return estimateTokensFromMessages(messages);
  }
}

const done = (text = 'done'): ProviderEvent[] => [
  { type: 'text', delta: text },
  { type: 'done', stopReason: 'end_turn' },
];
const readCall = (id: string): ProviderEvent[] => [
  { type: 'tool_call', call: { id, name: 'read_file', input: { path: 'a.txt' } } },
  { type: 'done', stopReason: 'tool_use' },
];

/** Append a user turn and run the loop (run() takes no args — input lives in the context). */
async function runLoop(deps: LoopDeps, prompt: string): Promise<void> {
  deps.context.append({ role: 'user', content: [{ type: 'text', text: prompt }] });
  await new AgentLoop(deps, 'full').run();
}

function makeDeps(ws: string, provider: Provider, maxIterations: number, registry?: ToolRegistry): LoopDeps {
  const reg = registry ?? new ToolRegistry();
  if (!registry) registerBuiltinTools(reg);
  return {
    provider,
    registry: reg,
    gate: new ScriptedApprovalGate([], 'approve'),
    bus: new EventBus(),
    budget: new Budget({ maxIterations }, 'mock', PRICE, Date.now()),
    context: new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test-system',
    maxOutputTokens: 1024,
    workspaceRoot: ws,
    dryRun: false,
    maxToolResultChars: 16_000,
    contextBudget: 1_000_000,
  };
}

// ── Budget.iterationState ────────────────────────────────────────────────────────────────────
test('Budget.iterationState reports used/max/remaining and null when unlimited', () => {
  const capped = new Budget({ maxIterations: 10 }, 'mock', PRICE, Date.now());
  assert.deepEqual(capped.iterationState(), { used: 0, max: 10, remaining: 10 });
  capped.tick(); capped.tick(); capped.tick();
  assert.deepEqual(capped.iterationState(), { used: 3, max: 10, remaining: 7 });
  const unlimited = new Budget({ maxIterations: 0 }, 'mock', PRICE, Date.now());
  assert.deepEqual(unlimited.iterationState(), { used: 0, max: 0, remaining: null });
});

// ── The compaction-proof budget block as the uncached volatile suffix ────────────────────────
test('loop sends the iteration-budget block as the volatile suffix for a capped agent, keeping system cache-stable', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'budget-block-'));
  try {
    const provider = new CapturingProvider([done()]);
    await runLoop(makeDeps(ws, provider, 10), 'go');
    assert.ok(provider.suffixes.length >= 1);
    const suffix = provider.suffixes[0];
    assert.match(suffix, /## Iteration budget/);
    assert.match(suffix, /Turns used: \d+\/10/);
    assert.match(suffix, /Pace yourself/); // plenty of headroom on turn 1
    assert.doesNotMatch(suffix, /NEAR THE CEILING/);
    // The volatile counter must NOT be in the cached system prefix (would bust the prompt cache).
    assert.doesNotMatch(provider.systems[0], /## Iteration budget/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('loop omits the budget suffix for the unlimited main loop', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'budget-block-unlimited-'));
  try {
    const provider = new CapturingProvider([done()]);
    await runLoop(makeDeps(ws, provider, 0), 'go'); // 0 = unlimited
    assert.equal(provider.suffixes[0], '');
    assert.doesNotMatch(provider.systems[0], /## Iteration budget/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('budget suffix warns NEAR THE CEILING, refreshes every turn, and never enters the cached system', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'budget-warn-'));
  try {
    // cap=4, each turn makes a tool call so the loop keeps going until the ceiling.
    const provider = new CapturingProvider([readCall('r1'), readCall('r2'), readCall('r3'), readCall('r4')]);
    await runLoop(makeDeps(ws, provider, 4), 'go');
    assert.ok(provider.suffixes.length >= 3, 'loop should run several turns');
    assert.match(provider.suffixes[0], /Pace yourself/); // early turn
    const late = provider.suffixes[provider.suffixes.length - 1];
    assert.match(late, /NEAR THE CEILING/);
    assert.match(late, /final answer/);
    for (const s of provider.suffixes) assert.match(s, /## Iteration budget/); // every turn
    // Cache stability: the stable system prefix is identical across all turns (no per-turn churn).
    for (const sys of provider.systems) {
      assert.doesNotMatch(sys, /## Iteration budget/);
      assert.equal(sys, provider.systems[0]);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('warn window is bounded: a 200-turn budget does NOT warn at 25% remaining', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'budget-warn-window-'));
  try {
    // cap=200; after 150 turns remaining=50 (25%). The absolute cap (5) must keep it in pace mode.
    const provider = new CapturingProvider([done()]);
    const deps = makeDeps(ws, provider, 200);
    for (let i = 0; i < 150; i++) deps.budget.tick();
    await runLoop(deps, 'go');
    assert.match(provider.suffixes[0], /Turns used: 150\/200/);
    assert.match(provider.suffixes[0], /Pace yourself/);
    assert.doesNotMatch(provider.suffixes[0], /NEAR THE CEILING/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── Subagent discipline clause (read-only vs writable) ───────────────────────────────────────
test('read-only subagent prompt carries the budget discipline and the no-write delivery rule', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'discipline-ro-'));
  try {
    const provider = new CapturingProvider([done('findings: all clean')]);
    const readOnly = new ToolRegistry();
    registerBuiltinTools(readOnly);
    for (const name of ['write_file', 'edit_file', 'apply_patch', 'multi_edit']) readOnly.unregister(name);
    const tool = makeAgentTool({
      makeLoopDeps: () => makeDeps(ws, provider, 5, readOnly),
      getAutonomy: () => 'full',
      contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6, maxIterations: 5, priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    await tool.run({ prompt: 'review', subagent_type: 'explore' }, ctx);
    const sys = provider.systems[0];
    assert.match(sys, /Budget & delivery discipline/);
    assert.match(sys, /READ-ONLY/);
    assert.match(sys, /FINAL ANSWER/);
    assert.doesNotMatch(sys, /Externalize durable findings to your output file/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('writable subagent prompt tells it to externalize findings to files', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'discipline-rw-'));
  try {
    const provider = new CapturingProvider([done()]);
    const tool = makeAgentTool({
      makeLoopDeps: () => makeDeps(ws, provider, 5), // full builtin registry incl. write_file
      getAutonomy: () => 'full',
      contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6, maxIterations: 5, priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    await tool.run({ prompt: 'do work' }, ctx);
    const sys = provider.systems[0];
    assert.match(sys, /Budget & delivery discipline/);
    assert.match(sys, /Externalize durable findings to your output file/);
    assert.doesNotMatch(sys, /READ-ONLY/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── Salvage falls back to accumulated findings when the closing pass is empty ────────────────
test('salvage returns the last substantive assistant text when the closing pass is empty', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'salvage-fallback-'));
  try {
    const findings = 'FINDING A1: budget.ts check() silently stops at the ceiling with no warning to the model.';
    const provider = new MockProvider([
      // turn 1: substantive findings + a tool call that burns the cap (maxIterations=1)
      [
        { type: 'text', delta: findings },
        { type: 'tool_call', call: { id: 'r1', name: 'read_file', input: { path: 'a.txt' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // salvage closing pass: EMPTY (compaction gutted the context) → must fall back to findings
      [{ type: 'text', delta: '' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeAgentTool({
      makeLoopDeps: () => makeDeps(ws, provider, 1),
      getAutonomy: () => 'full',
      contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6, maxIterations: 1, priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'review' }, ctx);
    assert.equal(res.data?.status, 'partial');
    const answer = String((res.data as { answer?: string }).answer ?? '');
    assert.ok(answer.includes('FINDING A1'), `salvage must deliver the accumulated findings, got: ${answer}`);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── Salvage must NOT present a pure intent sentence as findings ──────────────────────────────
test('salvage skips a pure forward-looking intent sentence and reports no findings', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'salvage-intent-'));
  try {
    const intent = "I'll now read the remaining core files and then compile the full report.";
    const provider = new MockProvider([
      // turn 1: ONLY intent (no finding) + a tool call that burns the cap (maxIterations=1)
      [
        { type: 'text', delta: intent },
        { type: 'tool_call', call: { id: 'r1', name: 'read_file', input: { path: 'a.txt' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // salvage closing pass: EMPTY → fallback must NOT hand back the intent sentence as coverage
      [{ type: 'text', delta: '' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeAgentTool({
      makeLoopDeps: () => makeDeps(ws, provider, 1),
      getAutonomy: () => 'full',
      contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6, maxIterations: 1, priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'review' }, ctx);
    assert.equal(res.data?.status, 'partial');
    const answer = String((res.data as { answer?: string }).answer ?? '');
    assert.ok(!answer.includes('PARTIAL findings:'), `intent must not be presented as findings, got: ${answer}`);
    assert.ok(answer.includes('before producing an answer'), `honest empty-coverage message expected, got: ${answer}`);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── Ceiling stop labels partial coverage with N/M iterations ─────────────────────────────────
test('a max_iterations stop labels the outcome with used/max iterations', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'iter-label-'));
  try {
    const provider = new MockProvider([
      [
        { type: 'text', delta: 'FINDING B2: the loop counts one iteration per provider turn.' },
        { type: 'tool_call', call: { id: 'r1', name: 'read_file', input: { path: 'a.txt' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', delta: 'PARTIAL coverage: verified the iteration counter only.' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeAgentTool({
      makeLoopDeps: () => makeDeps(ws, provider, 1),
      getAutonomy: () => 'full',
      contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6, maxIterations: 1, priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'review' }, ctx);
    assert.equal(res.data?.status, 'partial');
    const answer = String((res.data as { answer?: string }).answer ?? '');
    assert.match(answer, /max_iterations ceiling \(1\/1 iterations\)/, `expected N/M label, got: ${answer}`);
    assert.deepEqual((res.data as { iterations?: { used: number; max: number } }).iterations, { used: 1, max: 1 });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── Right-sized ceilings ─────────────────────────────────────────────────────────────────────
test('explore and reviewer ceilings are right-sized for a read-only review', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ceilings-'));
  try {
    const explore = resolveAgentDef('explore', ws);
    const reviewer = resolveAgentDef('reviewer', ws);
    assert.equal(explore?.maxIterations, 30);
    assert.equal(reviewer?.maxIterations, 20);
    assert.ok(!explore?.tools?.some((t) => /write_file|edit_file/.test(t)));
    assert.ok(!reviewer?.tools?.some((t) => /write_file|edit_file/.test(t)));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── Intent filter must NOT drop a rhetorical finding ("Let me be clear: …") ──────────────────
test('salvage keeps a finding that opens with a rhetorical "Let me be clear"', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'salvage-rhetorical-'));
  try {
    const finding = 'Let me be clear: the cache is busted because the suffix precedes the breakpoint.';
    const provider = new MockProvider([
      [
        { type: 'text', delta: finding },
        { type: 'tool_call', call: { id: 'r1', name: 'read_file', input: { path: 'a.txt' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', delta: '' }, { type: 'done', stopReason: 'end_turn' }], // empty salvage → fallback
    ]);
    const tool = makeAgentTool({
      makeLoopDeps: () => makeDeps(ws, provider, 1),
      getAutonomy: () => 'full',
      contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6, maxIterations: 1, priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'review' }, ctx);
    const answer = String((res.data as { answer?: string }).answer ?? '');
    assert.ok(answer.includes('the cache is busted'), `rhetorical finding must be kept, got: ${answer}`);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── A completed end_turn answer is returned verbatim (intent filter is ceiling-only) ─────────
test('a completed end_turn answer is not reclassified by the intent filter', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'endturn-verbatim-'));
  try {
    // The agent finishes (end_turn) with a short text that LOOKS like intent but is its final answer.
    const finalText = "I'll summarize: the budget block is delivered at the message tail.";
    const provider = new MockProvider([
      [{ type: 'text', delta: finalText }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const tool = makeAgentTool({
      makeLoopDeps: () => makeDeps(ws, provider, 5),
      getAutonomy: () => 'full',
      contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6, maxIterations: 5, priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'review' }, ctx);
    assert.equal(res.data?.status, 'completed', 'end_turn must stay completed');
    const answer = String((res.data as { answer?: string }).answer ?? '');
    assert.equal(answer, finalText, 'the completed answer must be returned verbatim');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});