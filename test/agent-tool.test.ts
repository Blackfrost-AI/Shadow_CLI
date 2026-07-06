import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { makeAgentTool } from '../src/tools/agentTool.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { ScriptedApprovalGate, type ApprovalDecision } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import type { LoopDeps } from '../src/agent/loop.js';
import type { ToolContext } from '../src/tools/types.js';
import type { AutonomyLevel } from '../src/safety/permissions.js';
import { serializeContext, hydrateContext } from '../src/state/snapshot.js';
import { listWorktrees } from '../src/tools/worktree.js';

const PRICE = { mock: { input: 1, output: 1 } };

/** Run the `agent` tool with a sub-agent scripted to attempt a write_file, under a given gate decision + autonomy. */
async function runSubAgent(ws: string, decision: ApprovalDecision, autonomy: AutonomyLevel): Promise<void> {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 'w1', name: 'write_file', input: { path: 'pwned.txt', content: 'x' } } },
      { type: 'done', stopReason: 'tool_use' },
    ],
  ]);
  const makeLoopDeps = (): LoopDeps => ({
    provider,
    registry,
    gate: new ScriptedApprovalGate([], decision), // the SESSION gate the sub-agent must obey
    bus: new EventBus(),
    budget: new Budget({ maxIterations: 5 }, 'mock', PRICE, Date.now()),
    context: new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: ws,
    dryRun: false,
    maxToolResultChars: 16_000,
    contextBudget: 1_000_000,
  });
  const tool = makeAgentTool({
    makeLoopDeps,
    getAutonomy: () => autonomy,
    contextBudget: 1_000_000,
    triggerRatio: 0.75,
    keepLastTurns: 6,
    maxIterations: 5,
    priceTable: PRICE,
  });
  const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
  await tool.run({ prompt: 'write a file' }, ctx);
}

test('sub-agent is bound by the session gate — a denied write does NOT execute (no auto-approve bypass)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-'));
  try {
    await runSubAgent(ws, 'deny', 'manual');
    assert.equal(existsSync(join(ws, 'pwned.txt')), false, 'a denied sub-agent write must never touch disk');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('sub-agent honors an approved write at manual autonomy', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-'));
  try {
    await runSubAgent(ws, 'approve', 'manual');
    assert.equal(existsSync(join(ws, 'pwned.txt')), true, 'an approved sub-agent write lands');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// New tests for 1-4: worktree isolation and bg launch (real paths)
test('agent with isolation:worktree uses isolated sub workspace (creates .shadow/worktrees entry)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-wt-'));
  try {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const provider = new MockProvider([ [{ type: 'done', stopReason: 'end_turn' as any }] ]);
    const makeLoopDeps = (): LoopDeps => ({
      provider,
      registry,
      gate: new ScriptedApprovalGate([], 'approve'),
      bus: new EventBus(),
      budget: new Budget({ maxIterations: 2 }, 'mock', PRICE, Date.now()),
      context: new Context({ contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2 }),
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 256,
      workspaceRoot: ws,
      dryRun: false,
      maxToolResultChars: 1000,
      contextBudget: 100000,
    });
    const tool = makeAgentTool({ makeLoopDeps, getAutonomy: () => 'full', contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 2, priceTable: PRICE });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'noop', isolation: 'worktree' } as any, ctx);
    assert.ok(res.ok);
    // verify worktree dir was created (even if git not present, fallback)
    const wtRoot = join(ws, '.shadow/worktrees');
    assert.ok(existsSync(wtRoot), 'worktrees root created for isolation');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('agent with run_in_background returns taskId immediately (non blocking)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-bg-'));
  try {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const provider = new MockProvider([ [{ type: 'done', stopReason: 'end_turn' as any }] ]);
    const bus = new EventBus();
    let launched: any = null;
    bus.on((e: any) => { if (e.type === 'bg_agent_launched') launched = e; });
    const makeLoopDeps = (): LoopDeps => ({
      provider,
      registry,
      gate: new ScriptedApprovalGate([], 'approve'),
      bus,
      budget: new Budget({ maxIterations: 2 }, 'mock', PRICE, Date.now()),
      context: new Context({ contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2 }),
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 256,
      workspaceRoot: ws,
      dryRun: false,
      maxToolResultChars: 1000,
      contextBudget: 100000,
    });
    const tool = makeAgentTool({ makeLoopDeps, getAutonomy: () => 'full', contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 2, priceTable: PRICE });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'bg test', run_in_background: true } as any, ctx);
    assert.ok(res.ok);
    const data = res.data as any;
    assert.ok(data.taskId && data.status === 'started', 'bg agent must return taskId immediately without awaiting full result');
    assert.ok(launched && launched.taskId === data.taskId, 'bg launch must emit bg_agent_launched for main ctx recording');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Drives the *full* main bus listener pattern from index.ts (task_notification append + bg_agent_launched record to main ctx transcript)
