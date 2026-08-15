import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { Budget } from '../src/agent/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import { writeFile } from '../src/tools/writeFile.js';
import type { ProviderEvent } from '../src/provider/provider.js';

/**
 * P3-06 v0 — END-TO-END acceptance criterion: after a successful write_file, the mapped
 * diagnostics command runs and its verdict reaches the model INSIDE the tool result on the next
 * provider round. (Split from diagnostics.test.ts: this file's static imports pull in
 * globalStore, so it must not share a process with the HOME-isolated config-trust tests. The
 * loop itself never reads the global config here — deps are hand-built.)
 */
test('end-to-end: a RED write_file verdict is folded into the tool result — and the write stays ok (advisory invariant)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p306-e2e-'));
  try {
    const registry = new ToolRegistry();
    registry.register(writeFile);
    let toolEndSummary = '';
    let toolEndOk: boolean | undefined;
    const bus = new EventBus();
    bus.on((e) => {
      if (e.type === 'tool_end') {
        toolEndSummary = e.result.summary;
        toolEndOk = e.result.ok;
      }
    });
    let secondRound: string | null = null;
    let turn = 0;
    const provider = {
      name: 'p',
      estimateTokens: () => 1,
      async *send(req: { messages: unknown[] }): AsyncGenerator<ProviderEvent> {
        turn++;
        if (turn === 1) {
          yield { type: 'tool_call', call: { id: '1', name: 'write_file', input: { path: 'probe.ts', content: 'const x = 1;\n' } } };
          yield { type: 'done', stopReason: 'tool_use' };
        } else {
          secondRound = JSON.stringify(req.messages);
          yield { type: 'text', delta: 'ok' };
          yield { type: 'done', stopReason: 'end_turn' };
        }
      },
    };
    const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
    context.pinTask({ role: 'user', content: [{ type: 'text', text: 'go' }] });
    const deps = {
      provider: provider as LoopDeps['provider'],
      registry,
      gate: new ScriptedApprovalGate(['approve']),
      bus,
      budget: new Budget({ maxIterations: 4 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
      context,
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 1024,
      workspaceRoot: root,
      dryRun: false,
      maxToolResultChars: 16_384,
      contextBudget: 1_000_000,
      diagnostics: { ts: 'printf "DIAG_VERDICT_FOLDED\\n"; exit 1' },
    } as LoopDeps;
    await new AgentLoop(deps, 'full').run();

    assert.ok(toolEndSummary.includes('DIAG_VERDICT_FOLDED'), 'the tool_end summary carries the diagnostics verdict');
    assert.ok(toolEndSummary.includes('exit 1'), 'the verdict is labeled red');
    assert.equal(toolEndOk, true, 'ADVISORY INVARIANT: a red diagnostic never changes the tool result to an error');
    assert.ok(secondRound !== null, 'the loop ran a second provider round');
    // TS narrows the closure-captured `secondRound` to its initializer (`null`) in the outer
    // flow, so an assertion signature would narrow it to `never` — read through a cast instead.
    const round = secondRound as unknown as string;
    assert.ok(round.includes('DIAG_VERDICT_FOLDED'), 'the NEXT model round receives the verdict inside the tool result');
    assert.ok(round.includes('[diagnostics:'), 'folded as a labeled diagnostics block');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('end-to-end: no diagnostics configured → tool results are untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p306-e2e-'));
  try {
    const registry = new ToolRegistry();
    registry.register(writeFile);
    let toolEndSummary = '';
    const bus = new EventBus();
    bus.on((e) => {
      if (e.type === 'tool_end') toolEndSummary = e.result.summary;
    });
    let turn = 0;
    const provider = {
      name: 'p',
      estimateTokens: () => 1,
      async *send(): AsyncGenerator<ProviderEvent> {
        turn++;
        if (turn === 1) {
          yield { type: 'tool_call', call: { id: '1', name: 'write_file', input: { path: 'probe.ts', content: 'const x = 1;\n' } } };
          yield { type: 'done', stopReason: 'tool_use' };
        } else {
          yield { type: 'text', delta: 'ok' };
          yield { type: 'done', stopReason: 'end_turn' };
        }
      },
    };
    const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
    context.pinTask({ role: 'user', content: [{ type: 'text', text: 'go' }] });
    const deps = {
      provider: provider as LoopDeps['provider'],
      registry,
      gate: new ScriptedApprovalGate(['approve']),
      bus,
      budget: new Budget({ maxIterations: 4 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
      context,
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 1024,
      workspaceRoot: root,
      dryRun: false,
      maxToolResultChars: 16_384,
      contextBudget: 1_000_000,
    } as LoopDeps;
    await new AgentLoop(deps, 'full').run();

    assert.ok(!toolEndSummary.includes('[diagnostics:'), 'an unconfigured map adds nothing to the tool result');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
