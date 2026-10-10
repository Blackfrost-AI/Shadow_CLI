import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  buildEnvBlock,
  capabilityAwareFactsIndex,
  capabilityAwareSkillsIndex,
  sessionControlCapabilityIssue,
} from '../src/agent/bootstrap.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { MissionState } from '../src/agent/mission.js';
import { PlanModeState } from '../src/agent/planMode.js';
import { TodoList } from '../src/agent/todo.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { expandHarnessToolRemovals } from '../src/harness/resolver.js';
import type { CompletionRequest, Provider, ProviderEvent } from '../src/provider/provider.js';
import type { SkillEntry } from '../src/skills/loader.js';
import { promptCapabilitiesWithout, resolveSystem } from '../src/system/resolveSystem.js';
import { makePlanWriteTool } from '../src/tools/planModeTools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { makeTodoTool } from '../src/tools/todo.js';

const INSTALL_DIR = new URL('..', import.meta.url).pathname;

test('plan control subtraction closes model entry and cannot create a deadlocked plan state', () => {
  assert.deepEqual(
    expandHarnessToolRemovals(['plan_write']),
    ['plan_write', 'enter_plan_mode'],
  );
  assert.deepEqual(
    expandHarnessToolRemovals(['exit_plan_mode']),
    ['exit_plan_mode', 'enter_plan_mode'],
  );

  const capabilities = promptCapabilitiesWithout(['plan_write']);
  const plan = new PlanModeState(false, capabilities);
  assert.equal(plan.available, false);
  assert.match(plan.unavailableReason ?? '', /plan_write/);
  assert.equal(plan.enter().mode, 'implement', 'a user-facing toggle cannot enter an impossible mode');
  assert.throws(() => new PlanModeState(true, capabilities), /plan mode requires available controls/);
  assert.throws(() => plan.restore({ mode: 'planning' }), /cannot restore active plan mode/);
});

test('active procedural, restored plan, and mission state fail closed before bootstrap can proceed', () => {
  const noExit = promptCapabilitiesWithout(['exit_plan_mode']);
  assert.match(
    sessionControlCapabilityIssue({ capabilities: noExit, initialPlanMode: true }) ?? '',
    /active plan mode.*exit_plan_mode/,
  );
  assert.equal(
    sessionControlCapabilityIssue({ capabilities: noExit, initialPlanMode: false }),
    undefined,
    'an inactive session may subtract plan controls because later entry is disabled',
  );

  const mission = new MissionState();
  mission.begin('resume me');
  mission.onPlanApproved({ tasks: ['verify'] });
  const resumed = {
    version: 1 as const,
    mission: mission.snapshot(),
    plan: { mode: 'implement' as const },
    todos: [],
  };
  assert.match(
    sessionControlCapabilityIssue({
      capabilities: promptCapabilitiesWithout(['mission_update']),
      initialPlanMode: false,
      resumedState: resumed,
    }) ?? '',
    /active mission.*mission_update/,
  );
  mission.setPhase('done');
  assert.equal(
    sessionControlCapabilityIssue({
      capabilities: promptCapabilitiesWithout(['mission_update']),
      initialPlanMode: false,
      resumedState: { ...resumed, mission: mission.snapshot() },
    }),
    undefined,
    'a terminal mission is read-only and does not need mission_update to resume',
  );
});

test('dynamic plan and mission blocks never recommend tools hidden from the effective registry', () => {
  const plan = new PlanModeState(true);
  const planBlock = plan.block(promptCapabilitiesWithout(['run_shell', 'web_fetch']));
  assert.doesNotMatch(planBlock, /\brun_shell\b|\bweb_fetch\b/);
  assert.match(planBlock, /plan_write/);
  assert.match(planBlock, /exit_plan_mode/);

  const planningMission = new MissionState();
  planningMission.begin('bounded plan');
  const planningBlock = planningMission.block(
    promptCapabilitiesWithout(['plan_write', 'exit_plan_mode']),
  );
  assert.doesNotMatch(planningBlock, /\bplan_write\b|\bexit_plan_mode\b/);
  assert.match(planningBlock, /required plan controls are unavailable/);

  const executingMission = new MissionState();
  executingMission.begin('bounded execution');
  executingMission.onPlanApproved({ tasks: ['one'] });
  const executingBlock = executingMission.block(
    promptCapabilitiesWithout(['agent', 'mission_update']),
  );
  assert.doesNotMatch(executingBlock, /\bmission_update\b|sub-agents?/i);
  assert.match(executingBlock, /read-only/);
  const noDelegationBlock = executingMission.block(promptCapabilitiesWithout(['agent']));
  assert.doesNotMatch(noDelegationBlock, /sub-agents?/i);
  assert.match(noDelegationBlock, /mission_update/);
});

