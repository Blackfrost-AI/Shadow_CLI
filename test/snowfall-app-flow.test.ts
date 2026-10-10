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
import type { FlattenItem } from '../src/tui/flatten.js';
import type { ShadowAutocompleteProvider } from '../src/app/autocomplete.js';
import type { LoopEvent } from '../src/agent/events.js';
import type { ToolDetail } from '../src/app/activity.js';
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
const { grep } = await import('../src/tools/grep.js');
const { SessionLog } = await import('../src/state/session.js');
const { listResumableSessions, trustLegacySession } = await import('../src/state/resume.js');
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

test('/effort offers completions and a cancelable picker, persists the choice and sends it to the provider', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-effort-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sent: Array<string | undefined> = [];
  const provider: Provider = {
    name: 'mock', estimateTokens: () => 20,
    async *send(request): AsyncIterable<ProviderEvent> {
      sent.push(request.effort);
      yield { type: 'text', delta: 'Effort received.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', effort: 'high', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const log = SessionLog.open(root);
  const terminal = new HeadlessTerminal(120, 36);
  const app = new ShadowApp({
    provider, cfg, bus: new EventBus(), registry: new ToolRegistry(), sessionLog: log,
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    system: 'Effort test.', workspaceRoot: root, autonomy: 'manual', bypass: false, offline: true, version: 'test',
  }, terminal);
  const inspect = app as unknown as { tui: TuiAltScreen; editor: SnowfallEditor; running: boolean; autocomplete: ShadowAutocompleteProvider; runSlash(command: string): void };
  const run = app.run();
  const screen = () => terminal.lines().join('\n');
  try {
    terminal.input('/effort ');
    await terminal.flush();
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) assert.ok(screen().includes(level));
    const found = await inspect.autocomplete.getSuggestions(['/effort X'], 0, 9, { signal: new AbortController().signal });
    assert.deepEqual(found?.items.map((item) => item.value), ['xhigh']);
    terminal.input('\x1b');
    inspect.editor.setText('');
    terminal.input('/effort');
    await terminal.flush();
    terminal.input('\r');
    await terminal.flush();
    assert.ok(inspect.tui.hasOverlay());
    assert.match(screen(), /Reasoning effort · current: high/);
    assert.equal(cfg.effort, 'high', 'opening the menu must not change effort');
    terminal.input('\x1b[B');
    terminal.input('\x1b');
    assert.equal(cfg.effort, 'high', 'Escape cancels a highlighted choice');
    inspect.runSlash('/effort');
    terminal.input('5');
    assert.equal(cfg.effort, 'high', 'numbers select without committing');
    terminal.input('\r');
    assert.equal(cfg.effort, 'max');
    await until(() => JSON.parse(readFileSync(join(GLOBAL_DIR, 'config.json'), 'utf8')).effort === 'max', 'effort persists');
    inspect.runSlash('/effort invalid');
    assert.equal(cfg.effort, 'max');
    inspect.runSlash('/effort');
    terminal.input('\x1b[A');
    terminal.input('\r');
    assert.equal(cfg.effort, 'xhigh');
    terminal.input('Confirm the selected effort.'); terminal.input('\r');
    await until(() => sent.length === 1 && !inspect.running, 'the next prompt completes');
    assert.deepEqual(sent, ['xhigh']);
    inspect.runSlash('/effort LOW');
    assert.equal(cfg.effort, 'low', 'explicit arguments still work');
  } finally { app.stop(); await run; log.close(); terminal.screen.dispose(); }
});

test('thinking previews while streaming, folds after completion or Escape, and expands across repaint', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-thinking-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let releaseThinking!: () => void;
  let releaseAnswer!: () => void;
  const thinkingGate = new Promise<void>((resolve) => { releaseThinking = resolve; });
  const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
  const thinking = Array.from({ length: 7 }, (_, i) => `Reasoning step ${i + 1}: inspect the layout.`).join('\n');
  let calls = 0;
  const provider: Provider = {
    name: 'mock', estimateTokens: () => 20,
    async *send(request): AsyncIterable<ProviderEvent> {
      calls++;
      if (calls === 1) {
        yield { type: 'thinking', delta: thinking };
        await thinkingGate;
        yield { type: 'thinking_block', thinking, signature: 'fixture-signature' };
        yield { type: 'text', delta: 'The answer is separate.\n\nHere is the result.' };
        await answerGate;
      } else if (calls === 2) {
        yield { type: 'thinking', delta: 'Checking the interrupted task.' };
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      } else {
        yield { type: 'text', delta: 'Fresh answer without reasoning.' };
      }
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const log = SessionLog.open(root);
  const terminal = new HeadlessTerminal(120, 36);
  const app = new ShadowApp({
    provider, cfg, bus: new EventBus(), registry: new ToolRegistry(), sessionLog: log,
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    system: 'Thinking layout test.', workspaceRoot: root, autonomy: 'manual', bypass: false, offline: true, version: 'test',
  }, terminal);
  const inspect = app as unknown as {
    tui: TuiAltScreen; running: boolean; items: FlattenItem[]; streamBuf: string; runStart: number;
    reasoning: { item: FlattenItem; startedAt: number | null } | null; repaintFromContext(): void;
  };
  const run = app.run();
  const screen = () => terminal.lines().join('\n');
  try {
    terminal.input('Review the layout.'); terminal.input('\r');
    await until(() => !!inspect.reasoning, 'thinking arrives before any answer');
    inspect.reasoning!.startedAt! -= 65000;
    inspect.runStart -= 65000;
    await until(() => (inspect.reasoning?.item.durationMs ?? 0) >= 65000, 'live thinking clock reaches minutes');
    await terminal.flush();
    assert.match(screen(), /Thinking · 1m/);
    assert.match(terminal.lines().at(-1)!, /working 1m/);
    assert.match(screen(), /Reasoning step 7/);
    assert.doesNotMatch(screen(), /Reasoning step 1/);
    terminal.input('\x0f'); await terminal.flush();
    assert.match(screen(), /Reasoning step 1/);
    assert.match(screen(), /Ctrl\+O compact/);
    terminal.input('\x0f'); await terminal.flush();
    assert.doesNotMatch(screen(), /Reasoning step 1/);
    for (const [width, height] of [[40, 12], [28, 8], [120, 36]]) {
      terminal.resize(width!, height!); inspect.tui.renderNow(true); await terminal.flush();
      assert.ok(terminal.screen.buffer.active.cursorY < height!);
      assert.match(terminal.lines().at(-1)!, /manual/);
    }
    releaseThinking();
    await until(() => inspect.streamBuf.includes('Here is the result.'), 'answer streams after thinking');
    await terminal.flush();
    const trace = inspect.items.find((item) => item.kind === 'reasoning')!;
    const duration = trace.durationMs;
    assert.equal(trace.reasoningState, 'complete');
    assert.match(screen(), /Thought for 1m/);
    assert.match(screen(), /Ctrl\+O expand/);
    assert.doesNotMatch(screen(), /Reasoning step/);
    assert.ok(screen().indexOf('Thought for 1m') < screen().indexOf('The answer is separate.'));
    terminal.input('\x0f'); await terminal.flush();
    assert.match(screen(), /Reasoning step 1/);
    assert.match(screen(), /Reasoning step 7/);
    assert.ok(screen().indexOf('Reasoning step 7') < screen().indexOf('The answer is separate.'));
    terminal.input('\x0f'); await terminal.flush();
    assert.doesNotMatch(screen(), /Reasoning step/);
    await pause(1100);
    assert.equal(trace.durationMs, duration, 'the thinking timer freezes while the answer streams');
    releaseAnswer();
    await until(() => !inspect.running, 'the first turn completes');
    assert.equal(inspect.items.filter((item) => item.kind === 'reasoning').length, 1, 'reasoning_done updates the original panel');
    assert.ok(inspect.items.some((item) => /done · 1m/.test(item.text)));
    inspect.repaintFromContext();
    await terminal.flush();
    assert.match(screen(), /Ctrl\+O expand/);
    assert.doesNotMatch(screen(), /Reasoning step/);
    terminal.input('\x0f'); await terminal.flush();
    assert.match(screen(), /Reasoning step 1/);
    assert.match(screen(), /Reasoning step 7/);
    assert.ok(screen().indexOf('Reasoning step 7') < screen().indexOf('The answer is separate.'));
    terminal.input('\x0f'); await terminal.flush();
    terminal.input('A task I will interrupt.'); terminal.input('\r');
    await until(() => calls === 2 && !!inspect.reasoning, 'the next turn starts a fresh panel');
    terminal.input('\x1b'); terminal.input('\x1b');
    await until(() => !inspect.running, 'Escape cancels while thinking');
    assert.equal(inspect.reasoning, null);
    const interrupted = inspect.items.find((item) => item.text === 'Checking the interrupted task.')!;
    assert.equal(interrupted.reasoningState, 'interrupted');
    assert.equal(inspect.items.filter((item) => item.text.includes('⏹ interrupted')).length, 1);
    await terminal.flush();
    assert.match(screen(), /Thinking interrupted/);
    assert.doesNotMatch(screen(), /Checking the interrupted task\./);
    terminal.input('\x0f'); await terminal.flush();
    assert.match(screen(), /Checking the interrupted task\./);
    terminal.input('\x0f'); await terminal.flush();
    assert.doesNotMatch(screen(), /Checking the interrupted task\./);
    terminal.input('Continue with a new answer.'); terminal.input('\r');
    await until(() => calls === 3 && !inspect.running, 'next prompt completes without stale thinking');
    assert.equal(inspect.items.filter((item) => item.kind === 'reasoning').length, 2);
    assert.ok(!inspect.items.some((item) => item.reasoningState === 'streaming'));
  } finally {
    releaseThinking(); releaseAnswer(); app.stop(); await run; log.close(); terminal.screen.dispose();
  }
});

for (const whitespaceThinking of [false, true]) test(`a provider with ${whitespaceThinking ? 'whitespace-only' : 'no'} reasoning groups real grep findings and preserves matches in expansion and activity`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-grep-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'alpha.ts'), 'const alpha_marker = "KEEP_ALPHA_MATCH";\n');
  writeFileSync(join(root, 'src', 'beta.ts'), 'const beta_marker = "KEEP_BETA_MATCH";\n');
  let calls = 0;
  const provider: Provider = {
    name: 'mock', estimateTokens: () => 20,
    async *send(): AsyncIterable<ProviderEvent> {
      calls++;
      if (whitespaceThinking) yield { type: 'thinking', delta: ' \n\t ' };
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
  const findings: Extract<LoopEvent, { type: 'finding' }>[] = [];
  const detach = bus.on((event) => { if (event.type === 'finding') findings.push(event); });
  const registry = new ToolRegistry();
  registry.register(grep);
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const log = SessionLog.open(root);
  const terminal = new HeadlessTerminal(140, 48);
  const app = new ShadowApp({
    provider, cfg, bus, registry, sessionLog: log,
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    system: 'Grep layout test.', workspaceRoot: root, autonomy: 'auto-read', bypass: false, offline: true, version: 'test',
  }, terminal);
  const inspect = app as unknown as {
    tui: TuiAltScreen; running: boolean; items: FlattenItem[]; details: ToolDetail[];
    runSlash(command: string): void;
  };
  const run = app.run();
  const screen = () => terminal.lines().join('\n');
  try {
    terminal.input('Search the two fixture files.'); terminal.input('\r');
    await until(() => calls === 2 && !inspect.running, 'the real loop runs both grep calls and receives the answer');
    await terminal.flush();
    assert.deepEqual(findings.map((finding) => [finding.toolName, finding.toolCallId]), [
      ['grep', 'grep-alpha'], ['grep', 'grep-beta'],
    ], 'the real tool findings carry explicit provenance');
    assert.equal(inspect.items.filter((item) => item.kind === 'reasoning').length, 0, 'no API reasoning means no synthetic panel');
    assert.doesNotMatch(screen(), /Thinking|Thought for/);
    assert.equal(inspect.items.filter((item) => item.kind === 'finding').length, 0, 'grep info is not duplicated as standalone cards');
    const tools = inspect.items.filter((item) => item.kind === 'tool');
    assert.equal(tools.length, 2);
    assert.equal(inspect.items.indexOf(tools[1]!), inspect.items.indexOf(tools[0]!) + 1, 'findings do not break a consecutive search group');
    assert.match(screen(), /Grep 2 patterns/);
    assert.match(screen(), /\/activity/);
    assert.doesNotMatch(screen(), /KEEP_ALPHA_MATCH|KEEP_BETA_MATCH/);
    terminal.input('\x0f'); await terminal.flush();
    assert.match(screen(), /alpha\.ts:1:7.*KEEP_ALPHA_MATCH/);
    assert.match(screen(), /beta\.ts:1:7.*KEEP_BETA_MATCH/);
    terminal.input('\x0f'); await terminal.flush();
    assert.doesNotMatch(screen(), /KEEP_ALPHA_MATCH|KEEP_BETA_MATCH/);
    assert.ok(inspect.details[0]!.body?.some((line) => line.includes('KEEP_ALPHA_MATCH')));
    assert.ok(inspect.details[1]!.body?.some((line) => line.includes('KEEP_BETA_MATCH')));
    inspect.runSlash('/activity'); await terminal.flush();
    assert.ok(inspect.tui.hasOverlay());
    assert.match(screen(), /KEEP_ALPHA_MATCH/);
    assert.match(screen(), /KEEP_BETA_MATCH/);
    terminal.input('\x1b'); await terminal.flush();
    assert.equal(inspect.tui.hasOverlay(), false);

    const notices: Extract<LoopEvent, { type: 'finding' }>[] = [
      { type: 'finding', title: 'grep: standalone notice', body: 'UNTAGGED_INFO_BODY', severity: 'info' },
      { type: 'finding', title: 'Missing call provenance', body: 'MISSING_CALL_BODY', severity: 'info', toolName: 'grep' },
      { type: 'finding', title: 'Missing tool provenance', body: 'MISSING_TOOL_BODY', severity: 'info', toolCallId: 'grep-alpha' },
      { type: 'finding', title: 'Unmatched attributed notice', body: 'UNMATCHED_INFO_BODY', severity: 'info', toolName: 'grep', toolCallId: 'unmatched-call' },
      { type: 'finding', title: 'Uncaptured body on an existing call', body: 'NEW_BODY_FOR_EXISTING_CALL', severity: 'info', toolName: 'grep', toolCallId: 'grep-beta' },
      { type: 'finding', title: 'Other tool notice', body: 'OTHER_TOOL_BODY', severity: 'info', toolName: 'read_file', toolCallId: 'read-note' },
      { type: 'finding', title: 'Search warning', body: 'WARNING_BODY', severity: 'warn', toolName: 'grep', toolCallId: 'grep-warning' },
      { type: 'finding', title: 'Search error', body: 'ERROR_BODY', severity: 'error', toolName: 'grep', toolCallId: 'grep-error' },
    ];
    for (const notice of notices) bus.emit(notice);
    await terminal.flush();
    const visibleFindings = inspect.items.filter((item) => item.kind === 'finding');
    assert.deepEqual(visibleFindings.map((item) => item.text), notices.map((notice) => notice.body));
    for (const notice of notices) assert.ok(screen().includes(notice.body), `${notice.title}: standalone body remains visible`);
    for (const severity of ['warn', 'error'] as const) {
      const title = `Captured search body still carries ${severity}`;
      bus.emit({ ...findings[1]!, title, severity });
      await terminal.flush();
      const notice = inspect.items.find((item) => item.kind === 'finding' && item.title === title);
      assert.equal(notice?.text, findings[1]!.body, `${severity} stays standalone even when call ID and captured body match`);
      assert.ok(screen().includes(title));
      assert.match(screen(), /KEEP_BETA_MATCH/);
    }
    assert.equal(calls, 2, 'expansion and activity inspection make no provider calls');
  } finally { detach(); app.stop(); await run; log.close(); terminal.screen.dispose(); }
});

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
  const bindingsDir = join(root, 'owner-bindings');
  const opts: TuiOpts = {
    provider, cfg, bus: new EventBus(), registry: new ToolRegistry(),
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    sessionLog: first, system: 'Session naming test.', workspaceRoot: root,
    autonomy: 'manual', bypass: false, offline: true, version: '10.0.0-test',
    harnessBindingsDir: bindingsDir,
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
    trustLegacySession(first.path, { bindingsDir });
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
