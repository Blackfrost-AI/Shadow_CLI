import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import type { FlattenItem } from '../src/tui/flatten.js';
import type { ToolDetail } from '../src/app/activity.js';
import type { TuiAltScreen } from '@earendil-works/pi-tui';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { HeadlessTerminal } from './helpers/snowfallTerminal.js';

const isolated = isolateHome('snowfall-expand-default');
const previousSessionDir = process.env.SHADOW_SESSION_DIR;
delete process.env.SHADOW_SESSION_DIR;
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, isolated.home);
const { ShadowApp } = await import('../src/app/app.js');
const { loadConfig } = await import('../src/config.js');
const { Context } = await import('../src/agent/context.js');
const { EventBus } = await import('../src/agent/events.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { grep } = await import('../src/tools/grep.js');
const { SessionLog } = await import('../src/state/session.js');

after(() => {
  if (previousSessionDir === undefined) delete process.env.SHADOW_SESSION_DIR;
  else process.env.SHADOW_SESSION_DIR = previousSessionDir;
  rmSync(isolated.home, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

interface Inspect {
  tui: TuiAltScreen; running: boolean; items: FlattenItem[]; details: ToolDetail[];
  showAllExpanded: boolean;
}

/**
 * Real grep against fixture files, driven through the real loop. The transcript group only folds
 * when there are enough match rows, so the expansion default is observable rather than inferred.
 */
function buildApp(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'shadow-expand-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'alpha.ts'), 'const alpha_marker = "EXPAND_ALPHA_MATCH";\n');
  writeFileSync(join(root, 'src', 'beta.ts'), 'const beta_marker = "EXPAND_BETA_MATCH";\n');

  let calls = 0;
  const provider: Provider = {
    name: 'mock', estimateTokens: () => 20,
    async *send(): AsyncIterable<ProviderEvent> {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', call: { id: 'grep-alpha', name: 'grep', input: { pattern: 'alpha_marker', path: 'src/alpha.ts' } } };
        yield { type: 'tool_call', call: { id: 'grep-beta', name: 'grep', input: { pattern: 'beta_marker', path: 'src/beta.ts' } } };
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        yield { type: 'text', delta: 'Both searches finished.' };
        yield { type: 'done', stopReason: 'end_turn' };
      }
    },
  };

  const bus = new EventBus();
  const registry = new ToolRegistry();
  registry.register(grep);
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const log = SessionLog.open(root);
  const terminal = new HeadlessTerminal(140, 48);
  const app = new ShadowApp({
    provider, cfg, bus, registry, sessionLog: log,
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    system: 'Expand default test.', workspaceRoot: root, autonomy: 'auto-read', bypass: false, offline: true, version: 'test',
  }, terminal);
  t.after(() => log.close());
  t.after(() => terminal.screen.dispose());
  // Cast a separate probe handle rather than intersecting with ShadowApp: `tui` is private on the
  // class and public here, so `ShadowApp & Inspect` reduces to `never`.
  const inspect = app as unknown as Inspect;
  return { app, terminal, inspect, screen: () => terminal.lines().join('\n') };
}

test('Snowfall launches expanded and shows tool bodies without Ctrl+O', async (t) => {
  const { app, terminal, inspect, screen } = buildApp(t);
  const run = app.run();
  try {
    assert.equal(inspect.showAllExpanded, true, 'transcript detail must be expanded on launch, not compacted');
    terminal.input('Search the two fixture files.'); terminal.input('\r');
    await until(() => turnSettled(inspect), 'the real loop runs both grep calls and receives the answer');
    await terminal.flush();
    // Expanded at launch: both match bodies are already painted and the collapsed
    // `^O · /activity` affordance is absent.
    assert.match(screen(), /Grep 2 patterns/);
    assert.match(screen(), /alpha\.ts:1:7.*EXPAND_ALPHA_MATCH/);
    assert.match(screen(), /beta\.ts:1:7.*EXPAND_BETA_MATCH/);
    assert.doesNotMatch(screen(), /\/activity/);
  } finally {
    app.stop();
    await run;
  }
});

test('Ctrl+O toggles from the expanded default and back', async (t) => {
  const { app, terminal, inspect, screen } = buildApp(t);
  const run = app.run();
  try {
    assert.equal(inspect.showAllExpanded, true, 'starts expanded');
    terminal.input('Search the two fixture files.'); terminal.input('\r');
    await until(() => turnSettled(inspect), 'the real loop runs both grep calls and receives the answer');
    await terminal.flush();

    // First Ctrl+O collapses: match bodies fold away and the activity affordance appears.
    terminal.input('\x0f'); await terminal.flush();
    assert.equal(inspect.showAllExpanded, false, 'Ctrl+O collapses from the expanded default');
    assert.doesNotMatch(screen(), /EXPAND_ALPHA_MATCH|EXPAND_BETA_MATCH/);
    assert.match(screen(), /\/activity/);

    // Second Ctrl+O restores the expanded launch state.
    terminal.input('\x0f'); await terminal.flush();
    assert.equal(inspect.showAllExpanded, true, 'Ctrl+O toggles back to expanded');
    assert.match(screen(), /EXPAND_ALPHA_MATCH/);
    assert.match(screen(), /EXPAND_BETA_MATCH/);
    assert.doesNotMatch(screen(), /\/activity/);
  } finally {
    app.stop();
    await run;
  }
});

/** True once the loop is idle and at least one real tool row has been committed. */
function turnSettled(inspect: Inspect): boolean {
  return !inspect.running && inspect.items.some((item) => item.kind === 'tool');
}
