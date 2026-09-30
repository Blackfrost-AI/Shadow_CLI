import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import { assertStoreIsolated, isolateHome } from './helpers/isolateHome.js';
import type { ModelEntry } from '../src/config.js';
import type { FlattenItem } from '../src/tui/flatten.js';
import type { BuildResult } from '../src/app/modelSwitch.js';
import type { Provider } from '../src/provider/provider.js';

const isolated = isolateHome('pi-release-integrity');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, isolated.home);
const { ShadowApp } = await import('../src/app/app.js');
const { ModelSwitcher } = await import('../src/app/modelSwitch.js');
const { SessionApprovals } = await import('../src/agent/approval.js');
const { TodoList } = await import('../src/agent/todo.js');
const { PlanModeState } = await import('../src/agent/planMode.js');
const { SessionLog } = await import('../src/state/session.js');
const { createReadTracker } = await import('../src/tools/readTracker.js');

after(() => rmSync(isolated.home, { recursive: true, force: true }));

type OutputLine = Partial<FlattenItem>;

interface AppHarness {
  runSlash(raw: string): void;
  installInputHandling(): void;
  onBusEvent(event: Record<string, unknown>): void;
  submit(raw: string): void;
  startTurn(task: string): void;
  flushQueue(): void;
  selectModel(entry: ModelEntry): void;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionTurns: number;
  previousTurnInputTokens: number;
  previousTurnOutputTokens: number;
  previousTurnCostUSD: number;
  costUSD: number;
  contextPct: number;
  lastUsage: Record<string, number> | null;
  queued: string[];
  imageAttachments: unknown[];
  todos: Array<{ id: string; subject: string; status: string }>;
  planMode: boolean;
  first: boolean;
}

function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'shadow-pi-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function textOf(output: OutputLine[]): string {
  return output
    .map((line) => [line.text, ...(line.lines ?? []).map((child) => child.text)].filter(Boolean).join('\n'))
    .join('\n');
}

