import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'dist/index.js');

test('headless --task --provider mock exits non-zero with provider_error when SHADOW_MOCK_ERROR=1', () => {
  const r = spawnSync(process.execPath, [CLI, '--task', 'x', '--provider', 'mock'], {
    cwd: ROOT,
    env: { ...process.env, SHADOW_MOCK_ERROR: '1', SHADOW_PROVIDER: 'mock' },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, 'headless error-class stop must exit non-zero');
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  assert.match(out, /provider_error|stopped/i, `expected stop visibility, got: ${out}`);
  assert.match(out, /mock_provider_error/i);
});

test('attachRenderer stop path: loop returns provider_error stopReason', async () => {
  const { MockProvider } = await import('../src/provider/mock.js');
  const { AgentLoop } = await import('../src/agent/loop.js');
  const { EventBus } = await import('../src/agent/events.js');
  const { Context } = await import('../src/agent/context.js');
  const { Budget } = await import('../src/agent/budget.js');
  const { ToolRegistry } = await import('../src/tools/registry.js');
  const { AutoApproveGate } = await import('../src/agent/approval.js');

  const provider = new MockProvider([
    [
      { type: 'error', recoverable: true, code: 'provider_stream_error', message: 'auth failed' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const context = new Context({ contextBudget: 10_000, triggerRatio: 0.75, keepLastTurns: 4 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
  const bus = new EventBus();
  const stops: string[] = [];
  bus.on((e) => {
    if (e.type === 'stop') stops.push(e.reason);
  });
  const registry = new ToolRegistry();
  const loop = new AgentLoop(
    {
      provider,
      registry,
      gate: new AutoApproveGate(),
      bus,
      budget: new Budget({ maxIterations: 2 }, 'mock', { mock: { input: 0, output: 0 } }, Date.now()),
      context,
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 100,
      workspaceRoot: ROOT,
      dryRun: false,
      maxToolResultChars: 1000,
      contextBudget: 10_000,
    },
    'full',
  );
  const result = await loop.run();
  assert.equal(result.stopReason, 'provider_error');
  assert.ok(stops.includes('provider_error'));
});