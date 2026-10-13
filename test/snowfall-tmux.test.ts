import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TuiAltScreen } from '@earendil-works/pi-tui';
import type { TmuxConnection, TmuxPane } from '../src/tmux/client.js';
import type { ShadowAutocompleteProvider } from '../src/app/autocomplete.js';
import type { SnowfallEditor } from '../src/app/snowfall.js';
import type { TmuxView } from '../src/app/tmuxView.js';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { HeadlessTerminal } from './helpers/snowfallTerminal.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';

const isolated = isolateHome('tmux-view');
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, isolated.home);
const { ShadowApp } = await import('../src/app/app.js');
const { loadConfig } = await import('../src/config.js');
const { Context } = await import('../src/agent/context.js');
const { EventBus } = await import('../src/agent/events.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { SessionLog } = await import('../src/state/session.js');
after(async () => { await removeFixtureTree(isolated.home); });
const until = async (fn: () => boolean) => {
  const deadline = Date.now() + 4000;
  while (!fn() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(fn());
};

test('fullscreen /tmux discovers, completes, selects and drives only the chosen Codex pane', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-tmux-view-'));
  const panes: TmuxPane[] = ['craig-main', 'margo-main'].map((session, i) => ({
    session, sessionId: `$${i}`, window: 'agent', windowIndex: 0, id: `%${i}`, index: 0, command: 'codex', pid: 100 + i, active: true,
  }));
  const sends: Array<[string, string]> = []; const keys: Array<[string, string]> = [];
  let failSend = false; let failCapture = false; let providerCalls = 0;
  const client: TmuxConnection = {
    async list() { return panes; },
    async capture() {
      if (failCapture) throw new Error('pane closed');
      return Array.from({ length: 180 }, (_, i) => `history-${i} ${i === 0 ? 'EARLIEST' : i === 179 ? 'LATEST' : ''}`).join('\n');
    },
    async send(pane, text) { if (failSend) throw new Error('delivery failed'); sends.push([pane.id, text]); },
    async keys(pane, data) { keys.push([pane.id, data]); },
  };
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const context = new Context({ contextBudget: 32768, triggerRatio: .8, keepLastTurns: 4 });
  const log = SessionLog.open(root); const terminal = new HeadlessTerminal(120, 36);
  const app = new ShadowApp({ provider: { name: 'mock', estimateTokens: () => 1,
    async *send() { providerCalls++; yield { type: 'text', delta: 'unexpected model call' }; } }, cfg,
    bus: new EventBus(), registry: new ToolRegistry(), sessionLog: log, context, system: 'fixture',
    workspaceRoot: root, autonomy: 'manual', bypass: false, offline: true, version: 'test' }, terminal);
  const inspect = app as unknown as { tmuxClient: TmuxConnection; tmuxView: TmuxView | null;
    autocomplete: ShadowAutocompleteProvider; tui: TuiAltScreen; editor: SnowfallEditor; runSlash(raw: string): void };
  inspect.tmuxClient = client;
  const run = app.run();
  const screen = () => terminal.lines().join('\n');
  try {
    terminal.input('/tmux '); await terminal.flush();
    await until(() => screen().includes('craig-main') && screen().includes('margo-main'));
    const suggestions = await inspect.autocomplete.getSuggestions(['/tmux mar'], 0, 9, { signal: new AbortController().signal });
    assert.deepEqual(suggestions?.items.map((item) => item.value), ['/tmux margo-main']);
    terminal.input('\x1b[B'); terminal.input('\r'); await terminal.flush();
    await until(() => inspect.tmuxView !== null);
    assert.match(screen(), /margo-main/);
    terminal.input('\x1b');
    inspect.runSlash('/tmux'); await terminal.flush();
    await until(() => screen().includes('choose a running agent'));
    terminal.input('\x1b[B'); terminal.input('\r'); await terminal.flush();
    await until(() => screen().includes('margo-main') && screen().includes('LATEST'));
    assert.ok(inspect.tmuxView);
    terminal.input('\x1b[<64;10;5M'); await terminal.flush();
    assert.doesNotMatch(screen(), /LATEST/, 'mouse wheel scrolls the external history');
    terminal.input('\x1b[5~'); await terminal.flush(); assert.doesNotMatch(screen(), /LATEST/);
    terminal.input('\x1b[1;5H'); await terminal.flush(); assert.match(screen(), /EARLIEST/);
    terminal.input('\x06'); terminal.input('history-120'); terminal.input('\r'); await terminal.flush();
    assert.match(screen(), /history-120/);
    terminal.resize(65, 20); await terminal.flush();
    assert.ok(terminal.lines().every((line) => line.length <= 100));
    terminal.input('Please check the tests.'); terminal.input('\r');
    await until(() => sends.length === 1);
    assert.deepEqual(sends[0], ['%1', 'Please check the tests.']);
    failSend = true;
    terminal.input('Keep my draft.'); terminal.input('\r'); await terminal.flush();
    await until(() => inspect.tmuxView!.getDraft() === 'Keep my draft.');
    assert.equal(sends.length, 1);
    terminal.input('\x1bOQ'); // F2: explicit Codex key mode
    terminal.input('\x1b[B'); terminal.input('\r'); terminal.input('\x1b'); terminal.input('\x03');
    await until(() => keys.length === 4);
    assert.deepEqual(keys, [['%1', '\x1b[B'], ['%1', '\r'], ['%1', '\x1b'], ['%1', '\x03']]);
    terminal.input('\x1d'); await terminal.flush(); assert.equal(inspect.tmuxView, null);
    inspect.runSlash('/tmux margo-main'); await terminal.flush();
    await until(() => inspect.tmuxView !== null);
    const reconnected = inspect.tmuxView as TmuxView | null;
    assert.ok(reconnected);
    assert.equal(reconnected.getDraft(), 'Keep my draft.');
    failCapture = true;
    await until(() => screen().includes('Disconnected:'));
    failSend = false; terminal.input('\r'); await terminal.flush();
    assert.equal(sends.length, 1, 'lost connection never sends into another pane');
    terminal.input('\x1b'); assert.equal(inspect.tmuxView, null);
    assert.equal(providerCalls, 0);
    assert.deepEqual(context.messages(), [], 'terminal content never enters Shadow model history');
  } finally { app.stop(); await run; log.close(); terminal.screen.dispose(); await removeFixtureTree(root); }
});