function commandHarness(root: string, state: Record<string, unknown> = {}) {
  const output: OutputLine[] = [];
  const cfg = {
    provider: 'mock',
    model: 'mock-model',
    models: [],
    contextBudget: 128_000,
    sandbox: 'auto',
    temperature: 1,
  };
  const app = Object.assign(Object.create(ShadowApp.prototype), {
    opts: { workspaceRoot: root, version: '9.0.0-test', cfg },
    running: false,
    compacting: false,
    modelChecking: false,
    exiting: false,
    switcher: { isSwitching: false },
    autonomy: 'manual',
    current: { provider: 'mock', model: 'mock-model' },
    activeTarget: { selfHosted: false },
    contextPct: 0,
    costUSD: 0,
    sessionInputTokens: 0,
    sessionOutputTokens: 0,
    sessionTurns: 0,
    previousTurnInputTokens: 0,
    previousTurnOutputTokens: 0,
    previousTurnCostUSD: 0,
    lastUsage: null,
    goal: null,
    planMode: false,
    style: 'proactive',
    queued: [],
    todos: [],
    tui: { requestRender() {} },
    pushLine: (line: OutputLine) => output.push(line),
    ...state,
  }) as unknown as AppHarness;
  return { app, cfg, output, text: () => textOf(output) };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('pi accrues deltas from turn-cumulative usage frames and /cost reports session totals', (t) => {
  const h = commandHarness(workspace(t));
  h.app.sessionTurns = 1;

  h.app.onBusEvent({ type: 'usage', inputTokens: 100, outputTokens: 10, costUSD: 0.01, contextPct: 0.1 });
  h.app.onBusEvent({ type: 'usage', inputTokens: 150, outputTokens: 25, costUSD: 0.015, contextPct: 0.2 });

  // runTurn resets these three counters at each turn boundary. Preserve the session totals and
  // feed a second turn's cumulative frames through the same event reducer.
  h.app.sessionTurns = 2;
  h.app.previousTurnInputTokens = 0;
  h.app.previousTurnOutputTokens = 0;
  h.app.previousTurnCostUSD = 0;
  h.app.onBusEvent({ type: 'usage', inputTokens: 40, outputTokens: 4, costUSD: 0.004, contextPct: 0.25 });
  h.app.onBusEvent({ type: 'usage', inputTokens: 60, outputTokens: 7, costUSD: 0.006, contextPct: 0.3 });

  assert.equal(h.app.sessionInputTokens, 210);
  assert.equal(h.app.sessionOutputTokens, 32);
  assert.ok(Math.abs(h.app.costUSD - 0.021) < 1e-12);
  assert.equal(h.app.contextPct, 0.3);

  h.app.runSlash('/cost');
  assert.match(h.text(), /Session \(2 turns\): 210 in · 32 out · 242 total/);
  assert.match(h.text(), /Session cost: \$0\.0210/);
  assert.match(h.text(), /Last turn: 60 in · 7 out · \$0\.0060/);
});

test('pi /clear resets every conversation-scoped approval, read, attachment, todo, usage, plan, and queue state', (t) => {
  const root = workspace(t);
  const approvals = new SessionApprovals();
  approvals.approveTool('run_shell');
  approvals.approvePrefix('npm test');
  const readTracker = createReadTracker();
  const seenPath = join(root, 'seen.txt');
  writeFileSync(seenPath, 'before\n');
  readTracker.markSeen(seenPath);
  const todoList = new TodoList();
  todoList.write([{ subject: 'ship release', status: 'in_progress' }]);
  const planModeState = new PlanModeState(true);
  let contextResets = 0;
  let transcriptClears = 0;
  let splashShows = 0;
  let forcedRenders = 0;

  const h = commandHarness(root, {
    opts: {
      workspaceRoot: root,
      version: '9.0.0-test',
      cfg: { provider: 'mock', model: 'mock-model', models: [], contextBudget: 128_000, sandbox: 'auto' },
      context: { reset: () => contextResets++ },
      todoList,
      planMode: planModeState,
    },
    approvals,
    readTracker,
    items: [{ id: 1, kind: 'assistant', text: 'old answer' }],
    cellById: new Map([[1, {}]]),
    transcript: { clear: () => transcriptClears++ },
    details: [{ n: 1 }],
    lineId: 9,
    brandCommitted: true,
    queued: ['queued prompt'],
    imageAttachments: [{ mediaType: 'image/png', data: 'encoded' }],
    todos: todoList.snapshot(),
    contextPct: 0.77,
    costUSD: 1.25,
    sessionInputTokens: 900,
    sessionOutputTokens: 100,
    sessionTurns: 3,
    previousTurnInputTokens: 400,
    previousTurnOutputTokens: 50,
    previousTurnCostUSD: 0.75,
    lastUsage: { inputTokens: 400, outputTokens: 50, costUSD: 0.75, contextPct: 0.77 },
    planMode: true,
    first: false,
    showSplash: () => splashShows++,
    tui: { requestRender() {}, renderNow: () => forcedRenders++ },
  });

  h.app.runSlash('/clear');

  assert.equal(contextResets, 1);
  assert.equal(transcriptClears, 1);
  assert.equal(splashShows, 1);
  assert.equal(forcedRenders, 1);
  assert.equal(approvals.hasTool('run_shell'), false);
  assert.deepEqual(approvals.listPrefixes(), []);
  assert.equal(readTracker.hasSeen(seenPath), false);
  assert.deepEqual(h.app.imageAttachments, []);
  assert.deepEqual(h.app.queued, []);
  assert.deepEqual(h.app.todos, []);
  assert.deepEqual(todoList.snapshot(), []);
  assert.equal(h.app.contextPct, 0);
  assert.equal(h.app.costUSD, 0);
  assert.equal(h.app.sessionInputTokens, 0);
  assert.equal(h.app.sessionOutputTokens, 0);
  assert.equal(h.app.sessionTurns, 0);
  assert.equal(h.app.previousTurnInputTokens, 0);
  assert.equal(h.app.previousTurnOutputTokens, 0);
  assert.equal(h.app.previousTurnCostUSD, 0);
  assert.equal(h.app.lastUsage, null);
  assert.equal(h.app.planMode, false);
  assert.equal(planModeState.active, false);
  assert.equal(h.app.first, true);
});

test('pi Esc interrupts a running turn even when the composer holds an unsent draft', (t) => {
  let listener: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let aborts = 0;
  let draft = 'keep this unsent draft';
  let draftWrites = 0;
  const h = commandHarness(workspace(t), {
    running: true,
    controller: { abort: () => aborts++ },
    editor: {
      getText: () => draft,
      setText: (next: string) => {
        draft = next;
        draftWrites++;
      },
    },
    tui: {
      addInputListener: (next: (data: string) => { consume?: boolean } | undefined) => {
        listener = next;
      },
      requestRender() {},
    },
  });

  h.app.installInputHandling();
  const result = listener?.('\x1b');

  assert.equal(aborts, 1);
  assert.equal(draft, 'keep this unsent draft');
  assert.equal(draftWrites, 0);
  assert.deepEqual(result, { consume: true });
  assert.match(h.text(), /interrupted/);
});

test('pi keeps submit, direct start, and queue flush behind an in-flight model-switch barrier', async (t) => {
  const root = workspace(t);
  const h = commandHarness(root);
  const pending = deferred<BuildResult>();
  const started: string[] = [];
  const history: string[] = [];
  let draft = 'from submit';
  let provider = {
    name: 'before',
    async *send() {},
    estimateTokens: () => 0,
  } as Provider;
  let current = { provider: 'mock', model: 'before' };
  const cfg = { model: 'before', lastModel: 'Before' };
  const switcher = new ModelSwitcher({
    cfg: cfg as never,
    context: {} as never,
    baseContextPolicy: { contextBudget: 128_000, triggerRatio: 0.85, keepLastTurns: 4 },
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
      return null;
    },
    pushLine: (line) => h.output.push(line),
    isRunning: () => false,
  });
  (switcher as unknown as { buildProvider(entry: ModelEntry): Promise<BuildResult> }).buildProvider = () => pending.promise;
  Object.assign(h.app, {
    switcher,
    editor: {
      addToHistory: (value: string) => history.push(value),
      getText: () => draft,
      setText: (value: string) => {
        draft = value;
      },
    },
    hudState: () => ({}),
    commitBrandLine() {},
    runTurn: async (task: string) => {
      started.push(task);
    },
  });

  const entry: ModelEntry = { label: 'After', provider: 'mock', model: 'after' };
  h.app.selectModel(entry);
  assert.equal(switcher.isSwitching, true);

  h.app.submit('from submit');
  h.app.startTurn('from direct start');
  h.app.flushQueue();
  assert.deepEqual(started, []);
  assert.deepEqual(h.app.queued, ['from submit', 'from direct start']);
  assert.deepEqual(history, ['from submit']);

  const nextProvider = {
    name: 'after',
    async *send() {},
    estimateTokens: () => 0,
  } as Provider;
  pending.resolve({
    ok: true,
    client: nextProvider,
    provider: 'mock',
    model: 'after',
    entryModel: 'after',
    selfHosted: false,
  });
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(switcher.isSwitching, false);
  assert.equal(cfg.lastModel, 'After');
  assert.deepEqual(started, ['from submit'], 'the switch helper releases exactly the first queued turn');
  assert.deepEqual(h.app.queued, ['from direct start']);
  h.app.flushQueue();
  assert.deepEqual(started, ['from submit', 'from direct start']);
  assert.deepEqual(h.app.queued, []);
});

