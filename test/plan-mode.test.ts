import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CompletionRequest, Provider, ProviderEvent, ToolCall } from '../src/provider/provider.js';
import type { Tool, ToolContext, ToolResult } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { PlanModeState } from '../src/agent/planMode.js';
import { makeEnterPlanModeTool, makeExitPlanModeTool, makePlanWriteTool } from '../src/tools/index.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { AutoApproveGate, AutoDenyGate, ScriptedApprovalGate, type ApprovalGate } from '../src/agent/approval.js';
import { z } from 'zod';

function makeWorkspace(): string {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'plan-mode-'));
}

function scriptedProvider(turns: ProviderEvent[][]): Provider & { systems: string[] } {
  const queue = [...turns];
  const systems: string[] = [];
  return {
    name: 'scripted',
    systems,
    async *send(req: CompletionRequest) {
      systems.push(req.system);
      for (const ev of queue.shift() ?? [{ type: 'done', stopReason: 'end_turn' }]) yield ev;
    },
    estimateTokens() {
      return 1;
    },
  };
}

function simpleTool(name: string, risk: Tool['risk']): Tool<Record<string, never>, { ran: string }> {
  return {
    name,
    description: `${name} test tool`,
    risk,
    inputSchema: z.object({}),
    async run(_input: Record<string, never>, _ctx: ToolContext): Promise<ToolResult<{ ran: string }>> {
      return ok(name, risk, 1, `${name} ran`, { ran: name });
    },
  };
}

function memoryProbeTool(): Tool<{ action: 'recall' | 'list' | 'remember' }, { action: string }> {
  return {
    name: 'memory',
    description: 'memory probe',
    risk: 'write',
    inputSchema: z.object({ action: z.enum(['recall', 'list', 'remember']) }),
    async run(input): Promise<ToolResult<{ action: string }>> {
      return ok('memory', 'write', 1, `memory ${input.action} ran`, { action: input.action });
    },
  };
}

