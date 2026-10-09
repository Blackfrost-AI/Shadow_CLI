import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertStoreIsolated, isolateHome } from './helpers/isolateHome.js';
import type { Message, Provider } from '../src/provider/provider.js';

// app.ts and modelSwitch.ts both reach globalStore at module load. Redirect HOME first so the
// switch persistence exercised below cannot touch a developer's real ~/.shadow/config.json.
const isolated = isolateHome('pi-session-continuity');
const previousSessionDir = process.env.SHADOW_SESSION_DIR;
const previousAllowImport = process.env.SHADOW_ALLOW_IMPORT;
delete process.env.SHADOW_SESSION_DIR;
process.env.SHADOW_ALLOW_IMPORT = '0';

const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, isolated.home);
const { Context } = await import('../src/agent/context.js');
const { loadConfig } = await import('../src/config.js');
const { ModelSwitcher } = await import('../src/app/modelSwitch.js');
const { ShadowApp } = await import('../src/app/app.js');
const { SessionLog } = await import('../src/state/session.js');
const { listRewindableTurns, rewindToTurn } = await import('../src/state/rewind.js');
const { TERMINAL_COMMANDS, terminalCommandsFor } = await import('../src/tui/commandCatalog.js');

after(() => {
  if (previousSessionDir === undefined) delete process.env.SHADOW_SESSION_DIR;
  else process.env.SHADOW_SESSION_DIR = previousSessionDir;
  if (previousAllowImport === undefined) delete process.env.SHADOW_ALLOW_IMPORT;
  else process.env.SHADOW_ALLOW_IMPORT = previousAllowImport;
  rmSync(isolated.home, { recursive: true, force: true });
});

const POLICY = { contextBudget: 10_000, triggerRatio: 0.85, keepLastTurns: 4 };

function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'shadow-pi-continuity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function message(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

function records(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('the renderer-neutral catalog advertises implemented pi commands and filters Ink-only rows', () => {
  const pi = terminalCommandsFor('pi');
  const names = pi.map((command) => command.name);

  for (const required of ['/fork', '/provider', '/local', '/mcp', '/plugins', '/table', '/team', '/consult']) {
    assert.ok(names.includes(required), `${required} is advertised by the pi command catalog`);
  }
  for (const unsupported of ['/vim', '/statusline']) {
    assert.ok(!names.includes(unsupported), `${unsupported} is omitted from pi autocomplete/help`);
    const catalogRow = TERMINAL_COMMANDS.find((command) => command.name === unsupported);
    assert.ok(catalogRow?.renderers.pi.unavailable, `${unsupported} records why pi cannot offer it`);
  }
  assert.equal(new Set(names).size, names.length, 'pi advertises each command once');
  assert.ok(pi.every((command) => command.renderers.pi.handler), 'every advertised pi row has a handler');
});

test('a successful model switch publishes the resolved runtime endpoint metadata without network I/O', async (t) => {
  const root = workspace(t);
  const cfg = loadConfig(root, { provider: 'mock', model: 'before-switch' });
  const context = new Context(POLICY);
  let provider = { name: 'before' } as Provider;
  let current = { provider: 'mock', model: 'before-switch' };
  const targets: Array<{
    baseUrl?: string;
    selfHosted: boolean;
    current: { provider: string; model: string };
    providerName: string;
  }> = [];
  const loopUpdates: Array<{ provider: Provider; model: string }> = [];
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error('unexpected network access');
  }) as typeof fetch;

  try {
    const switcher = new ModelSwitcher({
      cfg,
      context,
      baseContextPolicy: POLICY,
      get provider() {
        return provider;
      },
      set provider(next) {
        provider = next;
      },
      get current() {
        return current;
      },
      set current(next) {
        current = next;
      },
      get loop() {
        return {
          setProvider(next: Provider, model: string) {
            loopUpdates.push({ provider: next, model });
          },
        } as never;
      },
      pushLine() {},
      isRunning: () => false,
      onTargetChange(target) {
        targets.push({ ...target, current: { ...current }, providerName: provider.name });
      },
    });

    const ok = await switcher.selectModel({
      label: 'Runtime fixture',
      provider: 'openai',
      model: 'fixture-wire-model',
      apiKey: 'sk-test-only',
      baseUrl: 'https://runtime.invalid/v1',
      selfHosted: true,
    });

    assert.equal(ok, true);
    assert.equal(fetches, 0, 'constructing and selecting a provider performs no request');
    assert.deepEqual(targets, [
      {
        baseUrl: 'https://runtime.invalid/v1',
        selfHosted: true,
        current: { provider: 'openai', model: 'fixture-wire-model' },
        providerName: 'openai',
      },
    ]);
    assert.equal(loopUpdates.length, 1);
    assert.equal(loopUpdates[0]!.provider, provider, 'the loop receives the same live provider');
    assert.equal(loopUpdates[0]!.model, 'fixture-wire-model');
    assert.equal(cfg.model, 'fixture-wire-model', 'the selected preset identity becomes active');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pi /fork rebinds both the app and shared session-log holder before later writes', (t) => {
  const root = workspace(t);
  const source = SessionLog.open(root);
  source.record({ kind: 'user', task: 'source turn' });
  const sourceBefore = readFileSync(source.path, 'utf8');
  const sessionLogBox = { current: source };
  const output: Array<{ text?: string; lines?: Array<{ text: string }> }> = [];
  let approvalsCleared = 0;
  let readsCleared = 0;

  const app = Object.assign(Object.create(ShadowApp.prototype), {
    opts: { workspaceRoot: root, sessionLog: source, sessionLogBox },
    running: false,
    compacting: false,
    modelChecking: false,
    rewindable: [],
    rewindSeen: null,
    approvals: { clear: () => approvalsCleared++ },
    readTracker: { clear: () => readsCleared++ },
    pushLine: (line: { text?: string; lines?: Array<{ text: string }> }) => output.push(line),
  }) as {
    runSlash(raw: string): void;
    opts: { sessionLog: typeof source };
  };

  app.runSlash('/fork');

  assert.notEqual(sessionLogBox.current.path, source.path, 'the shared writer holder follows the fork');
  assert.equal(app.opts.sessionLog, sessionLogBox.current, 'the app fallback handle follows the same fork');
  assert.equal(approvalsCleared, 1);
  assert.equal(readsCleared, 1);
  assert.match(output.flatMap((line) => line.lines ?? []).map((line) => line.text).join('\n'), /Forked/);

  sessionLogBox.current.record({ kind: 'user', task: 'post-fork turn' });
  assert.equal(readFileSync(source.path, 'utf8'), sourceBefore, 'later shared writes leave the source byte-identical');
  assert.ok(
    records(sessionLogBox.current.path).some((record) => record.task === 'post-fork turn'),
    'later shared writes land in the fork',
  );
});