test('default dynamic control blocks retain their previous bytes', () => {
  assert.equal(
    new PlanModeState(true).block(),
    '\n\n## Plan mode\n' +
      'You are currently in plan mode. Explore and read freely, write or update the plan with plan_write, then call exit_plan_mode when the plan is ready for user approval.\n' +
      'Do not call write_file, edit_file, run_shell, web_fetch, or web_search until plan mode exits.\n',
  );
});

test('removed skill capability suppresses the injected skills index', () => {
  const skills: SkillEntry[] = [{
    name: 'fixture',
    path: '/trusted/fixture/SKILL.md',
    root: '/trusted',
    body: '# Fixture',
    description: 'FIXTURE_SKILL_INDEX_MARKER',
    source: 'harness',
  }];
  assert.match(capabilityAwareSkillsIndex(skills), /FIXTURESKILLINDEXMARKER/);
  assert.equal(
    capabilityAwareSkillsIndex(skills, promptCapabilitiesWithout(['skill'])),
    '',
  );
  assert.equal(capabilityAwareFactsIndex('FACT_MARKER'), 'FACT_MARKER');
  assert.equal(
    capabilityAwareFactsIndex('FACT_MARKER', promptCapabilitiesWithout(['memory'])),
    '',
  );
});

test('model profile and tool schema omit hidden view and mission-update guidance', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-capability-controls-'));
  const prompt = resolveSystem(home, {
    installDir: INSTALL_DIR,
    homedir: home,
    model: 'Lumix-4B',
    capabilities: promptCapabilitiesWithout(['view_image']),
  });
  assert.doesNotMatch(prompt, /\bview_image\b/);
  assert.match(prompt, /Long context \(256K\)/);

  const schema = zodToJsonSchema(
    makePlanWriteTool(new PlanModeState(), { missionUpdatesAvailable: false }).inputSchema,
    { $refStrategy: 'none' },
  );
  assert.doesNotMatch(JSON.stringify(schema), /mission_update/);
});

async function systemWithTodoCapability(removed: boolean): Promise<string> {
  const todo = new TodoList();
  todo.write([{ subject: 'CAPABILITY_TODO_MARKER', status: 'in_progress' }]);
  const registry = new ToolRegistry();
  registry.register(makeTodoTool(todo));
  if (removed) registry.setDenied(['todo_write']);
  let seen = '';
  const provider: Provider = {
    name: 'capture-system',
    estimateTokens: () => 1,
    async *send(request: CompletionRequest): AsyncIterable<ProviderEvent> {
      seen = request.system;
      yield { type: 'text', delta: 'done' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const context = new Context({ contextBudget: 100_000, triggerRatio: 0.8, keepLastTurns: 4 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'render state' }] });
  const deps: LoopDeps = {
    provider,
    registry,
    gate: new AutoApproveGate(),
    bus: new EventBus(),
    budget: new Budget({ maxIterations: 2 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
    context,
    signal: new AbortController().signal,
    model: 'mock',
    system: 'base',
    maxOutputTokens: 128,
    workspaceRoot: process.cwd(),
    dryRun: false,
    maxToolResultChars: 4_096,
    contextBudget: 100_000,
    todoList: todo,
  };
  await new AgentLoop(deps, 'full').run();
  return seen;
}

test('live todo state is not injected when todo_write is removed', async () => {
  assert.match(await systemWithTodoCapability(false), /CAPABILITY_TODO_MARKER/);
  assert.doesNotMatch(await systemWithTodoCapability(true), /CAPABILITY_TODO_MARKER|\btodo_write\b/);
});

test('default environment remains identical under an unrestricted explicit capability view', () => {
  const normalize = (value: string): string => value.replace(/^- date: .*$/m, '- date: <dynamic>');
  assert.equal(
    normalize(buildEnvBlock('/workspace')),
    normalize(buildEnvBlock('/workspace', [], {}, promptCapabilitiesWithout([]))),
  );
});
