import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Provider, ProviderEvent, Message } from '../src/provider/provider.js';
import type { ToolContext } from '../src/tools/types.js';
import type { FlattenItem } from '../src/tui/flatten.js';
import { HeadlessTerminal } from './helpers/snowfallTerminal.js';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';

const isolated = isolateHome('snowfall-followup');
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
const { runLock } = await import('../src/web/runLock.js');
after(async () => {
  if (previousSessionDir === undefined) delete process.env.SHADOW_SESSION_DIR;
  else process.env.SHADOW_SESSION_DIR = previousSessionDir;
  await removeFixtureTree(isolated.home);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), label);
}

function latestPrompt(messages: Message[]): string {
  return messages.filter((message) => message.role === 'user').at(-1)?.content
    .filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
}

function fixture(provider: Provider, registry = new ToolRegistry()) {
  const root = mkdtempSync(join(tmpdir(), 'shadow-followup-'));
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', parallelTools: false,
    reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const log = SessionLog.open(root);
  const context = new Context({ contextBudget: 32768, triggerRatio: .8, keepLastTurns: 4 });
  const terminal = new HeadlessTerminal(120, 36);
  const wakeupHandler = { fire: (_task: string, _reason: string) => {} };
  const app = new ShadowApp({ provider, cfg, bus: new EventBus(), registry, sessionLog: log, context,
    system: 'Local follow-up fixture.', workspaceRoot: root, autonomy: 'auto-read', bypass: false,
    offline: true, version: 'test', wakeupHandler }, terminal);
  const inspect = app as unknown as {
    running: boolean; queued: string[]; controller: AbortController | null;
    streamBuf: string; items: FlattenItem[];
  };
  const run = app.run();
  return {
    cfg, context, terminal, wakeupHandler, inspect,
    send(text: string) { terminal.input(text); terminal.input('\r'); },
    async close() {
      app.stop(); await run;
      await until(() => !inspect.running, 'active turn settled before fixture cleanup');
      log.close(); terminal.screen.dispose(); await removeFixtureTree(root);
    },
  };
}

