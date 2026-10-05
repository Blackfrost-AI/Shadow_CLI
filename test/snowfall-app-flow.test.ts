import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TuiAltScreen } from '@earendil-works/pi-tui';
import type { TuiOpts } from '../src/tui.js';
import type { ApprovalGate, ApprovalDecision, ApprovalRequest } from '../src/agent/approval.js';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import type { SnowfallEditor } from '../src/app/snowfall.js';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { HeadlessTerminal } from './helpers/snowfallTerminal.js';

const isolated = isolateHome('snowfall-flow');
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
const { listResumableSessions } = await import('../src/state/resume.js');
after(() => {
  if (previousSessionDir === undefined) delete process.env.SHADOW_SESSION_DIR;
  else process.env.SHADOW_SESSION_DIR = previousSessionDir;
  rmSync(isolated.home, { recursive: true, force: true });
});

const pause = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await pause();
  assert.ok(predicate(), label);
}

test('named sessions stay in sync across the terminal title, resume picker, new conversations and forks', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-named-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const provider: Provider = {
    name: 'mock', estimateTokens: () => 20,
    async *send(): AsyncIterable<ProviderEvent> {
      calls++;
      yield { type: 'text', delta: 'Done.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const first = SessionLog.open(root);
  const opts: TuiOpts = {
    provider, cfg, bus: new EventBus(), registry: new ToolRegistry(),
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    sessionLog: first, system: 'Session naming test.', workspaceRoot: root,
    autonomy: 'manual', bypass: false, offline: true, version: '10.0.0-test',
  };
  const terminal = new HeadlessTerminal(120, 36);
  const app = new ShadowApp(opts, terminal);
  const inspect = app as unknown as {
    running: boolean;
    runSlash(command: string): void;
    commandSpecs(): Array<{ name: string; args?: (query: string) => Array<{ value: string; label: string }> }>;
  };
  const run = app.run();
  const title = () => terminal.writes.filter((write) => write.startsWith('\x1b]2;')).at(-1);
  try {
    terminal.input('Fix the login redirect'); terminal.input('\r');
    await until(() => calls === 1 && !inspect.running, 'the opening turn completes');
    assert.equal(first.title, 'Fix the login redirect');
    assert.equal(title(), '\x1b]2;Fix the login redirect — Shadow\x07');
    inspect.runSlash('/rename Website launch');
    assert.equal(title(), '\x1b]2;Website launch — Shadow\x07');
    inspect.runSlash('/new');
    assert.notEqual(opts.sessionLog.path, first.path);
    assert.equal(title(), '\x1b]2;New session — Shadow\x07');
    terminal.input('Review the database migration'); terminal.input('\r');
    await until(() => calls === 2 && !inspect.running, 'the second conversation completes');
    assert.equal(opts.sessionLog.title, 'Review the database migration');
    const names = listResumableSessions(root).map((session) => session.title);
    assert.ok(names.includes('Website launch'));
    assert.ok(names.includes('Review the database migration'));
    const matches = inspect.commandSpecs().find((command) => command.name === '/resume')!.args!('website');
    assert.deepEqual(matches.map((match) => [match.label, match.value]), [['Website launch', SessionLog.sessionIdFromPath(first.path)]]);
    inspect.runSlash('/resume');
    await terminal.flush();
    assert.match(terminal.lines().join('\n'), /Website launch/);
    assert.match(terminal.lines().join('\n'), /Review the database migration/);
    terminal.input('\x1b');
    inspect.runSlash('/resume ' + SessionLog.sessionIdFromPath(first.path));
    assert.equal(title(), '\x1b]2;Website launch — Shadow\x07');
    inspect.runSlash('/fork');
    inspect.runSlash('/rename Website follow-up');
    assert.equal(title(), '\x1b]2;Website follow-up — Shadow\x07');
    assert.equal(SessionLog.titleFor(first.path), 'Website launch');
    assert.equal(calls, 2, 'naming and session navigation make no provider requests');
    inspect.runSlash('/quit');
    await run;
  } finally {
    app.stop(); await run; opts.sessionLog.close(); terminal.screen.dispose();
  }
});

test('production fullscreen shell: commands, queued paste, interrupt, safe overlays, theme persistence and exit', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-snowfall-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.shadow/commands'), { recursive: true });
  writeFileSync(join(root, '.shadow/commands/inspect.md'), 'Inspect $ARGUMENTS without editing files.');
  writeFileSync(join(root, '.shadow/commands/quit.md'), 'This must never replace the builtin.');
  const prompts: string[] = [];
  let calls = 0;
  const provider: Provider = {
    name: 'mock', estimateTokens: () => 20,
    async *send(request): AsyncIterable<ProviderEvent> {
      calls++;
      prompts.push(JSON.stringify(request.messages));
      yield { type: 'text', delta: `Fixture answer ${calls}.` };
      if (calls === 1) await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', lastTheme: 'snowfall', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const opts: TuiOpts = {
    provider, cfg, bus: new EventBus(), registry: new ToolRegistry(),
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    sessionLog: SessionLog.open(root), system: 'Local terminal test.', workspaceRoot: root,
    autonomy: 'manual', bypass: false, offline: true, version: '10.0.0-test',
  };
  const terminal = new HeadlessTerminal(120, 36);
  const app = new ShadowApp(opts, terminal);
  const inspect = app as unknown as {
    tui: TuiAltScreen; editor: SnowfallEditor; gate: ApprovalGate;
    running: boolean; queued: string[]; streamBuf: string; items: Array<{ text: string }>;
  };
  const run = app.run();
  try {
    await terminal.flush();
    assert.match(terminal.lines().join('\n'), /SHADOW/);
    terminal.input('/inspect the  terminal');
    terminal.input('\r');
    await until(() => calls === 1 && inspect.streamBuf.includes('Fixture answer 1.'), 'custom command streams through the real agent loop');
    assert.match(prompts[0]!, /Inspect the {2}terminal without editing files/);
    const pasted = 'queued 漢字\n' + 'line\n'.repeat(30);
    terminal.input(`\x1b[200~${pasted}\x1b[201~`);
    terminal.input('\x0a'); // Ctrl+J must insert a newline while busy, not send.
    assert.equal(inspect.queued.length, 0);
    terminal.input('\r');
    assert.equal(inspect.queued.length, 1);
    assert.ok(inspect.queued[0]?.includes('line\nline'), 'expanded paste is queued, not its display badge');
    terminal.input('\x1b');
    terminal.input('\x1b'); // Repeated Escape must not duplicate the notice while cancellation unwinds.
    const interruptedAt = inspect.items.findIndex((item) => item.text.includes('⏹ interrupted'));
    const partialAt = inspect.items.findIndex((item) => item.text === 'Fixture answer 1.');
    assert.ok(partialAt >= 0 && partialAt < interruptedAt, 'partial answer is committed before its interrupt notice');
    assert.equal(inspect.items.filter((item) => item.text.includes('⏹ interrupted')).length, 1);
    await until(() => calls >= 2 && !inspect.running, 'interrupt releases the first turn and drains the queued follow-up');
    assert.match(prompts[1]!, /queued 漢字/);

    const raw = 'echo safe\x1b]52;c;fake\x07\u202e ; tail';
    const req: ApprovalRequest = { id: 'fixture', kind: 'permission', call: { id: 'tool', name: 'run_shell', input: { command: raw } }, risk: 'write', reason: 'Inspect the full command', preview: raw };
    let decision: ApprovalDecision | undefined;
    const pending = inspect.gate.request(req).then((value) => { decision = value; });
    await pause(350);
    inspect.tui.renderNow(true);
    await terminal.flush();
    const dialogText = terminal.lines().join('\n');
    assert.match(dialogText, /Permission required/);
    assert.match(dialogText, /\\x1b/);
    assert.match(dialogText, /\\u202e/);
    assert.equal((req.call.input as { command: string }).command, raw, 'only the display projection was sanitized');
    terminal.input('\x1b[102;6u'); // search over a waiting approval
    terminal.input('y');
    await terminal.flush();
    assert.equal(decision, undefined, 'typing in search cannot approve the hidden dialog');
    terminal.input('\x1b');
    terminal.input('n');
    await pending;
    assert.equal(decision, 'deny');

    terminal.input('/theme cyberpunk'); terminal.input('\r');
    await terminal.flush();
    assert.equal(JSON.parse(readFileSync(join(GLOBAL_DIR, 'config.json'), 'utf8')).lastTheme, 'cyberpunk');
    terminal.resize(40, 12); await terminal.flush();
    assert.match(terminal.lines().at(-1)!, /manual/);
    terminal.input('/quit'); terminal.input('\r');
    await run; await terminal.flush();
    assert.equal(terminal.stopped, true);
    assert.equal(terminal.screen.buffer.active.type, 'normal');
    assert.match(terminal.lines(true).join('\n'), /Fixture answer/);
  } finally { app.stop(); await run; terminal.screen.dispose(); }
});
