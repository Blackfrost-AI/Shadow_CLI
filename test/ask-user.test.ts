import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderEvent } from '../src/provider/provider.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import { makeAskUserQuestionTool } from '../src/tools/askUser.js';

function makeWorkspace(): string {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'ask-user-'));
}

function scriptedProvider(turns: ProviderEvent[][]): { send: (req: unknown) => AsyncGenerator<ProviderEvent> } {
  const queue = [...turns];
  return {
    async *send() {
      for (const ev of queue.shift() ?? [{ type: 'done', stopReason: 'end_turn' }]) yield ev;
    },
  };
}

test('ask_user_question returns gate answers to the model', async () => {
  const workspace = makeWorkspace();
  try {
    const registry = new ToolRegistry();
    registry.register(makeAskUserQuestionTool());
    const bus = new EventBus();
    const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
    context.pinTask({ role: 'user', content: [{ type: 'text', text: 'pick' }] });
    const deps: LoopDeps = {
      provider: scriptedProvider([
        [
          {
            type: 'tool_call',
            call: {
              id: 'q1',
              name: 'ask_user_question',
              input: {
                questions: [
                  {
                    question: 'Which target?',
                    options: [{ label: 'A' }, { label: 'B' }],
                  },
                ],
              },
            },
          },
          { type: 'done', stopReason: 'tool_use' },
        ],
        [{ type: 'done', stopReason: 'end_turn' }],
      ]) as unknown as LoopDeps['provider'],
      registry,
      gate: new ScriptedApprovalGate([
        { answers: [{ question: 'Which target?', selected: ['B'] }] },
      ]),
      bus,
      budget: new Budget({ maxIterations: 4 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
      context,
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 1024,
      workspaceRoot: workspace,
      dryRun: false,
      maxToolResultChars: 16_384,
      contextBudget: 1_000_000,
    };
    await new AgentLoop(deps, 'full').run();
    const blocks = context.messages().flatMap((m) => m.content);
    const toolResult = blocks.find((b) => b.type === 'tool_result' && b.toolCallId === 'q1');
    assert.ok(toolResult && toolResult.type === 'tool_result');
    assert.match(toolResult.content, /"selected":\s*\[\s*"B"\s*\]/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('ask_user_question deny is recoverable', async () => {
  const workspace = makeWorkspace();
  try {
    const registry = new ToolRegistry();
    registry.register(makeAskUserQuestionTool());
    const events: Array<{ type: string; reason?: string }> = [];
    const bus = new EventBus();
    bus.on((e) => events.push(e));
    const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
    context.pinTask({ role: 'user', content: [{ type: 'text', text: 'pick' }] });
    const deps: LoopDeps = {
      provider: scriptedProvider([
        [
          {
            type: 'tool_call',
            call: {
              id: 'q1',
              name: 'ask_user_question',
              input: {
                questions: [{ question: 'Go?', options: [{ label: 'yes' }, { label: 'no' }] }],
              },
            },
          },
          { type: 'done', stopReason: 'tool_use' },
        ],
        [{ type: 'done', stopReason: 'end_turn' }],
      ]) as unknown as LoopDeps['provider'],
      registry,
      gate: new ScriptedApprovalGate(['deny']),
      bus,
      budget: new Budget({ maxIterations: 4 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
      context,
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 1024,
      workspaceRoot: workspace,
      dryRun: false,
      maxToolResultChars: 16_384,
      contextBudget: 1_000_000,
    };
    await new AgentLoop(deps, 'full').run();
    assert.ok(events.some((e) => e.type === 'tool_denied' && e.reason === 'user declined to answer'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});