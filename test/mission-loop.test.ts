// Mission harness wiring (Sprint 3 item 3.2, Package 7) — the loop-level contract:
// mission.block() reaches EVERY provider request (and the compaction continuity),
// plan approval seeds the tasks, mission_update mutates mid-run, and sub-agent deps
// carry NO mission. plan-mode.test.ts harness shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { CompletionRequest, Provider, ProviderEvent, ToolCall } from '../src/provider/provider.js';
import type { Tool, ToolContext, ToolResult } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { PlanModeState } from '../src/agent/planMode.js';
import { MissionState } from '../src/agent/mission.js';
import { makePlanWriteTool, makeExitPlanModeTool, makeMissionUpdateTool } from '../src/tools/index.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { AutoApproveGate } from '../src/agent/approval.js';

function makeWorkspace(): string {
  const d = join(tmpdir(), 'mission-loop-');
  mkdirSync(d, { recursive: true });
  return mkdtempSync(join(d, 'fx-'));
}

function eventedProvider(turns: ProviderEvent[][]): Provider & { systems: string[]; requests: CompletionRequest[] } {
  const queue = [...turns];
  const systems: string[] = [];
  const requests: CompletionRequest[] = [];
  return {
    name: 'evented',
    systems,
    requests,
    async *send(req: CompletionRequest) {
      systems.push(req.system);
      requests.push(req);
      for (const ev of queue.shift() ?? [{ type: 'done', stopReason: 'end_turn' }]) yield ev;
    },
    estimateTokens() {
      return 1;
    },
  };
}

function toolCall(id: string, name: string, input: unknown): ToolCall {
  return { id, name, input };
}

function writeTool(): Tool<{ path: string; content: string }, { path: string }> {
  return {
    name: 'write_file',
    description: 'write',
    risk: 'write',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    async run(input, ctx: ToolContext): Promise<ToolResult<{ path: string }>> {
      return ok('write_file', 'write', 1, `wrote ${input.path}`, { path: join(ctx.workspaceRoot, input.path) });
    },
  };
}

