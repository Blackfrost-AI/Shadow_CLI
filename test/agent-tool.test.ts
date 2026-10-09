import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { makeAgentTool } from '../src/tools/agentTool.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, SubagentBus, type LoopEvent, type LoopListener } from '../src/agent/events.js';
import { WorkCenter } from '../src/app/workCenter.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { ScriptedApprovalGate, type ApprovalDecision } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import type { LoopDeps } from '../src/agent/loop.js';
import type { ToolContext } from '../src/tools/types.js';
import type { AutonomyLevel } from '../src/safety/permissions.js';
import type { CompletionRequest, Provider, ProviderEvent } from '../src/provider/provider.js';
import { serializeContext, hydrateContext } from '../src/state/snapshot.js';
import { listWorktrees } from '../src/tools/worktree.js';
import { JobStore } from '../src/state/jobStore.js';

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
    execFileSync('git', ['init', '-q'], { cwd: ws });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'initial'], { cwd: ws });
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
    // The managed root remains after a genuinely empty checkout is cleaned.
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
    let completed = false;
    bus.on((e: any) => {
      if (e.type === 'bg_agent_launched') launched = e;
      if (e.type === 'task_notification') completed = true;
    });
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
    // Keep the launch assertion non-blocking, then await persistence/SQLite close
    // before removing the fixture directory (Windows cannot unlink an open DB).
    for (let i = 0; !completed && i < 1000; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(completed, true, 'background fixture must settle before filesystem cleanup');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('background agent pauses at a safe boundary, preserves context, and completes after resume', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-pause-'));
  try {
    writeFileSync(join(ws, 'a.txt'), 'hello');
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    let turn = 0;
    const provider: Provider = {
      name: 'pause-test',
      estimateTokens: () => 1,
      async *send(_req: CompletionRequest): AsyncIterable<ProviderEvent> {
        turn++;
        if (turn === 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          yield { type: 'tool_call', call: { id: 'read-1', name: 'read_file', input: { path: 'a.txt' } } };
          yield { type: 'done', stopReason: 'tool_use' };
        } else {
          yield { type: 'text', delta: 'finished after resume' };
          yield { type: 'done', stopReason: 'end_turn' };
        }
      },
    };
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on((event) => seen.push(event.type));
    const makeLoopDeps = (): LoopDeps => ({
      provider, registry, gate: new ScriptedApprovalGate([], 'approve'), bus,
      budget: new Budget({ maxIterations: 5 }, 'mock', PRICE, Date.now()),
      context: new Context({ contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2 }),
      signal: new AbortController().signal, model: 'mock', system: 'test', maxOutputTokens: 256,
      workspaceRoot: ws, dryRun: false, maxToolResultChars: 1000, contextBudget: 100000,
    });
    const tool = makeAgentTool({ makeLoopDeps, getAutonomy: () => 'full', contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 5, priceTable: PRICE });
    const res = await tool.run({ prompt: 'read then finish', run_in_background: true }, { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false });
    const taskId = res.data?.taskId;
    assert.ok(taskId);
    bus.emit({ type: 'pause_subagent', taskId });
    const deadline = Date.now() + 1000;
    while (!seen.includes('subagent_paused') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(seen.includes('subagent_paused'));
    assert.equal(turn, 1, 'second provider call waits while paused');
    bus.emit({ type: 'resume_subagent', taskId });
    while (!seen.includes('subagent_end') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(seen.includes('subagent_resumed'));
    assert.equal(turn, 2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('confirmed retry creates a linked new run and enforces the retry counter in memory', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-retry-'));
  try {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    let builds = 0;
    const bus = new EventBus();
    const links: Array<{ taskId: string; retryOf: string; retryCount: number }> = [];
    const ends: string[] = [];
    bus.on((event) => {
      if (event.type === 'subagent_retry_link') links.push(event);
      if (event.type === 'subagent_end') ends.push(event.taskId);
    });
    const makeLoopDeps = (): LoopDeps => {
      builds++;
      const failFirst = builds === 1;
      const provider: Provider = {
        name: 'retry-test', estimateTokens: () => 1,
        async *send(): AsyncIterable<ProviderEvent> {
          if (failFirst) throw new Error('transient');
          yield { type: 'text', delta: 'recovered' };
          yield { type: 'done', stopReason: 'end_turn' };
        },
      };
      return {
        provider, registry, gate: new ScriptedApprovalGate([], 'approve'), bus,
        budget: new Budget({ maxIterations: 3 }, 'mock', PRICE, Date.now()),
        context: new Context({ contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2 }),
        signal: new AbortController().signal, model: 'mock', system: 'test', maxOutputTokens: 256,
        workspaceRoot: ws, dryRun: false, maxToolResultChars: 1000, contextBudget: 100000,
      };
    };
    const tool = makeAgentTool({ makeLoopDeps, getAutonomy: () => 'full', contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 3, priceTable: PRICE });
    const first = await tool.run({ prompt: 'retry me', run_in_background: true }, { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false });
    const firstId = first.data?.taskId;
    assert.ok(firstId);
    const deadline = Date.now() + 2500;
    while (!ends.includes(firstId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    bus.emit({ type: 'retry_subagent', taskId: firstId });
    while (!links.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(links[0]?.retryOf, firstId);
    assert.equal(links[0]?.retryCount, 1);
    while (!ends.includes(links[0]!.taskId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(ends.includes(links[0]!.taskId));
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
    const pendingNotifications = attachBgAgentDelivery(bus, mainContext);

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
      // The bg agent's empty scripted turn triggers the P1A-08 empty-response backoff; stub the
      // seam so retries are instantaneous — this test pins the T0-6 buffering contract, not timing.
      sleep: async () => {},
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

    // T0-6: the notification is BUFFERED, not appended to the live context. Appending it live
    // could land it between an assistant tool_use and its tool_result — which the Anthropic
    // adapter coalesces into an ordering violation and OpenAI rejects outright, permanently
    // 400ing the session. It is folded into the next USER turn instead (see index.ts).
    const msgs = mainContext.messages();
    const appendedLive = msgs.some(
      (m) => m.role === 'user' && m.content.some((b: any) => b.type === 'text' && b.text.includes(`task_id="${data.taskId}"`)),
    );
    assert.equal(appendedLive, false, 'a notification must never be appended to the live context mid-turn');
    const drained = pendingNotifications.drain();
    assert.ok(
      drained.some((n) => n.includes(`task_id="${data.taskId}"`)),
      'the notification must be waiting for the next user turn',
    );
    assert.equal(pendingNotifications.size(), 0, 'drain clears the buffer');

    // Recovery path: serialize + hydrate should preserve the subAgentTasks
    const snap = serializeContext(mainContext);
    const restored = hydrateContext(snap as any, { contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 2 });
    const restoredTasks = (restored as any)._subAgentTasks || [];
    assert.ok(restoredTasks.some((t: any) => t.taskId === data.taskId), 'subAgentTasks must survive serialize/hydrate for resume recovery');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// BUG 3 — sub-agent visibility. The `agent` tool must emit SUBAGENT_START/SUBAGENT_END lifecycle
// events (so the TUI can surface a Running-N-agents panel) AND the forwarded tool lifecycle must be
// TAGGED with the sub-agent's taskId so the TUI routes it to the panel instead of clobbering the
// parent's single live-tool row.
test('BUG 3: agent tool emits subagent_start/end lifecycle + tags forwarded tool events with the taskId', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-bug3-'));
  try {
    writeFileSync(join(ws, 'a.ts'), 'export const x = 1;\n');
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    // A successful sub-agent reads a file, then returns its findings.
    const provider = new MockProvider([
      [
        { type: 'tool_call', call: { id: 'r1', name: 'read_file', input: { path: 'a.ts' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', delta: 'The file exports x = 1.' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const bus = new EventBus();
    const seen: Array<{ type: string; [k: string]: unknown }> = [];
    bus.on((e) => seen.push(e as { type: string; [k: string]: unknown }));

    const makeLoopDeps = (): LoopDeps => ({
      provider,
      registry,
      gate: new ScriptedApprovalGate([], 'approve'),
      bus,
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
      getAutonomy: () => 'full',
      contextBudget: 1_000_000,
      triggerRatio: 0.75,
      keepLastTurns: 6,
      maxIterations: 5,
      priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'read a.ts', subagent_type: 'explore', description: 'explore a' }, ctx);
    assert.ok(res.ok, 'sub-agent should succeed');

    const starts = seen.filter((e) => e.type === 'subagent_start');
    const ends = seen.filter((e) => e.type === 'subagent_end');
    assert.equal(starts.length, 1, 'exactly one subagent_start');
    assert.equal(ends.length, 1, 'exactly one subagent_end');
    const tid = starts[0].taskId as string;
    assert.ok(tid && tid.length > 0, 'subagent_start must carry a non-empty taskId');
    assert.equal(starts[0].subagentType, 'explore', 'subagent_start must carry the resolved subagent type');
    assert.equal(ends[0].taskId, tid, 'subagent_end must reference the same taskId');
    assert.equal(ends[0].ok, true, 'successful sub-agent must end with ok:true');

    // forwarded tool events (the tool the sub-agent ran) must be TAGGED so the parent UI routes them
    // to the sub-agent panel — NOT the parent's live row (the original clobbering bug).
    const toolStart = seen.find((e) => e.type === 'tool_start' && e.call && (e.call as { name: string }).name === 'read_file');
    assert.ok(toolStart, 'the sub-agent read_file tool_start must reach the parent');
    assert.equal((toolStart as { subagent?: string }).subagent, tid, 'sub-agent tool_start must be tagged with the taskId');
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

// Regression (harness stall bug): a sub-agent stopped by its max_iterations ceiling must
// SALVAGE its partial findings via one tool-less closing pass, instead of delivering an
// empty "stopped by its ceiling" notification.
test('max_iterations sub-agent salvage pass delivers a PARTIAL report', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'salvage-'));
  try {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    let salvageRequested = false;
    const seen: LoopEvent[] = [];
    const bus = new EventBus();
    bus.on((event) => seen.push(event));
    const provider = new MockProvider([
      // turn 1: burn the iteration cap with a tool call
      [
        { type: 'text', delta: 'I will inspect the files.' },
        { type: 'tool_call', call: { id: 'r1', name: 'read_file', input: { path: 'a.txt' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // salvage pass: provider.send() with tools:[] → the closing report
      (messages) => {
        salvageRequested = true;
        void messages;
        return [
          { type: 'text', delta: 'PARTIAL: I reviewed budget.ts and approval.ts; both look clean.' },
          { type: 'usage', inputTokens: 0, outputTokens: 0 },
          { type: 'done', stopReason: 'end_turn' },
        ];
      },
    ]);
    const makeLoopDeps = (): LoopDeps => ({
      provider,
      registry,
      gate: new ScriptedApprovalGate([], 'approve'),
      bus,
      budget: new Budget({ maxIterations: 1 }, 'mock', PRICE, Date.now()),
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
      getAutonomy: () => 'manual',
      contextBudget: 1_000_000,
      triggerRatio: 0.75,
      keepLastTurns: 6,
      maxIterations: 1,
      priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'review the codebase' }, ctx);
    assert.equal(salvageRequested, true, 'the salvage pass must run on a ceiling stop');
    assert.equal(res.ok, true, 'a controlled stop keeps its clean tool-result contract');
    assert.equal(res.data?.status, 'partial');
    assert.equal(seen.find((event) => event.type === 'subagent_end')?.ok, false, 'partial work is not completed');
    assert.doesNotMatch(res.summary, /I will inspect/, 'the closing report takes precedence over stale commentary');
    assert.ok(
      String(res.summary).includes('PARTIAL'),
      `the ceiling-stopped agent's report must reach the parent, got: ${res.summary}`,
    );
    assert.ok(
      String((res.data as { answer?: string }).answer).includes('PARTIAL'),
      'the structured answer field must carry the salvage report too',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Regression (harness-fix): an abnormal stop with no answer must NEVER deliver a blank
// <task-notification>. Six reviewer sub-agents once delivered empty bodies and the parent
// had no way to know why or to retry. The stop's diagnostic (loop's `error` event) must
// ride along in the answer.
test('bg sub-agent stopped abnormally delivers a non-empty diagnostic notification', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-bg-stop-'));
  try {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    // max_tokens with no answer text → loop emits an error diagnostic and stops empty.
    const provider = new MockProvider([[{ type: 'done', stopReason: 'max_tokens' }]]);
    const bus = new EventBus();
    const notifs: any[] = [];
    const work = new WorkCenter();
    work.subscribe(bus);
    bus.on((e: any) => { if (e.type === 'task_notification') notifs.push(e); });
    const makeLoopDeps = (): LoopDeps => ({
      provider,
      registry,
      gate: new ScriptedApprovalGate([], 'approve'),
      bus,
      budget: new Budget({ maxIterations: 5 }, 'mock', PRICE, Date.now()),
      context: new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 256,
      workspaceRoot: ws,
      dryRun: false,
      maxToolResultChars: 1000,
      contextBudget: 1_000_000,
    });
    const tool = makeAgentTool({
      makeLoopDeps, getAutonomy: () => 'full', contextBudget: 1_000_000,
      triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 5, priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'review', run_in_background: true } as any, ctx);
    assert.ok(res.ok);
    const taskId = (res.data as { taskId: string }).taskId;
    // The bg run completes asynchronously; wait for its notification (test timeout is 60s).
    for (let waited = 0; notifs.length === 0 && waited < 5000; waited += 25) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(notifs.length, 1, 'exactly one notification must arrive');
    assert.equal(notifs[0].taskId, taskId);
    assert.ok(notifs[0].answer.length > 0, 'the notification body must never be blank');
    assert.ok(notifs[0].answer.includes('max_tokens'), `the stop reason must be named, got: ${notifs[0].answer}`);
    assert.match(notifs[0].answer, /output-token cap/, 'keep the actual diagnostic, not only the stop code');
    assert.equal(work.get(taskId)?.status, 'failed', 'the work registry must not show completed');
    assert.equal(work.get(taskId)?.finalOutput, notifs[0].answer);
    work.unsubscribe();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('sync sub-agent stopped abnormally reports the failure, never "Sub-agent completed."', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'agent-sync-stop-'));
  try {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    // Three empty end_turns → the loop's empty-response recovery exhausts and stops
    // with provider_error and an empty finalAnswer.
    const provider = new MockProvider();
    const makeLoopDeps = (): LoopDeps => ({
      provider,
      registry,
      gate: new ScriptedApprovalGate([], 'approve'),
      bus: new EventBus(),
      budget: new Budget({ maxIterations: 10 }, 'mock', PRICE, Date.now()),
      context: new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 256,
      workspaceRoot: ws,
      dryRun: false,
      maxToolResultChars: 1000,
      contextBudget: 1_000_000,
    });
    const tool = makeAgentTool({
      makeLoopDeps, getAutonomy: () => 'full', contextBudget: 1_000_000,
      triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 10, priceTable: PRICE,
    });
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const res = await tool.run({ prompt: 'review' } as any, ctx);
    assert.equal(res.ok, false, 'provider failure must be a failed tool result');
    assert.equal(res.data?.answer, res.summary, 'structured consumers receive the same diagnostic');
    assert.equal(res.data?.status, 'failed');
    assert.equal(String(res.summary).includes('Sub-agent completed.'), false,
      `an abnormal stop must not masquerade as success, got: ${res.summary}`);
    assert.ok(String(res.summary).includes('provider_error'),
      `the stop reason must be named, got: ${res.summary}`);
    assert.ok(String(res.summary).includes('empty response'),
      `the loop's diagnostic must ride along, got: ${res.summary}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

function outcomeHarness(provider: Provider, maxIterations = 10, concurrency = 4) {
  const ws = mkdtempSync(join(tmpdir(), 'agent-outcome-'));
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  const off = bus.on((event) => events.push(event));
  const work = new WorkCenter();
  work.subscribe(bus);
  const makeLoopDeps = (): LoopDeps => ({
    provider, registry, bus, gate: new ScriptedApprovalGate([], 'approve'),
    budget: new Budget({ maxIterations }, 'mock', PRICE, Date.now()),
    context: new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
    signal: new AbortController().signal, model: 'mock', system: 'test', maxOutputTokens: 256,
    workspaceRoot: ws, dryRun: false, maxToolResultChars: 1000, contextBudget: 1_000_000,
  });
  const tool = makeAgentTool({
    makeLoopDeps, getAutonomy: () => 'full', contextBudget: 1_000_000,
    triggerRatio: 0.75, keepLastTurns: 2, maxIterations, priceTable: PRICE,
    subagentConcurrency: concurrency,
  });
  const controller = new AbortController();
  const ctx: ToolContext = { workspaceRoot: ws, signal: controller.signal, log: () => {}, dryRun: false };
  return {
    tool, ctx, bus, events, work, controller,
    close: () => { controller.abort(); off(); work.unsubscribe(); rmSync(ws, { recursive: true, force: true }); },
  };
}

test('prepared jobs reject different task input before invoking a provider', async () => {
  let calls = 0;
  const h = outcomeHarness(new MockProvider([() => { calls++; return [{ type: 'text', delta: 'answer' }, { type: 'done', stopReason: 'end_turn' }]; }]));
  const store = new JobStore(h.ctx.workspaceRoot);
  try {
    store.createJob({ prompt: 'recorded task' }, { id: 'prepared' });
    const result = await h.tool.run({ prompt: 'different task', job_id: 'prepared' }, h.ctx);
    assert.equal(result.ok, false); assert.match(result.summary, /prompt differs/); assert.equal(calls, 0);
    assert.equal(store.get('prepared')?.attempts.length, 0);
  } finally { store.close(); h.close(); }
});

test('closing report usage is charged once to the inherited budget', async () => {
  const h = outcomeHarness(new MockProvider([
    [{ type: 'tool_call', call: { id: 'fixture-read', name: 'read_file', input: { path: 'a.txt' } } }, { type: 'usage', inputTokens: 11, outputTokens: 7 }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', delta: 'PARTIAL findings' }, { type: 'usage', inputTokens: 13, outputTokens: 5 }, { type: 'done', stopReason: 'end_turn' }],
  ]), 1);
  try {
    const parent = new Budget({ maxIterations: 100, maxTotalTokens: 1_000_000 }, 'mock', PRICE, Date.now());
    const result = await h.tool.run({ prompt: 'fixture' }, { ...h.ctx, parentBudget: parent, rootBudget: parent });
    assert.equal(result.data?.status, 'partial');
    assert.equal(parent.totalInputTokens, 24); assert.equal(parent.totalOutputTokens, 12);
    const store = new JobStore(h.ctx.workspaceRoot);
    try { assert.equal(store.get(result.data!.jobId!)?.attempts[0]?.usage?.inputTokens, 24); } finally { store.close(); }
  } finally { h.close(); }
});

test('directed room follow-up reaches an active agent at its next model boundary', async () => {
  let sawMessage = false; let turn = 0;
  const provider: Provider = { name: 'fixture', estimateTokens: () => 1,
    async *send(request) {
      if (++turn === 1) {
        yield { type: 'tool_call', call: { id: 'read', name: 'read_file', input: { path: 'a.txt' } } };
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        sawMessage = JSON.stringify(request.messages).includes('also inspect the edge case');
        yield { type: 'text', delta: 'finished' }; yield { type: 'done', stopReason: 'end_turn' };
      }
    } };
  const h = outcomeHarness(provider);
  const store = new JobStore(h.ctx.workspaceRoot);
  h.bus.on((event) => {
    if (event.type === 'subagent_start' && event.jobId) store.postMessage({ room: 'project', from: 'lead', to: event.jobId, body: 'also inspect the edge case' });
  });
  try { const result = await h.tool.run({ prompt: 'inspect fixture' }, h.ctx); assert.equal(result.ok, true); assert.equal(sawMessage, true); }
  finally { store.close(); h.close(); }
});

for (const background of [false, true]) {
  for (const stop of ['provider_error', 'max_tokens', 'fatal_tool_error'] as const) {
    test(`${background ? 'bg' : 'sync'} ${stop} reports failure before retaining partial findings`, async () => {
      const terminal: ProviderEvent[] = stop === 'provider_error'
        ? [{ type: 'error', recoverable: false, code: 'mock_failure', message: 'Mock endpoint rejected the request.' }]
        : [{ type: 'done', stopReason: stop === 'max_tokens' ? 'max_tokens' : 'tool_use' }];
      const provider = new MockProvider([
        [{ type: 'text', delta: 'I inspected the first file.' }, ...terminal],
        ...(stop === 'fatal_tool_error' ? [terminal, terminal, terminal] : []),
      ]);
      const h = outcomeHarness(provider);
      try {
        const result = await h.tool.run({ prompt: 'review', run_in_background: background }, h.ctx);
        let answer: string;
        if (background) {
          assert.equal(result.ok, true, 'the background launch itself succeeded');
          for (let n = 0; !h.events.some((e) => e.type === 'task_notification') && n < 200; n++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const notification = h.events.find((e) => e.type === 'task_notification');
          assert.ok(notification && notification.type === 'task_notification');
          answer = notification.answer;
          assert.equal(h.work.get(result.data!.taskId!)?.status, 'failed');
          assert.equal(h.work.get(result.data!.taskId!)?.finalOutput, answer);
        } else {
          assert.equal(result.ok, false);
          assert.equal(result.data?.status, 'failed');
          assert.equal(result.data?.answer, result.summary);
          answer = result.summary;
        }
        assert.match(answer, new RegExp(`^agent stopped \\(${stop}\\):`));
        assert.match(answer, /PARTIAL findings:\nI inspected the first file\./);
        if (stop === 'provider_error') assert.match(answer, /Mock endpoint rejected the request/);
        const ends = h.events.filter((e) => e.type === 'subagent_end');
        assert.equal(ends.length, 1);
        assert.equal(ends[0].ok, false);
      } finally { h.close(); }
    });
  }

  test(`${background ? 'bg' : 'sync'} truncation after tool recovery does not report a stale error`, async () => {
    const provider = new MockProvider([
      [
        { type: 'error', recoverable: true, code: 'bad_tool_json', message: 'Earlier tool arguments were invalid JSON.' },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'tool_call', call: { id: 'recovered-read', name: 'read_file', input: { path: 'demo.txt' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', delta: 'The recovered read found one issue.' },
        { type: 'done', stopReason: 'max_tokens' },
      ],
    ]);
    const h = outcomeHarness(provider);
    try {
      writeFileSync(join(h.ctx.workspaceRoot, 'demo.txt'), 'Review fixture.\n');
      const result = await h.tool.run({ prompt: 'review', run_in_background: background }, h.ctx);
      let answer: string;
      if (background) {
        assert.equal(result.ok, true, 'the background launch itself succeeded');
        for (let n = 0; !h.events.some((e) => e.type === 'task_notification') && n < 200; n++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const notification = h.events.find((e) => e.type === 'task_notification');
        assert.ok(notification && notification.type === 'task_notification');
        answer = notification.answer;
        assert.equal(h.work.get(result.data!.taskId!)?.status, 'failed');
        assert.equal(h.work.get(result.data!.taskId!)?.finalOutput, answer);
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.data?.status, 'failed');
        assert.equal(result.data?.stopReason, 'max_tokens');
        assert.equal(result.data?.answer, result.summary);
        answer = result.summary;
      }
      assert.ok(h.events.some((e) => e.type === 'error' && e.message.includes('bad_tool_json')));
      assert.ok(h.events.some((e) => e.type === 'tool_end' && e.call.id === 'recovered-read' && e.result.ok));
      assert.match(answer, /^agent stopped \(max_tokens\):.*output-token cap/);
      assert.match(answer, /PARTIAL findings:\nThe recovered read found one issue\./);
      assert.doesNotMatch(answer, /bad_tool_json|Earlier tool arguments/);
      assert.equal(h.events.find((e) => e.type === 'subagent_end')?.ok, false);
    } finally { h.close(); }
  });
}

test('sync cancellation takes precedence over provider diagnostics and retains partial findings', async () => {
  let calls = 0;
  const provider: Provider = {
    name: 'mock', estimateTokens: () => 1,
    async *send() {
      if (++calls === 1) {
        yield { type: 'text', delta: 'First finding.' };
        yield { type: 'tool_call', call: { id: 'read', name: 'read_file', input: { path: 'demo.txt' } } };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      h.controller.abort();
      yield { type: 'error', recoverable: false, code: 'aborted', message: 'request aborted downstream' };
    },
  };
  const h = outcomeHarness(provider);
  try {
    const result = await h.tool.run({ prompt: 'review' }, h.ctx);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'aborted');
    assert.equal(result.data?.status, 'cancelled');
    assert.match(result.summary, /^agent cancelled by user/);
    assert.match(result.summary, /PARTIAL findings:\nFirst finding\./);
    assert.doesNotMatch(result.summary, /provider_error|completed/);
    assert.equal(h.events.find((e) => e.type === 'subagent_end')?.ok, false);
  } finally { h.close(); }
});

test('a controlled budget stop stays a clean tool result while work remains incomplete', async () => {
  const h = outcomeHarness(new MockProvider());
  const parent = new Budget({ maxIterations: 10, maxTotalTokens: 1 }, 'mock', PRICE, Date.now());
  parent.recordUsage({ inputTokens: 1, outputTokens: 0 }, Date.now());
  try {
    const result = await h.tool.run({ prompt: 'review' }, { ...h.ctx, parentBudget: parent });
    assert.equal(result.ok, true, 'preserve the controlled-stop tool contract');
    assert.equal(result.data?.status, 'partial');
    assert.match(result.data!.answer!, /budget ceiling before producing an answer/);
    assert.equal(h.events.find((e) => e.type === 'subagent_end')?.ok, false);
  } finally { h.close(); }
});

test('diagnostic listeners are released after sync success, failure, throw, and queued cancellation', async (t) => {
  const originalOn = SubagentBus.prototype.on;
  const active = new Set<LoopListener>();
  t.mock.method(SubagentBus.prototype, 'on', function (this: SubagentBus, listener: LoopListener) {
    active.add(listener);
    const off = originalOn.call(this, listener);
    return () => { active.delete(listener); off(); };
  });
  for (const provider of [
    new MockProvider([[{ type: 'text', delta: 'Done.' }, { type: 'done', stopReason: 'end_turn' }]]),
    new MockProvider([[{ type: 'done', stopReason: 'max_tokens' }]]),
    new MockProvider([() => { throw new Error('mock threw'); }]),
  ]) {
    const h = outcomeHarness(provider);
    try { await h.tool.run({ prompt: 'review' }, h.ctx); } finally { h.close(); }
    assert.equal(active.size, 0, 'no completed invocation retains its diagnostic listener');
  }
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const h = outcomeHarness({
    name: 'mock', estimateTokens: () => 1,
    async *send() { await barrier; yield { type: 'text', delta: 'Done.' }; yield { type: 'done', stopReason: 'end_turn' }; },
  }, 10, 1);
  const queued = new AbortController();
  const first = h.tool.run({ prompt: 'first' }, h.ctx);
  try {
    const second = h.tool.run({ prompt: 'second' }, { ...h.ctx, signal: queued.signal });
    queued.abort();
    const result = await second;
    assert.equal(result.ok, false);
    assert.equal(active.size, 1, 'only the running first agent still listens');
    release();
    await first;
    assert.equal(active.size, 0);
  } finally { release(); await first; h.close(); }
});