test('fullscreen follow-up steers a stalled response without Escape and preserves partial history', async () => {
  const prompts: string[] = [];
  let firstSignal: AbortSignal | undefined;
  const f = fixture({ name: 'mock', estimateTokens: () => 1,
    async *send(request): AsyncIterable<ProviderEvent> {
      prompts.push(latestPrompt(request.messages));
      if (prompts.length === 1) {
        firstSignal = request.signal;
        yield { type: 'thinking', delta: 'Reviewing the original plan.' };
        yield { type: 'text', delta: 'Partial first answer.' };
        await new Promise<void>((resolve) => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      } else yield { type: 'text', delta: 'Follow-up received.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  });
  try {
    f.send('Finish the plan.');
    await until(() => f.inspect.streamBuf.includes('Partial first'), 'first response is streaming');
    const hardAbort = f.inspect.controller!;
    f.send('Change the next step.');
    await until(() => prompts.length === 2 && !f.inspect.running, 'follow-up runs without an Escape or completed plan');
    assert.deepEqual(prompts, ['Finish the plan.', 'Change the next step.']);
    assert.equal(firstSignal?.aborted, true);
    assert.equal(hardAbort.signal.aborted, false, 'steering never hard-aborts tools');
    const messages = f.context.messages();
    assert.ok(messages.some((m) => m.role === 'assistant' && m.interrupted && m.content.some((b) => b.type === 'text' && b.text === 'Partial first answer.')));
    assert.equal(f.inspect.items.filter((item) => item.text === 'Partial first answer.').length, 1);
    assert.match(f.inspect.items.map((item) => item.text).join('\n'), /next safe boundary/);
    assert.equal(f.inspect.items.find((item) => item.kind === 'reasoning')?.reasoningState, 'complete', 'reasoning finished before the partial answer');
  } finally { await f.close(); }
});

test('fullscreen follow-up stops stalled thinking and folds the interrupted block', async () => {
  let calls = 0;
  const f = fixture({ name: 'mock', estimateTokens: () => 1,
    async *send(request): AsyncIterable<ProviderEvent> {
      calls++;
      if (calls === 1) {
        yield { type: 'thinking', delta: 'Still considering the plan.' };
        await new Promise<void>((resolve) => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      } else yield { type: 'text', delta: 'Correction received.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  });
  try {
    f.send('First.');
    await until(() => f.inspect.items.some((item) => item.kind === 'reasoning'), 'thinking has started');
    f.send('New direction.');
    await until(() => calls === 2 && !f.inspect.running, 'new message reaches the model during thinking');
    assert.equal(f.inspect.items.find((item) => item.kind === 'reasoning')?.reasoningState, 'interrupted');
  } finally { await f.close(); }
});

test('fullscreen follow-ups wait for the active tool, skip later plan calls, and drain once in FIFO order', async () => {
  const gate = deferred();
  let active: ToolContext | undefined;
  let finished = false;
  let laterRan = false;
  const registry = new ToolRegistry();
  registry.register({ name: 'active_step', description: 'Controlled current step', risk: 'read', inputSchema: z.object({}),
    async run(_input, ctx) { active = ctx; await gate.promise; finished = true;
      return { ok: true, summary: 'First step completed.', meta: { tool: 'active_step', risk: 'read', durationMs: 0 } }; } });
  registry.register({ name: 'later_step', description: 'Remaining plan step', risk: 'read', inputSchema: z.object({}),
    async run() { laterRan = true;
      return { ok: true, summary: 'Later step ran.', meta: { tool: 'later_step', risk: 'read', durationMs: 0 } }; } });
  const prompts: string[] = [];
  const f = fixture({ name: 'mock', estimateTokens: () => 1,
    async *send(request): AsyncIterable<ProviderEvent> {
      prompts.push(latestPrompt(request.messages));
      if (prompts.length === 1) {
        yield { type: 'tool_call', call: { id: 'one', name: 'active_step', input: {} } };
        yield { type: 'tool_call', call: { id: 'two', name: 'later_step', input: {} } };
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        assert.equal(finished, true, 'replacement turn cannot overlap the active tool');
        yield { type: 'text', delta: 'Received.' };
        yield { type: 'done', stopReason: 'end_turn' };
      }
    },
  }, registry);
  try {
    f.send('Execute the plan.');
    await until(() => !!active, 'first tool started');
    f.send('Use this correction.'); f.send('Also keep this detail.');
    assert.equal(active!.signal.aborted, false);
    assert.equal(prompts.length, 1);
    assert.deepEqual(f.inspect.queued, ['Use this correction.', 'Also keep this detail.']);
    gate.resolve();
    await until(() => prompts.length >= 3 && !f.inspect.running, 'queued messages run at the tool boundary');
    assert.deepEqual(prompts, ['Execute the plan.', 'Use this correction.', 'Also keep this detail.']);
    assert.equal(laterRan, false, 'the rest of the old plan cannot outrun new input');
    const results = f.context.messages().flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    assert.equal(results.length, 2, 'history still pairs every tool call');
    assert.equal(results.find((b) => b.toolCallId === 'one')?.ok, true);
    assert.equal(results.find((b) => b.toolCallId === 'two')?.ok, false);
    assert.deepEqual(f.inspect.queued, []);
  } finally { gate.resolve(); await f.close(); }
});

test('fullscreen commands and scheduled wakeups stay deferred until a human message steers', async () => {
  const prompts: string[] = [];
  let signal: AbortSignal | undefined;
  const f = fixture({ name: 'mock', estimateTokens: () => 1,
    async *send(request): AsyncIterable<ProviderEvent> {
      prompts.push(latestPrompt(request.messages));
      if (prompts.length === 1) {
        signal = request.signal;
        await new Promise<void>((resolve) => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      }
      yield { type: 'text', delta: 'Received.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  });
  try {
    f.send('First.'); await until(() => !!signal, 'model started');
    f.send('/effort low'); f.wakeupHandler.fire('Check progress.', 'fixture');
    assert.equal(signal!.aborted, false, 'commands and timers cannot steer the model');
    f.send('New direction.');
    await until(() => prompts.length === 3 && !f.inspect.running, 'deferred work drains in submission order');
    assert.deepEqual(prompts, ['First.', '[wakeup: fixture] Check progress.', 'New direction.']);
    assert.equal(f.cfg.effort, 'low');
  } finally { await f.close(); }
});

test('fullscreen preserves the first prompt when follow-up arrives before run-lock admission', async () => {
  const release = runLock.tryAcquire('followup-test-browser');
  assert.ok(release);
  const prompts: string[] = [];
  const f = fixture({ name: 'mock', estimateTokens: () => 1,
    async *send(request): AsyncIterable<ProviderEvent> {
      prompts.push(latestPrompt(request.messages));
      yield { type: 'text', delta: 'Received.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  });
  try {
    f.send('First.'); f.send('Second.');
    assert.equal(f.inspect.controller!.signal.aborted, false);
    assert.deepEqual(prompts, []);
    release();
    await until(() => prompts.length === 2 && !f.inspect.running, 'both prompts are preserved after admission');
    assert.deepEqual(prompts, ['First.', 'Second.']);
  } finally { release(); await f.close(); }
});

test('fullscreen keeps queued messages in order across an asynchronous slash command', async () => {
  const gate = deferred();
  let compacting = false;
  let signal: AbortSignal | undefined;
  const prompts: string[] = [];
  const f = fixture({ name: 'mock', estimateTokens: () => 1,
    async *send(request): AsyncIterable<ProviderEvent> {
      prompts.push(latestPrompt(request.messages));
      if (prompts.length === 1) {
        signal = request.signal;
        await new Promise<void>((resolve) => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
      }
      yield { type: 'text', delta: 'Received.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  });
  f.context.maybeSummarize = async (_provider, _model, force) => {
    if (!force) return false;
    compacting = true;
    await gate.promise;
    return false;
  };
  try {
    f.send('First.'); await until(() => !!signal, 'model started');
    f.send('/compact'); f.send('Second.'); f.send('Third.');
    await until(() => compacting, 'queued compaction begins after steering');
    assert.deepEqual(prompts, ['First.']);
    assert.deepEqual(f.inspect.queued, ['Second.', 'Third.'], 'async command cannot move the first message to the back');
    gate.resolve();
    await until(() => prompts.length === 3 && !f.inspect.running, 'messages drain after the command settles');
    assert.deepEqual(prompts, ['First.', 'Second.', 'Third.']);
  } finally { gate.resolve(); await f.close(); }
});