function buildLoop(
  provider: Provider,
  registry: ToolRegistry,
  planMode: PlanModeState,
  workspaceRoot: string,
  gate: ApprovalGate = new AutoApproveGate(),
): { loop: AgentLoop; events: LoopEvent[] } {
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'do the task' }] });
  const deps: LoopDeps = {
    provider,
    registry,
    gate,
    bus,
    budget: new Budget({ maxIterations: 8 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
    context,
    signal: new AbortController().signal,
    model: 'mock',
    system: 'base',
    maxOutputTokens: 1024,
    workspaceRoot,
    dryRun: false,
    maxToolResultChars: 16_384,
    contextBudget: 1_000_000,
    planMode,
  };
  return { loop: new AgentLoop(deps, 'full'), events };
}

test('plan mode blocks write tools but allows read tools', async () => {
  const workspace = makeWorkspace();
  try {
    const registry = new ToolRegistry();
    registry.register(simpleTool('read_probe', 'read'));
    registry.register(simpleTool('write_probe', 'write'));
    const planMode = new PlanModeState(true);
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'r', name: 'read_probe', input: {} } },
        { type: 'tool_call', call: { id: 'w', name: 'write_probe', input: {} } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'done', stopReason: 'end_turn' }],
    ]);
    const { loop, events } = buildLoop(provider, registry, planMode, workspace);
    await loop.run();

    const toolEnds = events.filter((e): e is Extract<LoopEvent, { type: 'tool_end' }> => e.type === 'tool_end');
    const denied = events.filter((e): e is Extract<LoopEvent, { type: 'tool_denied' }> => e.type === 'tool_denied');
    assert.equal(toolEnds.some((e) => e.call.name === 'read_probe' && e.result.ok), true);
    assert.equal(toolEnds.some((e) => e.call.name === 'write_probe'), false);
    assert.match(denied.find((e) => e.call.name === 'write_probe')?.reason ?? '', /plan mode blocks write/);
    assert.match(provider.systems[0] ?? '', /## Plan mode/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('plan_write is allowed in plan mode and exit_plan_mode approval enables writes', async () => {
  const workspace = makeWorkspace();
  try {
    const registry = new ToolRegistry();
    const planMode = new PlanModeState(true);
    registry.register(makePlanWriteTool(planMode));
    registry.register(makeExitPlanModeTool(planMode, { persist: false }));
    registry.register(simpleTool('write_probe', 'write'));
    const calls: ToolCall[] = [
      { id: 'plan', name: 'plan_write', input: { title: 'Demo Plan', body: '- inspect\n- edit\n- test' } },
      { id: 'exit', name: 'exit_plan_mode', input: {} },
      { id: 'write', name: 'write_probe', input: {} },
    ];
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: calls[0]! },
        { type: 'tool_call', call: calls[1]! },
        { type: 'tool_call', call: calls[2]! },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'done', stopReason: 'end_turn' }],
    ]);
    const { loop, events } = buildLoop(provider, registry, planMode, workspace, new ScriptedApprovalGate(['approve']));
    await loop.run();

    assert.equal(planMode.snapshot().mode, 'implement');
    const toolEnds = events.filter((e): e is Extract<LoopEvent, { type: 'tool_end' }> => e.type === 'tool_end');
    assert.equal(toolEnds.some((e) => e.call.name === 'plan_write' && e.result.ok), true);
    assert.equal(toolEnds.some((e) => e.call.name === 'exit_plan_mode' && e.result.ok), true);
    assert.equal(toolEnds.some((e) => e.call.name === 'write_probe' && e.result.ok), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('plan_write bypasses normal write approval while planning', async () => {
  const workspace = makeWorkspace();
  try {
    const registry = new ToolRegistry();
    const planMode = new PlanModeState(true);
    registry.register(makePlanWriteTool(planMode));
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'plan', name: 'plan_write', input: { title: 'Deny Gate Plan', body: '- inspect' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'done', stopReason: 'end_turn' }],
    ]);
    const { loop, events } = buildLoop(provider, registry, planMode, workspace, new AutoDenyGate());
    await loop.run();

    assert.equal(planMode.snapshot().mode, 'planning');
    assert.match(planMode.snapshot().path ?? '', /deny-gate-plan\.md$/);
    const toolEnds = events.filter((e): e is Extract<LoopEvent, { type: 'tool_end' }> => e.type === 'tool_end');
    const denied = events.filter((e): e is Extract<LoopEvent, { type: 'tool_denied' }> => e.type === 'tool_denied');
    assert.equal(toolEnds.some((e) => e.call.name === 'plan_write' && e.result.ok), true);
    assert.equal(denied.some((e) => e.call.name === 'plan_write'), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('enter_plan_mode requires approval then activates plan mode', async () => {
  const workspace = makeWorkspace();
  try {
    const registry = new ToolRegistry();
    const planMode = new PlanModeState(false);
    registry.register(makeEnterPlanModeTool(planMode));
    registry.register(simpleTool('write_probe', 'write'));
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'enter', name: 'enter_plan_mode', input: { reason: 'big refactor' } } },
        { type: 'tool_call', call: { id: 'w', name: 'write_probe', input: {} } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'done', stopReason: 'end_turn' }],
    ]);
    const { loop, events } = buildLoop(provider, registry, planMode, workspace, new ScriptedApprovalGate(['approve']));
    await loop.run();

    assert.equal(planMode.active, true);
    const denied = events.filter((e): e is Extract<LoopEvent, { type: 'tool_denied' }> => e.type === 'tool_denied');
    assert.match(denied.find((e) => e.call.name === 'write_probe')?.reason ?? '', /plan mode blocks write/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('enter_plan_mode denied leaves implement mode', async () => {
  const workspace = makeWorkspace();
  try {
    const registry = new ToolRegistry();
    const planMode = new PlanModeState(false);
    registry.register(makeEnterPlanModeTool(planMode));
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'enter', name: 'enter_plan_mode', input: { reason: 'nope' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'done', stopReason: 'end_turn' }],
    ]);
    const { loop, events } = buildLoop(provider, registry, planMode, workspace, new ScriptedApprovalGate(['deny']));
    await loop.run();

    assert.equal(planMode.active, false);
    assert.ok(events.some((e) => e.type === 'tool_denied' && e.reason === 'plan enter denied by user'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('plan mode allows read-like memory actions but blocks memory writes', async () => {
  const workspace = makeWorkspace();
  try {
    const registry = new ToolRegistry();
    registry.register(memoryProbeTool());
    const planMode = new PlanModeState(true);
    const provider = scriptedProvider([
      [
        { type: 'tool_call', call: { id: 'recall', name: 'memory', input: { action: 'recall' } } },
        { type: 'tool_call', call: { id: 'list', name: 'memory', input: { action: 'list' } } },
        { type: 'tool_call', call: { id: 'remember', name: 'memory', input: { action: 'remember' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'done', stopReason: 'end_turn' }],
    ]);
    const { loop, events } = buildLoop(provider, registry, planMode, workspace, new AutoDenyGate());
    await loop.run();

    const toolEnds = events.filter((e): e is Extract<LoopEvent, { type: 'tool_end' }> => e.type === 'tool_end');
    const denied = events.filter((e): e is Extract<LoopEvent, { type: 'tool_denied' }> => e.type === 'tool_denied');
    assert.equal(toolEnds.some((e) => e.call.id === 'recall' && e.result.ok), true);
    assert.equal(toolEnds.some((e) => e.call.id === 'list' && e.result.ok), true);
    assert.equal(toolEnds.some((e) => e.call.id === 'remember'), false);
    assert.match(denied.find((e) => e.call.id === 'remember')?.reason ?? '', /plan mode blocks write/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
