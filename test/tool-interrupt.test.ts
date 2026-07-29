/**
 * Esc must work during ANY tool, including ones that ignore the abort signal.
 *
 * `ctx.signal` is handed to every tool, but honouring it is voluntary. MCP tools (whose
 * implementations Shadow does not own) and any tool doing a blocking await simply ignore it, so
 * Esc was dead for the entire duration of such a call — the user pressed it, the abort fired, and
 * nothing happened until the tool finished on its own. The loop now races the call against the
 * signal so the interrupt lands at the LOOP level regardless of the tool's cooperation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop } from '../src/agent/loop.js';
import { buildLoopDeps } from '../src/agent/loopDeps.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { Budget } from '../src/agent/budget.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { loadConfig } from '../src/config.js';
import { ok, type Tool } from '../src/tools/types.js';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** A tool that NEVER checks ctx.signal — the MCP case. */
function stubbornTool(ms: number): Tool<Record<string, never>, { done: boolean }> {
  return {
    name: 'stubborn',
    description: 'ignores the abort signal entirely',
    risk: 'read',
    inputSchema: z.object({}),
    async run() {
      await new Promise((r) => setTimeout(r, ms));
      return ok('stubborn', 'read', ms, 'finished anyway', { done: true });
    },
  };
}

function toolThenDone(call: { id: string; name: string; input: unknown }): Provider {
  let sent = false;
  return {
    name: 'scripted',
    estimateTokens: () => 1,
    async *send(): AsyncGenerator<ProviderEvent> {
      if (!sent) {
        sent = true;
        yield { type: 'tool_call', call };
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', stopReason: 'end_turn' };
      }
    },
  };
}

test('aborting during a signal-ignoring tool unwinds the turn promptly', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'tool-interrupt-'));
  try {
    const cfg = loadConfig(ws, { provider: 'mock', model: 'm' });
    const registry = new ToolRegistry();
    registry.register(stubbornTool(30_000)); // would hang the turn for 30s
    const bus = new EventBus();
    const events: LoopEvent[] = [];
    bus.on((e) => events.push(e));
    const controller = new AbortController();

    const deps = buildLoopDeps({
      cfg,
      provider: toolThenDone({ id: 't1', name: 'stubborn', input: {} }),
      registry,
      gate: new AutoApproveGate(),
      bus,
      budget: new Budget({ maxIterations: cfg.maxIterations }, cfg.model, cfg.priceTable, Date.now()),
      context: new Context({
        contextBudget: cfg.contextBudget,
        triggerRatio: cfg.summarizeTriggerRatio,
        keepLastTurns: cfg.keepLastTurns,
      }),
      signal: controller.signal,
      model: cfg.model,
      system: 'test',
      workspaceRoot: ws,
      streamShell: false,
    });

    const started = Date.now();
    const run = new AgentLoop(deps, 'full').run();
    // Wait for the tool to actually be in flight, then interrupt.
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(events.some((e) => e.type === 'tool_start'), 'the tool started');
    controller.abort();

    await run;
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 5_000,
      `the turn must unwind on abort, not wait out the tool — took ${elapsed}ms of a 30s tool`,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
