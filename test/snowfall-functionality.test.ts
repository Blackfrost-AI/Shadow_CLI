import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { HeadlessTerminal } from './helpers/snowfallTerminal.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';
import type { SnowfallEditor } from '../src/app/snowfall.js';

const isolated = isolateHome('functionality-ui');
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, isolated.home);
const { ShadowApp } = await import('../src/app/app.js');
const { loadConfig } = await import('../src/config.js');
const { Context } = await import('../src/agent/context.js');
const { EventBus } = await import('../src/agent/events.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { SessionLog } = await import('../src/state/session.js');
const { SessionLibrary } = await import('../src/state/sessionLibrary.js');
after(async () => { await removeFixtureTree(isolated.home); });
const until = async (fn: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!fn() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(fn());
};

test('feature menus preview locally, preserve source controls and launch only the reviewed workflow', async () => {
  const root = join(isolated.home, 'project'); mkdirSync(root);
  writeFileSync(join(root, 'guide.txt'), 'PINNED FIXTURE CONTENT');
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const context = new Context({ contextBudget: 32768, triggerRatio: .8, keepLastTurns: 4 });
  const log = SessionLog.open(root); const terminal = new HeadlessTerminal(130, 40);
  let providerCalls = 0;
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const app = new ShadowApp({ provider: { name: 'mock', estimateTokens: () => 1,
    async *send() { providerCalls++; yield { type: 'text', delta: 'unexpected model call' }; } }, cfg,
    bus: new EventBus(), registry: new ToolRegistry(), sessionLog: log, context, system: 'fixture',
    runNativeTool: async (name, input) => { toolCalls.push({ name, input }); return { ok: true, summary: 'Workflow fixture finished', meta: { tool: name, risk: 'read', durationMs: 1 } }; },
    workspaceRoot: root, autonomy: 'manual', bypass: false, offline: true, version: 'test' }, terminal);
  const inspect = app as unknown as { runSlash(raw: string): void; running: boolean; closePicker(): void; editor: SnowfallEditor };
  const run = app.run(); const screen = () => terminal.lines().join('\n');
  try {
    inspect.runSlash('/context pin guide.txt'); await terminal.flush();
    assert.ok(context.requestMessages().some((message) => JSON.stringify(message).includes('PINNED FIXTURE CONTENT')));
    assert.match(screen(), /[Cc]ontext/); terminal.input('\x1b');
    inspect.runSlash('/context exclude guide.txt'); await terminal.flush();
    assert.ok(context.isSourceExcluded(join(root, 'guide.txt'))); terminal.input('\x1b');
    inspect.runSlash('/workflows repository-review {"scope":"src/"}'); await terminal.flush();
    assert.match(screen(), /Repository review/); assert.equal(toolCalls.length, 0); assert.equal(providerCalls, 0);
    terminal.input('\x1b'); await terminal.flush();
    assert.match(screen(), /Run workflow/); terminal.input('2'); terminal.input('\r');
    await until(() => toolCalls.length === 1 && !inspect.running);
    assert.equal(toolCalls[0]!.name, 'collaborate');
    assert.match(JSON.stringify(toolCalls[0]!.input), /Review src\//);
    assert.match(readFileSync(log.path, 'utf8'), /workflow_launch/);
    inspect.runSlash('/extensions'); await terminal.flush(); assert.match(screen(), /MCP servers/); terminal.input('\x1b');
    inspect.runSlash('/checks'); await terminal.flush(); assert.match(screen(), /Add a check/); terminal.input('\x1b');
    inspect.runSlash('/findings export'); await terminal.flush(); assert.match(screen(), /Report saved/);
    inspect.runSlash('/model history'); await terminal.flush(); assert.match(screen(), /No capability result/); terminal.input('\x1b');
    assert.equal(toolCalls.length, 1); assert.equal(providerCalls, 0, 'inspection/export never invoke inference');
  } finally { app.stop(); await run; log.close(); terminal.screen.dispose(); }
});

test('session hub finds an explicitly selected project and shows navigation instead of adopting its workspace', async () => {
  const root = join(isolated.home, 'library-current'); const other = join(isolated.home, 'library-other'); mkdirSync(root); mkdirSync(other);
  const otherContext = new Context({ contextBudget: 32768, triggerRatio: .8, keepLastTurns: 4 });
  const otherLog = SessionLog.open(other); otherLog.setTitle('Foreign fixture');
  otherLog.record({ kind: 'user', task: 'needle-cross-project' }); otherLog.recordSnapshot(otherContext, 0); otherLog.close();
  const before = readFileSync(otherLog.path, 'utf8');
  const library = new SessionLibrary(root); library.addProject(other); library.close();
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const context = new Context({ contextBudget: 32768, triggerRatio: .8, keepLastTurns: 4 });
  const log = SessionLog.open(root); const terminal = new HeadlessTerminal(130, 40);
  const app = new ShadowApp({ provider: { name: 'mock', estimateTokens: () => 1, async *send() { yield { type: 'text', delta: 'Unexpected inference' }; throw new Error('Unexpected inference'); } }, cfg,
    bus: new EventBus(), registry: new ToolRegistry(), sessionLog: log, context, system: 'fixture',
    workspaceRoot: root, autonomy: 'manual', bypass: false, offline: true, version: 'test' }, terminal);
  const inspect = app as unknown as { runSlash(raw: string): void };
  const run = app.run(); const screen = () => terminal.lines().join('\n');
  try {
    inspect.runSlash('/sessions search needle-cross-project');
    await until(() => screen().includes('Foreign fixture'));
    terminal.input('4'); terminal.input('\r'); await terminal.flush();
    assert.match(screen(), /Show launch command/); assert.doesNotMatch(screen(), /Resume in this workspace/);
    terminal.input('2'); terminal.input('\r'); await until(() => screen().includes('1 matches'));
    const check = new SessionLibrary(root); assert.equal((await check.search('needle-cross-project')).sessions[0]?.pinned, true); check.close();
    terminal.input('4'); terminal.input('\r'); await terminal.flush();
    terminal.input('4'); terminal.input('\r'); await terminal.flush();
    assert.match(screen(), /Open in the owning workspace/); assert.match(screen(), /library-other/);
    assert.deepEqual(context.messages(), []); assert.equal(readFileSync(otherLog.path, 'utf8'), before);
  } finally { app.stop(); await run; log.close(); terminal.screen.dispose(); }
});

test('Escape cancels a capability probe without starting another request', async () => {
  const root = join(isolated.home, 'capability-cancel'); mkdirSync(root);
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const context = new Context({ contextBudget: 32768, triggerRatio: .8, keepLastTurns: 4 });
  const log = SessionLog.open(root); const terminal = new HeadlessTerminal(100, 30); let calls = 0;
  const app = new ShadowApp({ provider: { name: 'mock', estimateTokens: () => 1, async *send(request) {
    calls++; yield { type: 'text', delta: '' };
    await new Promise<void>((resolve) => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener('abort', () => resolve(), { once: true }); });
  } }, cfg, bus: new EventBus(), registry: new ToolRegistry(), sessionLog: log, context, system: 'fixture',
  workspaceRoot: root, autonomy: 'manual', bypass: false, offline: true, version: 'test' }, terminal);
  const inspect = app as unknown as { runSlash(raw: string): void; modelChecking: boolean };
  const run = app.run();
  try {
    inspect.runSlash('/model test'); await until(() => calls === 1);
    terminal.input('\x1b'); await until(() => !inspect.modelChecking);
    assert.equal(calls, 1); assert.deepEqual(context.messages(), []);
  } finally { app.stop(); await run; log.close(); terminal.screen.dispose(); }
});
