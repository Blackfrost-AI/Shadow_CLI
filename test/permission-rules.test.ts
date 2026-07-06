import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermissionRule } from '../src/safety/rules.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProviderEvent } from '../src/provider/provider.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { AutoDenyGate } from '../src/agent/approval.js';
import type { Tool } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';

test('resolvePermissionRule matches tool and pattern', () => {
  const call = { id: '1', name: 'run_shell', input: { command: 'rm -rf /' } };
  const rules = [{ tool: 'run_shell', pattern: 'rm -rf', action: 'ask' as const }];
  assert.equal(resolvePermissionRule(call, '$ rm -rf /', rules), 'ask');
  assert.equal(resolvePermissionRule({ id: '2', name: 'read_file', input: {} }, 'read_file x', rules), null);
});

test('permission rule deny blocks without gate', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const workspace = mkdtempSync(join(root, 'perm-'));
  try {
    const tool: Tool<Record<string, never>, { ran: boolean }> = {
      name: 'write_probe',
      description: 'write',
      risk: 'write',
      inputSchema: z.object({}),
      async run() {
        return ok('write_probe', 'write', 1, 'ran', { ran: true });
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const events: Array<{ type: string; reason?: string }> = [];
    const bus = new EventBus();
    bus.on((e) => events.push(e));
    const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
    context.pinTask({ role: 'user', content: [{ type: 'text', text: 'go' }] });
    const provider = {
      name: 'p',
      estimateTokens: () => 1,
      async *send(): AsyncGenerator<ProviderEvent> {
        yield { type: 'tool_call', call: { id: 'w', name: 'write_probe', input: {} } };
        yield { type: 'done', stopReason: 'tool_use' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const deps: LoopDeps = {
      provider: provider as LoopDeps['provider'],
      registry,
      gate: new AutoDenyGate(),
      bus,
      budget: new Budget({ maxIterations: 3 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
      context,
      signal: new AbortController().signal,
      model: 'mock',
      system: 'test',
      maxOutputTokens: 1024,
      workspaceRoot: workspace,
      dryRun: false,
      maxToolResultChars: 16_384,
      contextBudget: 1_000_000,
      permissionRules: [{ tool: 'write_probe', action: 'deny' }],
    };
    await new AgentLoop(deps, 'full').run();
    assert.ok(events.some((e) => e.type === 'tool_denied' && (e.reason ?? '').includes('permission rule denied')));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});