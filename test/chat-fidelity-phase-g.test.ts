import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import type { Provider } from '../src/provider/provider.js';
import type { Tool } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';
import { grep } from '../src/tools/grep.js';
import type { ToolContext } from '../src/tools/types.js';

function buildLoop(
  provider: Provider,
  tools: Tool[],
  opts: { maxIterations?: number } = {},
): { loop: AgentLoop; events: LoopEvent[] } {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const budget = new Budget({ maxIterations: opts.maxIterations ?? 25 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now());
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'do the thing' }] });
  const deps: LoopDeps = {
    provider,
    registry,
    gate: new AutoApproveGate(),
    bus,
    budget,
    context,
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: process.cwd(),
    dryRun: false,
    maxToolResultChars: 16384,
    contextBudget: 1_000_000,
  };
  return { loop: new AgentLoop(deps, 'full'), events };
}

test('reasoning_done is emitted when a turn accumulates thinking deltas', async () => {
  const provider = new MockProvider([
    [
      { type: 'thinking', delta: 'step one. ' },
      { type: 'thinking', delta: 'step two.' },
      { type: 'text', delta: 'Answer.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const { loop, events } = buildLoop(provider, []);
  await loop.run();

  const reasoning = events.filter((e) => e.type === 'reasoning_done');
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0]!.type === 'reasoning_done' && reasoning[0].text, 'step one. step two.');
  assert.ok(events.some((e) => e.type === 'assistant_done'));
});

test('reasoning_done is omitted when no thinking was streamed', async () => {
  const provider = new MockProvider([[{ type: 'text', delta: 'plain.' }, { type: 'done', stopReason: 'end_turn' }]]);
  const { loop, events } = buildLoop(provider, []);
  await loop.run();
  assert.equal(events.some((e) => e.type === 'reasoning_done'), false);
});

test('tool_end with meta.findings emits finding bus events', async () => {
  const findingsTool: Tool<{ n: number }, { n: number }> = {
    name: 'findings_probe',
    description: 'emits findings',
    risk: 'read',
    inputSchema: z.object({ n: z.number() }),
    run: async (input) => {
      const result = ok('findings_probe', 'read', 1, 'ok', { n: input.n });
      result.meta.findings = [{ title: 'probe hit', body: `n=${input.n}`, severity: 'warn' }];
      return result;
    },
  };

  const provider = new MockProvider([
    [
      { type: 'tool_call', call: { id: 't1', name: 'findings_probe', input: { n: 42 } } },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [{ type: 'text', delta: 'done' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const { loop, events } = buildLoop(provider, [findingsTool]);
  await loop.run();

  const finding = events.find((e) => e.type === 'finding');
  assert.ok(finding && finding.type === 'finding');
  assert.equal(finding.title, 'probe hit');
  assert.equal(finding.body, 'n=42');
  assert.equal(finding.severity, 'warn');
});

test('grep attaches findings meta when matches are found', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'grep-g-'));
  writeFileSync(join(ws, 'needle.txt'), 'alpha needle here\nbeta\nneedle again\n');
  const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
  try {
    const result = await grep.run({ pattern: 'needle' }, ctx);
    assert.ok(result.ok);
    assert.ok(result.meta.findings && result.meta.findings.length === 1);
    const card = result.meta.findings[0]!;
    assert.match(card.title, /2 match/);
    assert.match(card.body, /needle\.txt:1:/);
    assert.equal(card.severity, 'info');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('grep omits findings meta when there are no matches', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'grep-g0-'));
  writeFileSync(join(ws, 'empty.txt'), 'nothing here\n');
  const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
  try {
    const result = await grep.run({ pattern: 'zzz' }, ctx);
    assert.ok(result.ok);
    assert.equal(result.meta.findings, undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});