test('pi /status includes the active profile and every contributed key', (t) => {
  const h = commandHarness(workspace(t));
  Object.assign(h.cfg, {
    activeProfile: 'deep-review',
    profile: { model: 'mock-model', effort: 'max', contextBudget: 128_000 },
  });

  h.app.runSlash('/status');

  assert.match(h.text(), /profile\s+deep-review/);
  assert.match(h.text(), /model=mock-model/);
  assert.match(h.text(), /effort=max/);
  assert.match(h.text(), /contextBudget=128000/);
});

test('pi /export html uses the common workspace jail and bare /export writes markdown', (t) => {
  const root = workspace(t);
  const sessionLog = SessionLog.open(root);
  sessionLog.record({ kind: 'user', task: 'release integrity' });
  const outside = join(tmpdir(), `shadow-pi-escape-${basename(root)}.html`);
  rmSync(outside, { force: true });
  t.after(() => rmSync(outside, { force: true }));
  const h = commandHarness(root, {
    opts: {
      workspaceRoot: root,
      version: '9.0.0-test',
      cfg: { provider: 'mock', model: 'mock-model', models: [], contextBudget: 128_000, sandbox: 'auto' },
      sessionLog,
    },
  });

  h.app.runSlash(`/export html ${outside}`);
  h.app.runSlash('/export');

  assert.equal(existsSync(outside), false, 'an absolute output path cannot escape the workspace');
  const exportsDir = join(root, 'exports');
  const names = readdirSync(exportsDir);
  const htmlName = names.find((name) => name.endsWith('.html'));
  const markdownName = names.find((name) => name.endsWith('.md'));
  assert.ok(htmlName, 'the jailed HTML export falls back under workspace/exports');
  assert.ok(markdownName, 'bare /export writes the default Markdown artifact');
  assert.match(readFileSync(join(exportsDir, htmlName), 'utf8'), /^<!doctype html>/);
  assert.match(readFileSync(join(exportsDir, markdownName), 'utf8'), /release integrity/);
  assert.equal(h.output.filter((line) => line.kind === 'error').length, 0);
});

test('pi consumes todo subjects and plan snapshots in their emitted bus-event shapes', (t) => {
  const h = commandHarness(workspace(t));
  const todoList = new TodoList();
  const planModeState = new PlanModeState(false);
  const events: Record<string, unknown>[] = [];
  todoList.onUpdate((items) => {
    const event = { type: 'todo', items };
    events.push(event);
    h.app.onBusEvent(event);
  });
  planModeState.onUpdate((plan) => {
    const event = { type: 'plan_mode', plan };
    events.push(event);
    h.app.onBusEvent(event);
  });

  todoList.write([{ subject: 'verify release', status: 'in_progress' }]);
  planModeState.enter();
  assert.deepEqual(events[0], {
    type: 'todo',
    items: [{ id: 'todo-1', subject: 'verify release', status: 'in_progress' }],
  });
  assert.deepEqual(events[1], {
    type: 'plan_mode',
    plan: { mode: 'planning', title: undefined, path: undefined },
  });
  assert.equal(h.app.todos[0]?.subject, 'verify release');
  assert.equal(h.app.planMode, true);

  h.app.runSlash('/tasks');
  assert.match(h.text(), /▸ verify release/);

  planModeState.exit();
  assert.deepEqual(events[2], {
    type: 'plan_mode',
    plan: { mode: 'implement', title: undefined, path: undefined },
  });
  assert.equal(h.app.planMode, false);
});
