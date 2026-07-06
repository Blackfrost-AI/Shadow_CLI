import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink-testing-library';
import { buildStyledSystem } from '../src/agent/system.js';
import { outputStyles, type OutputStyle } from '../src/styles.js';
import type { CompletionRequest, Provider, ProviderEvent } from '../src/provider/provider.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';

const tick = () => new Promise((r) => setTimeout(r, 60));

function makeTempDir(prefix: string): string {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}

async function waitFor(pred: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('each output style produces a distinct system prompt block', () => {
  const rendered = new Map<OutputStyle, string>();
  for (const style of outputStyles) {
    rendered.set(style, buildStyledSystem('BASE', style, 'repo uses pnpm'));
  }

  assert.equal(new Set(rendered.values()).size, outputStyles.length);
  assert.match(rendered.get('proactive') ?? '', /## Output style . Proactive/);
  assert.match(rendered.get('explanatory') ?? '', /## Output style . Explanatory/);
  assert.match(rendered.get('learning') ?? '', /## Output style . Learning/);
  assert.match(rendered.get('procedural') ?? '', /## Output style . Procedural/);
  assert.match(rendered.get('procedural') ?? '', /## Known workspace facts/);
  assert.match(rendered.get('procedural') ?? '', /repo uses pnpm/);
});

test('--style persists the selected lastStyle in the global config', () => {
  const home = makeTempDir('style-home-');
  const workspace = makeTempDir('style-ws-');
  try {
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', entry, '--provider', 'mock', '--model', 'mock', '--style', 'procedural', '--task', 'hi', '--workspace', workspace, '--log-level', 'silent'],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(home, '.shadow', 'config.json'), 'utf8')) as { lastStyle?: string };
    assert.equal(config.lastStyle, 'procedural');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('/style changes the style used by the next TUI run', async () => {
  const home = makeTempDir('style-tui-home-');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const [{ TuiApp }, { loadConfig }] = await Promise.all([
      import('../src/tui.js'),
      import('../src/config.js'),
    ]);

    const systems: string[] = [];
    const provider: Provider = {
      name: 'capture',
      async *send(req: CompletionRequest): AsyncIterable<ProviderEvent> {
        systems.push(req.system);
        yield { type: 'done', stopReason: 'end_turn' };
      },
      estimateTokens() {
        return 1;
      },
    };
    const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'mock' });
    const opts: import('../src/tui.js').TuiOpts = {
      provider,
      registry: new ToolRegistry(),
      bus: new EventBus(),
      context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
      sessionLog: { record() {} } as unknown as import('../src/tui.js').TuiOpts['sessionLog'],
      system: 'system:proactive',
      workspaceRoot: process.cwd(),
      cfg,
      autonomy: 'auto-edit' as const,
      bypass: false,
      version: '0.0.0',
      styleState: {
        style: 'proactive' as const,
        setStyle() {},
        systemForStyle: (style: OutputStyle) => `system:${style}`,
      },
    };

    const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
    await tick();
    stdin.write('/style');
    await tick();
    stdin.write('\r');
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');
    await waitFor(() => systems.length > 0);

    assert.match(frames.join('\n'), /Style . explanatory/);
    // The style's system prefix is applied; the loop also appends a model-agnostic
    // effort directive each turn (see agent/effort.ts), so check the prefix, not exact equality.
    assert.ok(systems[0]?.startsWith('system:explanatory'), `got: ${systems[0]}`);
    unmount();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
