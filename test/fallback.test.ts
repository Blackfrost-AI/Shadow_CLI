import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFallbackEligible, resolveFallbackModel, resolveFallbackEntry } from '../src/provider/fallback.js';
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

test('isFallbackEligible: stall-class codes are NOT eligible despite "overloaded" in the message', () => {
  // F01-02: the P1A-04 idle message literally says "may be overloaded"; must still NOT fall back.
  assert.equal(
    isFallbackEligible('idle_timeout', 'no response within 120s — the model may be overloaded or the connection stalled'),
    false,
  );
  assert.equal(isFallbackEligible('network_error', 'socket hang up'), false);
  assert.equal(isFallbackEligible('empty_body', 'provider returned no response body'), false);
  assert.equal(isFallbackEligible('stream_error', 'parse failed mid-stream'), false);
  // Genuine unavailability / overload remains eligible.
  assert.equal(isFallbackEligible('overloaded', 'model overloaded'), true);
  assert.equal(isFallbackEligible('server_error', 'internal error'), true);
  assert.equal(isFallbackEligible('http_529', 'overloaded', 529), true);
  assert.equal(isFallbackEligible('http_503', 'unavailable', 503), true);
  assert.equal(isFallbackEligible('http_502', 'bad gateway', 502), true);
  assert.equal(isFallbackEligible('model_not_found', 'model not found: x'), true);
  assert.equal(isFallbackEligible('http_400', 'permission denied', 400), true);
});

test('resolveFallbackEntry: selfHosted source requires explicit per-entry fallback opt-in', () => {
  const entries = [
    { label: 'local', provider: 'mock' as const, model: 'local', selfHosted: true },
    { label: 'cloud', provider: 'mock' as const, model: 'cloud' },
  ];
  // No per-entry fallback -> stays local even with a cloud alternative AND a global fallback set.
  assert.equal(resolveFallbackEntry('local', entries, 'cloud'), null);
  // With an explicit per-entry fallback -> switches.
  const withFb = entries.map((e) => (e.model === 'local' ? { ...e, fallback: 'cloud' } : e));
  assert.equal(resolveFallbackEntry('local', withFb, 'cloud')?.model, 'cloud');
  // A local baseUrl without the explicit flag is ALSO treated as self-hosted.
  const localUrl = [
    { label: 'l', provider: 'mock' as const, model: 'l', baseUrl: 'http://127.0.0.1:8080/v1' },
    { label: 'cloud', provider: 'mock' as const, model: 'cloud' },
  ];
  assert.equal(resolveFallbackEntry('l', localUrl, 'cloud'), null);
  // Non-selfHosted keeps the legacy any-other-entry fallback.
  const normal = [
    { label: 'a', provider: 'mock' as const, model: 'a' },
    { label: 'cloud', provider: 'mock' as const, model: 'cloud' },
  ];
  assert.equal(resolveFallbackEntry('a', normal, 'cloud')?.model, 'cloud');
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
      models: [
        { label: 'p', provider: 'mock', model: 'primary', fallback: 'backup' },
        { label: 'b', provider: 'mock', model: 'backup' },
      ],
      fallbackModel: 'backup',
    };
    await new AgentLoop(deps, 'full').run();
    assert.equal(modelUsed, 'backup');
    assert.ok(events.some((e) => e.type === 'model_fallback' && e.to === 'backup'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('loop does NOT fall back on an idle_timeout stall', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const workspace = mkdtempSync(join(root, 'fallback-idle-'));
  try {
    let modelUsed = '';
    const provider = {
      name: 'stalling',
      estimateTokens: () => 1,
      async *send(req: { model: string }) {
        modelUsed = req.model;
        // The P1A-04 watchdog message mentions "overloaded" — but idle_timeout is a stall class,
        // so P1A-05 must NOT treat it as a genuine overload and silently swap the model.
        yield {
          type: 'error',
          recoverable: true,
          code: 'idle_timeout',
          message: 'no response within 120s — the model may be overloaded or the connection stalled',
        };
        return;
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
      models: [
        { label: 'p', provider: 'mock', model: 'primary', fallback: 'backup' },
        { label: 'b', provider: 'mock', model: 'backup' },
      ],
      fallbackModel: 'backup',
    };
    await new AgentLoop(deps, 'full').run();
    // The stall is surfaced visibly as an error, never silently swapped to another model.
    assert.equal(modelUsed, 'primary');
    assert.ok(!events.some((e) => e.type === 'model_fallback'));
    // The stall must NOT be swallowed — it is reported as a visible error, not a silent swap.
    assert.ok(events.some((e) => e.type === 'error'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('loop: selfHosted entry without fallback stays local on a provider error', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const workspace = mkdtempSync(join(root, 'fallback-selfhosted-'));
  try {
    let modelUsed = '';
    const provider = {
      name: 'selfhosted',
      estimateTokens: () => 1,
      async *send(req: { model: string }) {
        modelUsed = req.model;
        // Genuinely fallback-eligible, but the selfHosted entry never opted into fallback.
        yield { type: 'error', recoverable: true, code: 'overloaded', message: 'overloaded' };
        return;
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
      model: 'local',
      system: 'test',
      maxOutputTokens: 1024,
      workspaceRoot: workspace,
      dryRun: false,
      maxToolResultChars: 16_384,
      contextBudget: 1_000_000,
      models: [
        { label: 'l', provider: 'mock', model: 'local', selfHosted: true },
        { label: 'c', provider: 'mock', model: 'cloud' },
      ],
      fallbackModel: 'cloud',
    };
    await new AgentLoop(deps, 'full').run();
    // Privacy: error stays local — no silent switch to the cloud alternative.
    assert.equal(modelUsed, 'local');
    assert.ok(!events.some((e) => e.type === 'model_fallback'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