test('bg agent full listener path: main context receives task-notification append and launch record (end-to-end bus + transcript)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-bg-full-'));
  try {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const provider = new MockProvider([[{ type: 'done', stopReason: 'end_turn' as any }]]);
    const mainContext = new Context({ contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2 });
    const bus = new EventBus();

    // Drive the *real* shipped registration function (extracted, used by index.ts)
    const { attachBgAgentDelivery } = await import('../src/agent/busListeners.js');
    attachBgAgentDelivery(bus, mainContext);

    const makeLoopDeps = (): LoopDeps => ({
      provider,
      registry,
      gate: new ScriptedApprovalGate([], 'approve'),
      bus,
      budget: new Budget({ maxIterations: 2 }, 'mock', PRICE, Date.now()),
      context: new Context({ contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2 }),
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 256,
      workspaceRoot: ws,
      dryRun: false,
      maxToolResultChars: 1000,
      contextBudget: 100000,
    });

    const tool = makeAgentTool({ makeLoopDeps, getAutonomy: () => 'full', contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 2, priceTable: PRICE });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };

    const res = await tool.run({ prompt: 'bg full listener test', run_in_background: true } as any, ctx);
    assert.ok(res.ok);
    const data = res.data as any;
    assert.ok(data.taskId);

    // Give the fire-and-forget promise a chance to run (mock is fast)
    await new Promise((r) => setTimeout(r, 10));

    // Verify launch record hit the mainContext (via listener)
    const tasks = (mainContext as any)._subAgentTasks || [];
    assert.ok(tasks.some((t: any) => t.taskId === data.taskId), 'launch must have been recorded to main ctx via listener');

    // Verify task_notification was appended as user message to main transcript
    const msgs = mainContext.messages();
    const hasNotif = msgs.some((m) => m.role === 'user' && m.content.some((b: any) => b.type === 'text' && b.text.includes(`task_id="${data.taskId}"`)));
    assert.ok(hasNotif, 'task_notification must have been appended to main context transcript');

    // Recovery path: serialize + hydrate should preserve the subAgentTasks
    const snap = serializeContext(mainContext);
    const restored = hydrateContext(snap as any, { contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2 });
    const restoredTasks = (restored as any)._subAgentTasks || [];
    assert.ok(restoredTasks.some((t: any) => t.taskId === data.taskId), 'subAgentTasks must survive serialize/hydrate for resume recovery');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Direct test of listWorktrees porcelain path (creates real git worktree in temp repo to exercise git porcelain output).
test('listWorktrees exercises real git porcelain output for managed worktrees', async () => {
  const base = mkdtempSync(join(tmpdir(), 'wt-porcelain-'));
  try {
    // init a git repo
    execSync('git init -q', { cwd: base, stdio: 'ignore' });
    execSync('git config user.email "t@t" && git config user.name "t"', { cwd: base, stdio: 'ignore' });
    writeFileSync(join(base, 'README.md'), 'x');
    execSync('git add README.md && git commit -q -m init', { cwd: base, stdio: 'ignore' });

    const worktreesDir = join(base, '.shadow/worktrees');
    mkdirSync(worktreesDir, { recursive: true });
    const wtName = 'test-wt-' + Math.random().toString(36).slice(2, 8);
    const wtPath = join(worktreesDir, wtName);

    // create a real detached worktree (this will emit porcelain with worktree + HEAD)
    execSync(`git worktree add --detach "${wtPath}"`, { cwd: base, stdio: 'ignore' });

    const listed = listWorktrees(base);
    const found = listed.find((w) => w.path === wtPath || w.id === wtName);
    assert.ok(found, 'listWorktrees must return the porcelain-listed worktree under .shadow/worktrees');

    // cleanup the worktree
    execSync(`git worktree remove --force "${wtPath}"`, { cwd: base, stdio: 'ignore' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
