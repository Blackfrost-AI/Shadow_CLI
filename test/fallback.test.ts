import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFallbackEligible, resolveFallbackModel } from '../src/provider/fallback.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { AutoApproveGate } from '../src/agent/approval.js';

test('isFallbackEligible recognizes overloaded and http 529', () => {
  assert.equal(isFallbackEligible('overloaded', 'model overloaded'), true);
  assert.equal(isFallbackEligible('http_529', 'overloaded', 529), true);
  assert.equal(isFallbackEligible('http_400', 'bad request', 400), false);
});

test('resolveFallbackModel prefers per-entry fallback then global', () => {
  const entries = [
    { label: 'a', provider: 'mock' as const, model: 'model-a', fallback: 'model-b' },
    { label: 'b', provider: 'mock' as const, model: 'model-b' },
  ];
  assert.equal(resolveFallbackModel('model-a', entries, 'model-c'), 'model-b');
  assert.equal(resolveFallbackModel('model-x', entries, 'model-c'), 'model-c');
});

test('loop swaps model on fallback-eligible provider error', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const workspace = mkdtempSync(join(root, 'fallback-'));
  try {
    let modelUsed = '';
    const provider = {
      name: 'flaky',
      estimateTokens: () => 1,
      async *send(req: { model: string }) {
        modelUsed = req.model;
        if (req.model === 'primary') {
          yield { type: 'error', recoverable: true, code: 'http_529', message: 'overloaded' };
          return;
        }
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const events: LoopEvent[] = [];
    const bus = new EventBus();
    bus.on((e) => events.push(e));
    const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
    context.pinTask({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    const deps: LoopDeps = {
      provider: provider as LoopDeps['provider'],
      registry: new ToolRegistry(),
      gate: new AutoApproveGate(),
      bus,
      budget: new Budget({ maxIterations: 2 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
      context,
      signal: new AbortController().signal,
      model: 'primary',
      system: 'test',
      maxOutputTokens: 1024,
      workspaceRoot: workspace,
      dryRun: false,
      maxToolResultChars: 16_384,
      contextBudget: 1_000_000,
      models: [{ label: 'p', provider: 'mock', model: 'primary', fallback: 'backup' }],
      fallbackModel: 'backup',
    };
    await new AgentLoop(deps, 'full').run();
    assert.equal(modelUsed, 'backup');
    assert.ok(events.some((e) => e.type === 'model_fallback' && e.to === 'backup'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});