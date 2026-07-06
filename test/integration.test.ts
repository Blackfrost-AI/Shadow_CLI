import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';

/**
 * End-to-end: the REAL builtin tools, run THROUGH the real loop, driven by a
 * scripted mock. Proves the tool-call round-trip works against the filesystem.
 */
test('the loop drives the real writeFile + readFile tools end to end', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-it-'));
  try {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const provider = new MockProvider([
      // turn 1: write a file
      [
        { type: 'text', delta: 'Writing the file. ' },
        {
          type: 'tool_call',
          call: { id: 'w1', name: 'write_file', input: { path: 'hello.txt', content: 'shadow works' } },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // turn 2: read it back
      [
        {
          type: 'tool_call',
          call: { id: 'r1', name: 'read_file', input: { path: 'hello.txt' } },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // turn 3: finish
      [
        { type: 'text', delta: 'File written and verified.' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);

    const bus = new EventBus();
    const toolNames: string[] = [];
    bus.on((e) => {
      if (e.type === 'tool_end') toolNames.push(e.call.name);
    });

    const budget = new Budget({ maxIterations: 25 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now());
    const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
    context.pinTask({ role: 'user', content: [{ type: 'text', text: 'write and read a file' }] });

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
      workspaceRoot: ws,
      dryRun: false,
      maxToolResultChars: 16384,
      contextBudget: 1_000_000,
    };

    const res = await new AgentLoop(deps, 'full').run();

    assert.equal(res.stopReason, 'end_turn');
    assert.equal(res.finalAnswer, 'File written and verified.');
    assert.equal(readFileSync(join(ws, 'hello.txt'), 'utf8'), 'shadow works', 'file written to disk');
    assert.ok(toolNames.includes('write_file') && toolNames.includes('read_file'), 'both tools ran');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a pause_turn resumes the loop instead of ending it', async () => {
  // Turn 1 pauses mid-answer (server pause_turn); the loop must re-request, not stop.
  const provider = new MockProvider([
    [
      { type: 'text', delta: 'part one… ' },
      { type: 'done', stopReason: 'pause_turn' },
    ],
    [
      { type: 'text', delta: 'part two.' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'do a long thing' }] });
  const deps: LoopDeps = {
    provider,
    registry: new ToolRegistry(),
    gate: new AutoApproveGate(),
    bus: new EventBus(),
    budget: new Budget({ maxIterations: 25 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
    context,
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: '/tmp',
    dryRun: false,
    maxToolResultChars: 16384,
    contextBudget: 1_000_000,
  };
  const res = await new AgentLoop(deps, 'full').run();
  assert.equal(res.stopReason, 'end_turn', 'the loop ends on the post-pause turn, not on the pause');
  assert.equal(res.finalAnswer, 'part two.', 'it continued into the second turn');
});
