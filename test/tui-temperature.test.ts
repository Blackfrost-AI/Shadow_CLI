import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { CompletionRequest, Provider } from '../src/provider/provider.js';
import type { TuiOpts } from '../src/tui.js';

// `/config set` writes the global store, so import the TUI only after redirecting HOME. This
// prevents an integration test from ever touching a developer's real ~/.shadow/config.json.
const { home: HOME } = isolateHome('tui-temperature');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);

const [{ TuiApp }, { loadConfig }, { EventBus }, { Context }, { ToolRegistry }] = await Promise.all([
  import('../src/tui.js'),
  import('../src/config.js'),
  import('../src/agent/events.js'),
  import('../src/agent/context.js'),
  import('../src/tools/registry.js'),
]);

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for TUI state');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test('/config set temperature persists and the very next turn uses the new value', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'shadow-tui-temperature-workspace-'));
  const requests: CompletionRequest[] = [];
  const provider: Provider = {
    name: 'temperature-capture',
    estimateTokens: () => 0,
    async *send(request) {
      requests.push(request);
      yield { type: 'text', delta: 'temperature captured' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const cfg = loadConfig(workspaceRoot, {
    provider: 'openai',
    model: 'local-model',
    baseUrl: 'http://127.0.0.1:8080/v1',
    temperature: 1.0,
  });
  const context = new Context({
    contextBudget: cfg.contextBudget,
    triggerRatio: cfg.summarizeTriggerRatio,
    keepLastTurns: 0,
  });
  const opts: TuiOpts = {
    provider,
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context,
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot,
    cfg,
    autonomy: 'auto-edit',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const output = () => frames.join('\n');
  try {
    await waitFor(() => /❯/.test(output()));
    // Let Ink finish wiring useInput after the first paint before synthetic typing begins.
    await new Promise((resolve) => setTimeout(resolve, 80));

    stdin.write('/config set temperature 0.37');
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write('\r');
    await waitFor(() => /Config saved: temperature = 0\.37/.test(output()));

    assert.equal(cfg.temperature, 0.37, 'the live config changes immediately');
    assert.equal(store.loadGlobalConfig().temperature, 0.37, 'the global config entry is durable');

    stdin.write('use the new sampling value');
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write('\r');
    await waitFor(() => requests.length === 1);

    assert.equal(requests[0]?.temperature, 0.37, 'the next AgentLoop request reads the updated live config');

    await waitFor(() => /temperature captured/.test(output()));
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write('/compact');
    await new Promise((resolve) => setTimeout(resolve, 80));
    stdin.write('\r');
    await waitFor(() => /Context compacted/.test(output()));

    assert.equal(requests.at(-1)?.temperature, 0.37, 'manual compaction keeps the configured temperature');
  } finally {
    unmount();
  }
});
