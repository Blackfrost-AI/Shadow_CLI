import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// Redirect ~/.shadow to a throwaway HOME BEFORE importing the store. The TUI's `/permissions add`
// now persists permission rules GLOBAL-only (F07-01) via `saveGlobalConfig` (~/.shadow/config.json),
// so without isolation this test would write the user's real global config.
const { home: HOME } = isolateHome('perm-loop');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const { loadConfig } = await import('../src/config.js');
const { TuiApp } = await import('../src/tui.js');
const { EventBus } = await import('../src/agent/events.js');
const { Context } = await import('../src/agent/context.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { createProvider } = await import('../src/provider/index.js');
const { AgentLoop } = await import('../src/agent/loop.js');
const { Budget } = await import('../src/agent/budget.js');
const { AutoDenyGate } = await import('../src/agent/approval.js');
const { ok } = await import('../src/tools/types.js');
import type { TuiOpts } from '../src/tui.js';
import type { LoopDeps } from '../src/agent/loop.js';
import type { ProviderEvent } from '../src/provider/provider.js';
import type { Tool } from '../src/tools/types.js';

const tick = () => new Promise((r) => setTimeout(r, 80));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');

test('/permissions add/remove persists to the GLOBAL config and never touches the project file (F07-01)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'perm-tui-'));
  const cfgPath = join(ws, 'shadow.config.json');
  const projectSrc = JSON.stringify({ provider: 'mock', model: 'm', permissionRules: [] }, null, 2) + '\n';
  writeFileSync(cfgPath, projectSrc);
  const globalConfigPath = join(store.GLOBAL_DIR, 'config.json');
  try {
    const cfg = loadConfig(ws, { provider: 'mock', model: 'm' });
    const opts: TuiOpts = {
      provider: createProvider({ provider: 'mock', model: 'm' }),
      registry: new ToolRegistry(),
      bus: new EventBus(),
      context: new Context({
        contextBudget: cfg.contextBudget,
        triggerRatio: cfg.summarizeTriggerRatio,
        keepLastTurns: cfg.keepLastTurns,
      }),
      sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
      system: 'test',
      workspaceRoot: ws,
      cfg,
      autonomy: 'full',
      bypass: false,
      version: '0.0.0',
    };

    const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
    await tick();
    stdin.write('/permissions add deny write_probe');
    await tick();
    stdin.write('\r');
    await tick();
    stdin.write('/permissions remove 0');
    await tick();
    stdin.write('\r');
    await tick();

    const out = strip(frames.join('\n'));
    assert.match(out, /Added rule #0/);
    assert.match(out, /Removed rule #0/);

    // F07-01: the untrusted project file is NEVER written — the rule round-trips through the global
    // store only. After add + remove, the global config is back to an empty rule set.
    assert.equal(readFileSync(cfgPath, 'utf8'), projectSrc, 'project shadow.config.json is untouched');
    const rules = (((loadConfig(ws).permissionRules) as unknown[]) ?? []);
    assert.equal(rules.length, 0, 'add+remove round-trip leaves no rules in the (global) live config');
    unmount();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(globalConfigPath, { force: true });
  }
});

test('setPermissionRules hot-update makes loop consult the new deny rule', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'perm-loop-'));
  try {
    const probe: Tool<Record<string, never>, { ran: boolean }> = {
      name: 'write_probe',
      description: 'probe',
      risk: 'write',
      inputSchema: z.object({}),
      async run() {
        return ok('write_probe', 'write', 1, 'ran', { ran: true });
      },
    };
    const registry = new ToolRegistry();
    registry.register(probe);
    const bus = new EventBus();
    const denied: string[] = [];
    bus.on((e) => {
      if (e.type === 'tool_denied') denied.push(e.reason);
    });
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
      workspaceRoot: ws,
      dryRun: false,
      maxToolResultChars: 16_384,
      contextBudget: 1_000_000,
      permissionRules: [],
    };
    const loop = new AgentLoop(deps, 'full');
    loop.setPermissionRules([{ tool: 'write_probe', action: 'deny' }]);
    await loop.run();
    assert.ok(denied.some((r) => r.includes('permission rule denied')));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});