test('pi /session reports the live id and refreshes its turn count', (t) => {
  const root = workspace(t);
  const log = SessionLog.open(root);
  const context = new Context(POLICY);
  context.pinTask(message('user', 'session prompt'));
  context.append(message('assistant', 'session answer'));
  log.recordSnapshot(context, 0);
  const output: Array<{ text?: string; lines?: Array<{ text: string }> }> = [];
  const app = Object.assign(Object.create(ShadowApp.prototype), {
    opts: { workspaceRoot: root, sessionLog: log, context },
    rewindable: [],
    rewindSeen: null,
    pushLine: (line: { text?: string; lines?: Array<{ text: string }> }) => output.push(line),
  }) as { runSlash(raw: string): void };

  app.runSlash('/session');

  const text = output.flatMap((line) => line.lines ?? []).map((line) => line.text).join('\n');
  assert.match(text, new RegExp(SessionLog.sessionIdFromPath(log.path)));
  assert.match(text, /messages\s+2/);
  assert.match(text, /turns logged 1/);
});

test('pi /rewind persists the rewound chat state and prefills the next discarded prompt without a TTY', (t) => {
  const root = workspace(t);
  const log = SessionLog.open(root);
  const history = new Context(POLICY);
  history.pinTask(message('user', 'first prompt'));
  history.append(message('assistant', 'first answer'));
  log.recordSnapshot(history, 0);
  history.append(message('user', 'second prompt'));
  history.append(message('assistant', 'second answer'));
  log.recordSnapshot(history, 1);

  const live = new Context(POLICY);
  live.loadState(history.exportState());
  const drafts: string[] = [];
  let repaints = 0;
  const output: Array<{ text?: string }> = [];
  let readsCleared = 0;
  const snapshotsBefore = records(log.path).filter((record) => record.kind === 'context_snapshot').length;
  let confirmation: { handleInput(data: string): void } | undefined;

  const app = Object.assign(Object.create(ShadowApp.prototype), {
    opts: {
      workspaceRoot: root,
      sessionLog: log,
      sessionLogBox: { current: log },
      cfg: {
        contextBudget: POLICY.contextBudget,
        summarizeTriggerRatio: POLICY.triggerRatio,
        keepLastTurns: POLICY.keepLastTurns,
      },
      context: live,
    },
    running: false,
    compacting: false,
    modelChecking: false,
    first: true,
    rewindable: listRewindableTurns(log.path),
    rewindSeen: null,
    editor: { setText: (text: string) => drafts.push(text) },
    terminal: { rows: 40 },
    tui: {
      showOverlay: (picker: { handleInput(data: string): void }) => { confirmation = picker; return { hide() {} }; },
      requestRender() {}, setFocus() {},
    },
    repaintFromContext: () => repaints++,
    readTracker: { clear: () => readsCleared++ },
    pushLine: (line: { text?: string }) => output.push(line),
  }) as {
    runSlash(raw: string): void;
    first: boolean;
  };

  app.runSlash('/rewind 0 --chat-only');
  assert.equal(live.messages().length, 4, 'preview does not rewind before confirmation');
  assert.ok(confirmation, 'rewind opens its confirmation picker');
  confirmation.handleInput('\r');

  assert.deepEqual(live.messages(), [message('user', 'first prompt'), message('assistant', 'first answer')]);
  assert.equal(app.first, false);
  assert.equal(repaints, 1);
  assert.deepEqual(drafts, ['second prompt'], 'the next discarded prompt is ready to edit and retry');
  assert.match(output.map((line) => line.text ?? '').join('\n'), /Rewound conversation to turn 0/);
  assert.match(output.map((line) => line.text ?? '').join('\n'), /files untouched/);
  assert.equal(readsCleared, 1, 'chat rewind drops read-before-edit evidence from discarded turns');

  const snapshotsAfter = records(log.path).filter((record) => record.kind === 'context_snapshot');
  assert.equal(snapshotsAfter.length, snapshotsBefore + 1, 'the visible rewind is appended durably');
  assert.equal(snapshotsAfter.at(-1)!.turn, 0);
  const rewindMarker = records(log.path).findLast((record) => record.kind === 'rewound_to');
  assert.equal(rewindMarker?.turn, 0);
  assert.equal(typeof rewindMarker?.sourceSnapshotOffset, 'number');
  assert.equal(typeof rewindMarker?.durableSnapshotOffset, 'number');

  const restored = rewindToTurn(log.path, 0, root, { ...POLICY, scope: 'chat' });
  assert.deepEqual(
    restored.context?.messages(),
    live.messages(),
    'a later reload resolves the newest turn-0 snapshot to the same rewound state',
  );
});
