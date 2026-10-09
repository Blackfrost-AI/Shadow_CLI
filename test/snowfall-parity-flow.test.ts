import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TuiAltScreen } from '@earendil-works/pi-tui';
import type { SnowfallEditor } from '../src/app/snowfall.js';
import type { ConsultationRequest, ConsultationResult, ConsultationRuntime, ConsultationService } from '../src/agent/consultation.js';
import type { TuiOpts } from '../src/tui.js';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { HeadlessTerminal } from './helpers/snowfallTerminal.js';

const isolated = isolateHome('snowfall-parity');
const previousSessionDir = process.env.SHADOW_SESSION_DIR;
delete process.env.SHADOW_SESSION_DIR;
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, isolated.home);
const { ShadowApp } = await import('../src/app/app.js');
const { loadConfig } = await import('../src/config.js');
const { Context } = await import('../src/agent/context.js');
const { EventBus } = await import('../src/agent/events.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { SessionLog } = await import('../src/state/session.js');
after(() => {
  if (previousSessionDir === undefined) delete process.env.SHADOW_SESSION_DIR;
  else process.env.SHADOW_SESSION_DIR = previousSessionDir;
  rmSync(isolated.home, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(predicate(), label);
}

test('Snowfall review, consultation follow-up and native team flows preserve focus, resize and Escape ownership', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-parity-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'fixture-main');
  git('config', 'user.name', 'Terminal Fixture');
  git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(root, 'tracked.ts'), 'export const answer = 1;\n');
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  writeFileSync(join(root, 'tracked.ts'), 'export const answer = 2;\n');
  writeFileSync(join(root, 'untracked.ts'), 'export const extra = true;\n');
  const starts: ConsultationRequest[] = [];
  const followUps: Array<{ id: string; prompt: string }> = [];
  const result = (answer: string): ConsultationResult => ({ id: 'consult-fixture', title: 'Fixture opinion',
    status: 'completed', turns: 1, answer, ok: true, usage: { inputTokens: 10, outputTokens: 5, costKnown: false }, verification: 'unverified' });
  const consultations = {
    profiles: () => [{ profile: 'Fixture Reviewer', provider: 'mock', model: 'reviewer' }],
    list: () => [],
    cancel: () => false,
    async start(request: ConsultationRequest, runtime: ConsultationRuntime) {
      assert.equal(runtime.signal.aborted, false); starts.push(request);
      return result('Fixture reviewer completed without a provider request.');
    },
    async followUp(id: string, prompt: string, runtime: ConsultationRuntime) {
      assert.equal(runtime.signal.aborted, false); followUps.push({ id, prompt });
      return result('Fixture follow-up retained the consultation identifier.');
    },
  } as unknown as ConsultationService;
  const nativeCalls: Array<{ name: string; input: unknown; signal: AbortSignal }> = [];
  const runNativeTool: NonNullable<TuiOpts['runNativeTool']> = async (name, input, signal) => {
    nativeCalls.push({ name, input, signal });
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    throw new Error('Fixture worker cancelled');
  };
  let providerRequests = 0;
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const log = SessionLog.open(root);
  const terminal = new HeadlessTerminal(120, 36);
  const app = new ShadowApp({
    provider: { name: 'mock', estimateTokens: () => 1, async *send() { providerRequests++; yield { type: 'done', stopReason: 'end_turn' }; } },
    cfg, bus: new EventBus(), registry: new ToolRegistry(), sessionLog: log,
    context: new Context({ contextBudget: 32768, triggerRatio: .8, keepLastTurns: 4 }),
    system: 'Controlled terminal fixture.', workspaceRoot: root, autonomy: 'manual', bypass: false, offline: true, version: 'test',
    consultations, runNativeTool,
  }, terminal);
  const inspect = app as unknown as { tui: TuiAltScreen; editor: SnowfallEditor; running: boolean; runSlash(command: string): void };
  const run = app.run();
  const screen = () => terminal.lines().join('\n');
  try {
    inspect.editor.setText('Keep this draft.');
    inspect.runSlash('/review'); await terminal.flush();
    assert.match(screen(), /Review scope/);
    terminal.input('\x1b');
    assert.equal(inspect.editor.getText(), 'Keep this draft.', 'cancelled review leaves the composer intact');
    inspect.runSlash('/review'); terminal.input('\r'); await terminal.flush();
    assert.match(screen(), /Uncommitted changes/);
    assert.match(screen(), /tracked\.ts/); assert.match(screen(), /untracked\.ts/);
    terminal.input('\r'); terminal.resize(80, 24); await terminal.flush();
    assert.match(screen(), /\+export const answer = 2/);
    assert.match(screen(), /Esc files/);
    terminal.input('\x1b'); terminal.input('r'); await terminal.flush();
    assert.match(screen(), /Choose a read-only reviewer/);
    assert.match(screen(), /Fixture Reviewer/);
    terminal.input('2'); terminal.input('\r');
    await until(() => starts.length === 1 && !inspect.running, 'selected reviewer completes');
    assert.equal(starts[0]!.profile, 'Fixture Reviewer');
    assert.match(starts[0]!.prompt, /tracked\.ts/);
    assert.match(starts[0]!.prompt, /findings/);
    assert.equal(inspect.editor.getText(), 'Keep this draft.');

    inspect.editor.setText(''); inspect.runSlash('/consult'); await terminal.flush();
    assert.match(screen(), /Consult a model/);
    terminal.input('\x1b[B'); terminal.input('\r');
    assert.equal(inspect.editor.getText(), '/consult "Fixture Reviewer" ');
    terminal.input('Inspect the controlled fixture.'); terminal.input('\r');
    await until(() => starts.length === 2 && !inspect.running, 'consultation draft dispatches');
    assert.deepEqual(starts[1], { profile: 'Fixture Reviewer', prompt: 'Inspect the controlled fixture.' });
    terminal.input('/consult follow consult-fixture Explain the result.'); terminal.input('\r');
    await until(() => followUps.length === 1 && !inspect.running, 'follow-up completes');
    assert.deepEqual(followUps, [{ id: 'consult-fixture', prompt: 'Explain the result.' }]);

    terminal.input('/table'); terminal.input('\r'); await terminal.flush();
    assert.match(screen(), /Collaboration presets/);
    terminal.input('\r');
    assert.equal(inspect.editor.getText(), '/team second-opinion ');
    terminal.input('Review the controlled fixture.'); terminal.input('\r');
    await until(() => nativeCalls.length === 1 && inspect.running, 'native collaboration starts without a model round trip');
    assert.equal(nativeCalls[0]!.name, 'collaborate');
    assert.equal((nativeCalls[0]!.input as { preset: string }).preset, 'second-opinion');
    terminal.resize(100, 30); inspect.runSlash('/review'); await terminal.flush();
    assert.match(screen(), /Finish the current turn before \/review/);
    assert.equal(inspect.tui.hasOverlay(), false, 'review cannot start a competing foreground operation');
    inspect.runSlash('/effort'); await terminal.flush();
    assert.match(screen(), /Reasoning effort/);
    terminal.input('\x1b');
    assert.equal(inspect.tui.hasOverlay(), false);
    assert.equal(nativeCalls[0]!.signal.aborted, false, 'first Escape closes the focused overlay');
    assert.equal(inspect.running, true);
    terminal.input('\x1b');
    await until(() => !inspect.running, 'second Escape cancels the native collaboration');
    assert.equal(nativeCalls[0]!.signal.aborted, true);
    await terminal.flush(); assert.match(screen(), /interrupted/);
    assert.equal(providerRequests, 0, 'explicit consultation and team routes never ask the lead model to interpret a command');
    assert.match(git('diff', '--', 'tracked.ts'), /\+export const answer = 2;/, 'read-only review preserves the actual working change');
  } finally { app.stop(); await run; log.close(); terminal.screen.dispose(); }
});