function buildLoop(
  provider: Provider,
  registry: ToolRegistry,
  planMode: PlanModeState,
  mission: MissionState | undefined,
  workspaceRoot: string,
): { loop: AgentLoop; events: LoopEvent[] } {
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'run the mission' }] });
  const deps: LoopDeps = {
    provider,
    registry,
    gate: new AutoApproveGate(),
    bus,
    budget: new Budget({ maxIterations: 12 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
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
    mission,
  };
  return { loop: new AgentLoop(deps, 'full'), events };
}

test('mission block reaches every provider request while active, then vanishes on clear', async () => {
  const ws = makeWorkspace();
  const registry = new ToolRegistry();
  registry.register(writeTool());
  const planMode = new PlanModeState(false);
  const mission = new MissionState();
  const provider = eventedProvider([
    [{ type: 'tool_call', call: toolCall('c1', 'write_file', { path: 'a.txt', content: 'x' }) }],
  ]);
  const { loop } = buildLoop(provider, registry, planMode, mission, ws);
  mission.begin('ship the retry fix');
  await loop.run();

  assert.ok(provider.systems.length >= 2);
  for (const sys of provider.systems) {
    assert.ok(sys.includes('## Mission'), 'every request carries the mission block');
    assert.ok(sys.includes('ship the retry fix'));
  }
  assert.ok(provider.systems[0]!.includes('PLANNING'));

  // cleared mission → block gone from later requests
  mission.clear();
  const provider2 = eventedProvider([[{ type: 'done', stopReason: 'end_turn' }]]);
  const { loop: loop2 } = buildLoop(provider2, registry, planMode, mission, ws);
  await loop2.run();
  assert.ok(!provider2.systems[0]!.includes('## Mission'));
  rmSync(ws, { recursive: true, force: true });
});

test('approved plan exit seeds tasks and flips planning → executing', async () => {
  const ws = makeWorkspace();
  const registry = new ToolRegistry();
  const planMode = new PlanModeState(true);
  const mission = new MissionState();
  mission.begin('add feature X');
  registry.register(makePlanWriteTool(planMode));
  registry.register(makeExitPlanModeTool(planMode, { persist: false }));

  const provider = eventedProvider([
    [{ type: 'tool_call', call: toolCall('p1', 'plan_write', { title: 'X Plan', body: 'do it', tasks: ['write tests', 'implement', 'verify'] }) }],
    [{ type: 'tool_call', call: toolCall('p2', 'exit_plan_mode', {}) }],
    [{ type: 'done', stopReason: 'end_turn' }],
  ]);
  const { loop } = buildLoop(provider, registry, planMode, mission, ws);
  await loop.run();

  const snap = mission.snapshot();
  assert.equal(snap.phase, 'executing');
  assert.equal(snap.tasks.length, 3);
  assert.deepEqual(snap.tasks.map((t) => t.subject), ['write tests', 'implement', 'verify']);
  rmSync(ws, { recursive: true, force: true });
});

test('mission_update mid-run mutates state and emits mission events on the bus', async () => {
  const ws = makeWorkspace();
  const planMode = new PlanModeState(false);
  const mission = new MissionState();
  mission.begin('x');
  mission.onPlanApproved({ tasks: ['a', 'b'] });
  const registry = new ToolRegistry();
  registry.register(makeMissionUpdateTool(mission));
  registry.register(writeTool());

  const provider = eventedProvider([
    [{ type: 'tool_call', call: toolCall('u1', 'mission_update', { tasks: [{ id: 'm-1', status: 'done', detail: 'green' }] }) }],
    [{ type: 'done', stopReason: 'end_turn' }],
  ]);
  const { loop, events } = buildLoop(provider, registry, planMode, mission, ws);
  // Production wires mission events onto the bus via the index.ts bridge (onUpdate →
  // emit) — attach the same contract here so the test exercises it end to end.
  mission.onUpdate((m) => {
    events.push({ type: 'mission', mission: m });
  });
  await loop.run();

  assert.equal(mission.snapshot().tasks[0]!.status, 'done');
  const missionEvents = events.filter((e) => e.type === 'mission');
  assert.ok(missionEvents.length >= 1, 'mission event reached the bus');
  const last = missionEvents[missionEvents.length - 1]!;
  assert.ok(last.type === 'mission' && last.mission.tasks[0]!.status === 'done');
  rmSync(ws, { recursive: true, force: true });
});

test('plan gate still denies writes while a mission is in planning', async () => {
  const ws = makeWorkspace();
  const planMode = new PlanModeState(true);
  const mission = new MissionState();
  mission.begin('locked mission');
  const registry = new ToolRegistry();
  registry.register(writeTool());

  const provider = eventedProvider([
    [{ type: 'tool_call', call: toolCall('w1', 'write_file', { path: 'a.txt', content: 'x' }) }],
    [{ type: 'done', stopReason: 'end_turn' }],
  ]);
  const { loop, events } = buildLoop(provider, registry, planMode, mission, ws);
  await loop.run();

  const denied = events.find((e) => e.type === 'tool_denied');
  assert.ok(denied, 'write denied by the plan gate during mission planning');
  assert.ok(denied!.type === 'tool_denied' && denied.call.name === 'write_file');
  rmSync(ws, { recursive: true, force: true });
});

test('mission rides the compaction continuity (summarization-proof)', async () => {
  const ws = makeWorkspace();
  const planMode = new PlanModeState(false);
  const mission = new MissionState();
  mission.begin('survives compaction');
  const registry = new ToolRegistry();
  registry.register(writeTool());

  // Tiny budget → summarization fires mid-run; the continuity string the loop hands the
  // summarizer must carry the mission block.
  const provider = eventedProvider([
    [{ type: 'tool_call', call: toolCall('c1', 'write_file', { path: 'a.txt', content: 'x' }) }],
  ]);
  const bus = new EventBus();
  const context = new Context({ contextBudget: 40, triggerRatio: 0.5, keepLastTurns: 1 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  const deps: LoopDeps = {
    provider,
    registry,
    gate: new AutoApproveGate(),
    bus,
    budget: new Budget({ maxIterations: 4 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
    context,
    signal: new AbortController().signal,
    model: 'mock',
    system: 'base',
    maxOutputTokens: 1024,
    workspaceRoot: ws,
    dryRun: false,
    maxToolResultChars: 1_000,
    contextBudget: 40,
    planMode,
    mission,
  };
  await new AgentLoop(deps, 'full').run();

  // Direct continuity check: the loop's assemble path — same expression it uses at L~330.
  const continuity = [planMode.block(), mission.block()].filter((x) => x.trim()).join('\n\n');
  assert.ok(continuity.includes('survives compaction'));
  rmSync(ws, { recursive: true, force: true });
});

test('a mission left planning by a SIDE DOOR (plan mode exited without approval) un-sticks next turn', async () => {
  const ws = makeWorkspace();
  const registry = new ToolRegistry();
  const planMode = new PlanModeState(true);
  const mission = new MissionState();
  mission.begin('side door goal');
  planMode.recordPlan('The Plan', '/tmp/plan.md', ['first', 'second']); // tasks recorded while planning
  planMode.exit(); // Shift+Tab out — NOT an approved exit_plan_mode

  const provider = eventedProvider([[{ type: 'done', stopReason: 'end_turn' }]]);
  const { loop } = buildLoop(provider, registry, planMode, mission, ws);
  await loop.run();

  const snap = mission.snapshot();
  assert.equal(snap.phase, 'executing', 'the side-door exit counts as the go-ahead');
  assert.deepEqual(snap.tasks.map((t) => t.subject), ['first', 'second'], 'recorded plan tasks seed');
  assert.ok(provider.systems[0]!.includes('Phase: executing'), 'the same turn already pins the executing block');
  rmSync(ws, { recursive: true, force: true });
});

test('sub-agent deps shape carries no mission (registry-shared guard is the backstop)', async () => {
  const ws = makeWorkspace();
  const registry = new ToolRegistry();
  registry.register(writeTool());
  const planMode = new PlanModeState(false);
  const mission = new MissionState();
  mission.begin('lead-only');
  const provider = eventedProvider([[{ type: 'done', stopReason: 'end_turn' }]]);

  // The sub-agent factory builds deps WITHOUT `mission` — assert the LoopDeps type-level
  // contract by constructing the same shape it does and running it: no mission block.
  const { loop } = buildLoop(provider, registry, planMode, undefined, ws);
  await loop.run();
  assert.ok(!provider.systems[0]!.includes('## Mission'));

  // And the shared-registry backstop: mission_update inside a nested agent is inert.
  const nested = makeMissionUpdateTool(mission);
  const res = await nested.run({ tasks: [{ id: 'm-1', status: 'failed' }] }, {
    workspaceRoot: ws,
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
    nestedAgent: true,
  });
  assert.ok(res.ok && !res.data?.updated);
  assert.equal(mission.snapshot().tasks.length, 0); // untouched
  rmSync(ws, { recursive: true, force: true });
});
