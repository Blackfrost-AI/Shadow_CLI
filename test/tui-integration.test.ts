import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { z } from 'zod';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createProvider } from '../src/provider/index.js';
import { loadConfig } from '../src/config.js';
import { makeAskUserQuestionTool } from '../src/tools/askUser.js';
import type { Tool } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';
import { runLock } from '../src/web/runLock.js';

// The type-ahead guard (DIALOG_ARM_MS, see tui-typeahead-guard.test.ts) ignores keys pressed in the
// first ~275 ms a dialog is up — they were in flight before it opened. A test driver answers in the
// same tick, which no human can do, so without this the dialog stays open and the awaiting turn
// never settles. Zeroed here so these tests exercise what they are about.
process.env.SHADOW_DIALOG_ARM_MS = '0';

/**
 * End-to-end through the real component: type a task, press Enter, and confirm the
 * key handler submits, runOne drives the AgentLoop, the mock provider streams a
 * reply, and it lands in the scrollback. This exercises the submit path that a
 * piped pty can't faithfully emulate (Enter as a real key.return).
 */
async function waitFor(pred: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('composer accepts the letter o (not stolen by reasoning toggle)', async () => {
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'claude-opus-4-8' });
  const opts: TuiOpts = {
    provider: createProvider({ provider: 'mock', model: cfg.model }),
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({
      contextBudget: cfg.contextBudget,
      triggerRatio: cfg.summarizeTriggerRatio,
      keepLastTurns: cfg.keepLastTurns,
    }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'auto-edit',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const seen = () => frames.join('\n');
  await waitFor(() => /❯/.test(seen()), 1500);
  await new Promise((r) => setTimeout(r, 80));

  stdin.write('hello');
  await waitFor(() => /❯ hello/.test(seen()), 1500);
  unmount();
});

test('typing a task + Enter runs the loop and commits the mock reply', async () => {
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'claude-opus-4-8' });
  const opts: TuiOpts = {
    provider: createProvider({ provider: 'mock', model: cfg.model }),
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({
      contextBudget: cfg.contextBudget,
      triggerRatio: cfg.summarizeTriggerRatio,
      keepLastTurns: cfg.keepLastTurns,
    }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'auto-edit',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const seen = () => frames.join('\n');
  await waitFor(() => /❯/.test(seen()), 1500); // composer mounted
  await new Promise((r) => setTimeout(r, 80)); // let Ink wire useInput before synthetic typing

  stdin.write('ping'); // type the task
  await waitFor(() => /❯ ping/.test(seen()), 1500);
  stdin.write('\r'); // Enter → submit

  await waitFor(() => /❯ ping/.test(seen()), 1500); // user line committed
  await waitFor(() => /Shadow \(mock\): I received "ping"/.test(seen()), 1500); // loop ran, reply committed

  const out = seen();
  assert.match(out, /❯ ping/, 'the submitted task is committed to scrollback');
  assert.match(out, /Shadow \(mock\): I received "ping"/, 'the mock loop reply is committed');
  // Turns now render as plain scrolling text (Claude-Code style): the old per-message
  // bordered card — with its "you"/"assistant" header label — is gone.
  assert.doesNotMatch(out, /\byou\b/, 'no "you" card-header label on the user turn');
  assert.doesNotMatch(out, /\bassistant\b/, 'no "assistant" card-header label on the reply');
  unmount();
});

test('the spinner shows a live elapsed counter while a slow model is responding', async () => {
  // A provider that stalls before responding — mimics a slow/stuck local model.
  const slow = {
    name: 'slow',
    estimateTokens: () => 0,
    async *send() {
      await new Promise((r) => setTimeout(r, 3000));
      yield { type: 'text' as const, delta: 'late' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'm' });
  const opts: TuiOpts = {
    provider: slow as unknown as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({
      contextBudget: cfg.contextBudget,
      triggerRatio: cfg.summarizeTriggerRatio,
      keepLastTurns: cfg.keepLastTurns,
    }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'auto-edit',
    bypass: false,
    version: '0.0.0',
  };
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  await new Promise((r) => setTimeout(r, 30));
  stdin.write('go');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r'); // submit → loop starts, provider stalls 3s
  await new Promise((r) => setTimeout(r, 1300)); // let the elapsed counter tick past 1s
  const frame = lastFrame() ?? '';
  assert.match(frame, /\([1-9]\d*s\)/, 'spinner shows elapsed seconds, not a dead spinner');
  assert.match(frame, /Esc interrupt/);
  unmount();
});

test('type-ahead: a pending message interrupts model streaming and steers the next turn', async () => {
  const prompts: string[] = [];
  let firstAborted = false;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const provider = {
    name: 'typeahead',
    estimateTokens: () => 0,
    async *send(req: {
      signal: AbortSignal;
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    }) {
      const last = [...req.messages]
        .reverse()
        .find((m) => m.role === 'user' && m.content.some((b) => b.type === 'text'));
      const text = last?.content.find((b) => b.type === 'text')?.text ?? '';
      prompts.push(text);
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        if (prompts.length === 1) {
          yield { type: 'text' as const, delta: 'partial first answer' };
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1200);
            const onAbort = () => {
              clearTimeout(timer);
              resolve();
            };
            if (req.signal.aborted) onAbort();
            else req.signal.addEventListener('abort', onAbort, { once: true });
          });
          if (req.signal.aborted) {
            firstAborted = true;
            return;
          }
          yield { type: 'text' as const, delta: ' stale first completion' };
          yield { type: 'done' as const, stopReason: 'end_turn' as const };
          return;
        }
        yield { type: 'text' as const, delta: `steered reply: ${text}` };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      } finally {
        activeRequests -= 1;
      }
    },
  };
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'm' });
  const context = new Context({
    contextBudget: cfg.contextBudget,
    triggerRatio: cfg.summarizeTriggerRatio,
    keepLastTurns: cfg.keepLastTurns,
  });
  const opts: TuiOpts = {
    provider: provider as unknown as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context,
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'auto-edit',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const seen = () => frames.join('\n');
  await new Promise((r) => setTimeout(r, 30));
  stdin.write('first');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r');
  await waitFor(() => /partial first answer/.test(seen()), 1500);

  // Enter during provider streaming requests a model-only interrupt, then starts a fresh turn
  // through the ordinary FIFO/run-lock path.
  stdin.write('second');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r');
  await waitFor(() => /steered reply: second/.test(seen()), 1500);
  assert.equal(firstAborted, true, 'the pending message cancels the active model request promptly');
  assert.equal(maxActiveRequests, 1, 'the replacement request starts only after the first unwinds');
  assert.deepEqual(prompts, ['first', 'second'], 'the steering message becomes the next provider turn');
  assert.doesNotMatch(seen(), /stale first completion/, 'the obsolete completion never reaches the transcript');
  assert.match(seen(), /↪ pending message — steering at the next safe boundary/);
  assert.match(seen(), /❯ second/, 'the steering message commits its user line like an idle send');

  const messages = context.messages();
  assert.equal(messages[0]?.role, 'user');
  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: [{ type: 'text', text: 'partial first answer' }],
    interrupted: true,
  });
  assert.equal(messages[2]?.role, 'user', 'the steering message follows the interrupted partial');
  assert.equal(messages[2]?.content[0]?.type, 'text');
  if (messages[2]?.content[0]?.type === 'text') assert.equal(messages[2].content[0].text, 'second');
  unmount();
});

test('type-ahead: multiple pending messages stay FIFO and do not auto-cancel the next turn', async () => {
  const prompts: string[] = [];
  const provider = {
    name: 'fifo-typeahead',
    estimateTokens: () => 0,
    async *send(req: {
      signal: AbortSignal;
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    }) {
      const last = [...req.messages].reverse().find((m) => m.role === 'user');
      const prompt = last?.content.find((b) => b.type === 'text')?.text ?? '';
      prompts.push(prompt);
      if (prompts.length === 1) {
        yield { type: 'text' as const, delta: 'first partial' };
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) resolve();
          else req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        // Leave enough unwind time for both pending messages to be submitted against turn A.
        await new Promise((resolve) => setTimeout(resolve, 80));
        return;
      }
      yield { type: 'text' as const, delta: `reply:${prompt}` };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'm' });
  const opts: TuiOpts = {
    provider: provider as unknown as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({
      contextBudget: cfg.contextBudget,
      triggerRatio: cfg.summarizeTriggerRatio,
      keepLastTurns: cfg.keepLastTurns,
    }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'full',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const seen = () => frames.join('\n');
  await new Promise((resolve) => setTimeout(resolve, 40));
  stdin.write('A');
  stdin.write('\r');
  await waitFor(() => /first partial/.test(seen()));
  stdin.write('B');
  stdin.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 20));
  stdin.write('C');
  stdin.write('\r');

  await waitFor(() => /reply:B/.test(seen()), 2000);
  await waitFor(() => /reply:C/.test(seen()), 2000);
  assert.deepEqual(prompts, ['A', 'B', 'C']);
  assert.match(seen(), /reply:B/, 'B gets its own answer even though C was already queued');
  unmount();
});

test('type-ahead while waiting for the process lock preserves the active prompt', async () => {
  const release = runLock.tryAcquire('tui-fifo-test');
  assert.ok(release, 'test acquired the process lock');
  const prompts: string[] = [];
  const provider = {
    name: 'lock-fifo',
    estimateTokens: () => 0,
    async *send(req: { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }) {
      const last = [...req.messages].reverse().find((m) => m.role === 'user');
      const prompt = last?.content.find((b) => b.type === 'text')?.text ?? '';
      prompts.push(prompt);
      yield { type: 'text' as const, delta: `reply:${prompt}` };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'm' });
  const opts: TuiOpts = {
    provider: provider as unknown as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'full',
    bypass: false,
    version: '0.0.0',
  };

  const rendered = render(React.createElement(TuiApp, { opts }));
  const seen = () => rendered.frames.join('\n');
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    rendered.stdin.write('A');
    rendered.stdin.write('\r');
    await waitFor(() => runLock.state().waiting.includes('cli'));
    rendered.stdin.write('B');
    rendered.stdin.write('\r');
    await waitFor(() => /queued in order/.test(seen()));
    release();
    await waitFor(() => /reply:A/.test(seen()), 2000);
    await waitFor(() => /reply:B/.test(seen()), 2000);
    assert.deepEqual(prompts, ['A', 'B'], 'A is not silently dropped while its lock acquisition waits');
  } finally {
    release();
    rendered.unmount();
  }
});

test('streaming textual tool envelopes never leak into Static, even across JSON delta boundaries', async () => {
  let first = true;
  const provider = {
    name: 'stream-scrub',
    estimateTokens: () => 0,
    async *send(req: { signal: AbortSignal }) {
      if (first) {
        first = false;
        yield { type: 'text' as const, delta: 'Useful line.\n' };
        yield { type: 'text' as const, delta: '{\n' };
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield {
          type: 'text' as const,
          delta: '  "tool_calls": [{"name":"read_file","args":{"path":"secret"}}]\n}\n',
        };
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) resolve();
          else req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      yield { type: 'text' as const, delta: 'replacement done' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'm' });
  const context = new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns });
  const opts: TuiOpts = {
    provider: provider as unknown as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context,
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'full',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const seen = () => frames.join('\n');
  await new Promise((resolve) => setTimeout(resolve, 40));
  stdin.write('first');
  stdin.write('\r');
  await waitFor(() => /Useful line/.test(seen()));
  await new Promise((resolve) => setTimeout(resolve, 80));
  stdin.write('next');
  stdin.write('\r');
  await waitFor(() => /replacement done/.test(seen()), 2000);

  assert.equal(frames.some((frame) => /"tool_calls"|"name":"read_file"/.test(frame)), false);
  assert.equal(frames.some((frame) => /(?:^|\n)\s*\{\s*(?:\n|$)/m.test(frame)), false, 'a lone opening brace was never committed');
  const interrupted = context.messages().find((m) => m.role === 'assistant' && m.interrupted);
  assert.deepEqual(interrupted?.content, [{ type: 'text', text: 'Useful line.' }]);
  unmount();
});

test('Enter on a typed follow-up denies an approval dialog and steers instead of approving', async () => {
  let toolRuns = 0;
  let sends = 0;
  const registry = new ToolRegistry();
  const dangerous: Tool<Record<string, never>, { ran: boolean }> = {
    name: 'dangerous_write',
    description: 'must be approved',
    risk: 'write',
    inputSchema: z.object({}),
    async run() {
      toolRuns += 1;
      return ok('dangerous_write', 'write', 1, 'ran', { ran: true });
    },
  };
  registry.register(dangerous);
  const provider = {
    name: 'approval-steer',
    estimateTokens: () => 0,
    async *send(req: { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }) {
      sends += 1;
      if (sends === 1) {
        await new Promise((resolve) => setTimeout(resolve, 140));
        yield { type: 'tool_call' as const, call: { id: 'guarded', name: 'dangerous_write', input: {} } };
        yield { type: 'done' as const, stopReason: 'tool_use' as const };
        return;
      }
      const last = [...req.messages].reverse().find((m) => m.role === 'user' && m.content.some((b) => b.type === 'text'));
      const prompt = last?.content.find((b) => b.type === 'text')?.text ?? '';
      yield { type: 'text' as const, delta: `follow-up:${prompt}` };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'm' });
  const context = new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns });
  const bus = new EventBus();
  const events: string[] = [];
  bus.on((event) => events.push(event.type));
  const opts: TuiOpts = {
    provider: provider as unknown as TuiOpts['provider'],
    registry,
    bus,
    context,
    sessionLog: { record() {}, recordSnapshot() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'manual',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const seen = () => frames.join('\n');
  await new Promise((resolve) => setTimeout(resolve, 40));
  stdin.write('initial');
  stdin.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 40));
  stdin.write('change course');
  await waitFor(() => /❯ change course/.test(seen()));
  await waitFor(() => /dangerous_write/.test(seen()), 2000);
  stdin.write('\r');
  await waitFor(() => /follow-up:change course/.test(seen()), 2000);

  assert.equal(toolRuns, 0, 'Enter never approved the pending write');
  assert.equal(events.includes('tool_start'), false);
  assert.equal(events.includes('tool_denied'), false, 'superseded is not mislabeled as an explicit denial');
  const result = context.messages().flatMap((m) => m.content).find(
    (b) => b.type === 'tool_result' && b.toolCallId === 'guarded',
  );
  assert.ok(result && result.type === 'tool_result');
  assert.match(result.content, /new message/i);
  unmount();
});

test('queued /compact is an asynchronous FIFO barrier before the next message', async () => {
  let manualCompactStarted!: () => void;
  const compactStarted = new Promise<void>((resolve) => (manualCompactStarted = resolve));
  let finishCompact!: () => void;
  const compactMayFinish = new Promise<void>((resolve) => (finishCompact = resolve));
  const prompts: string[] = [];
  const provider = {
    name: 'compact-barrier',
    estimateTokens: () => 0,
    async *send(req: {
      signal: AbortSignal;
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    }) {
      const last = [...req.messages].reverse().find((m) => m.role === 'user');
      const prompt = last?.content.find((b) => b.type === 'text')?.text ?? '';
      prompts.push(prompt);
      if (prompts.length === 1) {
        yield { type: 'text' as const, delta: 'working' };
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) resolve();
          else req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      yield { type: 'text' as const, delta: `reply:${prompt}` };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'm' });
  const context = new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns });
  context.maybeSummarize = async (_provider, _model, force) => {
    if (!force) return false;
    manualCompactStarted();
    await compactMayFinish;
    return false;
  };
  const opts: TuiOpts = {
    provider: provider as unknown as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context,
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'full',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const seen = () => frames.join('\n');
  await new Promise((resolve) => setTimeout(resolve, 40));
  stdin.write('A');
  stdin.write('\r');
  await waitFor(() => /working/.test(seen()));
  stdin.write('/compact');
  stdin.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 20));
  stdin.write('B');
  stdin.write('\r');
  await compactStarted;
  assert.deepEqual(prompts, ['A'], 'B cannot start against context while manual compaction is rewriting it');
  finishCompact();
  await waitFor(() => /reply:B/.test(seen()), 2000);
  assert.deepEqual(prompts, ['A', 'B']);
  unmount();
});

test('type-ahead: a slash command typed while running is queued and runs after the turn', async () => {
  const provider = {
    name: 'slashqueue',
    estimateTokens: () => 0,
    async *send() {
      await new Promise((r) => setTimeout(r, 180));
      yield { type: 'text' as const, delta: 'done thinking' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'm' });
  const opts: TuiOpts = {
    provider: provider as unknown as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({
      contextBudget: cfg.contextBudget,
      triggerRatio: cfg.summarizeTriggerRatio,
      keepLastTurns: cfg.keepLastTurns,
    }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'auto-edit',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const seen = () => frames.join('\n');
  await new Promise((r) => setTimeout(r, 30));
  stdin.write('go');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r');
  await waitFor(() => /Esc interrupt/.test(seen()), 1500);

  // A non-informational slash command typed mid-turn is queued, not run immediately.
  stdin.write('/goal ship it');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r');
  await waitFor(() => /queued \(1\)/.test(seen()), 1500);
  assert.doesNotMatch(seen(), /Goal set: ship it/, 'the slash command did not run mid-turn');

  // After the turn ends it flushes through the SAME dispatch path as a typed slash command.
  await waitFor(() => /Goal set: ship it/.test(seen()), 1500);
  unmount();
});

test('backslash + Enter inserts a newline instead of submitting', async () => {
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'claude-opus-4-8' });
  const opts: TuiOpts = {
    provider: createProvider({ provider: 'mock', model: cfg.model }),
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({
      contextBudget: cfg.contextBudget,
      triggerRatio: cfg.summarizeTriggerRatio,
      keepLastTurns: cfg.keepLastTurns,
    }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'auto-edit',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const seen = () => frames.join('\n');
  await waitFor(() => /❯/.test(seen()), 1500);
  await new Promise((r) => setTimeout(r, 80));

  stdin.write('one\\'); // type "one\"
  await waitFor(() => /one/.test(seen()), 1500);
  stdin.write('\r'); // Enter on a trailing backslash → newline, NOT submit
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!/Shadow \(mock\): I received/.test(seen()), 'backslash+Enter must not submit');

  stdin.write('two');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r'); // now submit the multiline input
  await waitFor(() => /Shadow \(mock\): I received/.test(seen()), 1500);
  unmount();
});

test('ask_user_question overlay collects multiple TUI answers', async () => {
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'm' });
  const registry = new ToolRegistry();
  registry.register(makeAskUserQuestionTool());
  const context = new Context({
    contextBudget: cfg.contextBudget,
    triggerRatio: cfg.summarizeTriggerRatio,
    keepLastTurns: cfg.keepLastTurns,
  });
  let calls = 0;
  const provider = {
    name: 'questions',
    estimateTokens: () => 0,
    async *send() {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call' as const,
          call: {
            id: 'q1',
            name: 'ask_user_question',
            input: {
              questions: [
                { question: 'First target?', options: [{ label: 'A' }, { label: 'B' }] },
                { question: 'Second target?', options: [{ label: 'C' }, { label: 'D' }] },
              ],
            },
          },
        };
        yield { type: 'done' as const, stopReason: 'tool_use' as const };
        return;
      }
      yield { type: 'text' as const, delta: 'answered' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const opts: TuiOpts = {
    provider: provider as unknown as TuiOpts['provider'],
    registry,
    bus: new EventBus(),
    context,
    sessionLog: { record() {}, recordSnapshot() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'full',
    bypass: false,
    version: '0.0.0',
  };

  const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  const seen = () => frames.join('\n');
  await waitFor(() => /❯/.test(seen()), 1500);
  await new Promise((r) => setTimeout(r, 80));
  stdin.write('choose');
  await waitFor(() => /❯ choose/.test(seen()), 1500);
  stdin.write('\r');
  await waitFor(() => /First target\?/.test(seen()), 1500);
  stdin.write('2');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r');
  await waitFor(() => /Second target\?/.test(seen()), 1500);
  stdin.write('2');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r');
  await waitFor(() => /answered/.test(seen()), 1500);

  const blocks = context.messages().flatMap((m) => m.content);
  const result = blocks.find((b) => b.type === 'tool_result' && b.toolCallId === 'q1');
  assert.ok(result && result.type === 'tool_result');
  assert.match(result.content, /"question":"First target\?","selected":\["B"\]/);
  assert.match(result.content, /"question":"Second target\?","selected":\["D"\]/);
  unmount();
});

test('TUI user_prompt_submit hook denial prevents a model turn', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-tui-hook-'));
  try {
    const deny = join(ws, 'deny.sh');
    writeFileSync(deny, '#!/bin/sh\necho blocked prompt >&2\nexit 1\n', 'utf8');
    chmodSync(deny, 0o755);
    const cfg = loadConfig(ws, {
      provider: 'mock',
      model: 'm',
      hooks: { user_prompt_submit: [deny] },
    });
    let calls = 0;
    const provider = {
      name: 'blocked',
      estimateTokens: () => 0,
      async *send() {
        calls += 1;
        yield { type: 'text' as const, delta: 'should not run' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      },
    };
    const opts: TuiOpts = {
      provider: provider as unknown as TuiOpts['provider'],
      registry: new ToolRegistry(),
      bus: new EventBus(),
      context: new Context({
        contextBudget: cfg.contextBudget,
        triggerRatio: cfg.summarizeTriggerRatio,
        keepLastTurns: cfg.keepLastTurns,
      }),
      sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
      system: 'test',
      workspaceRoot: ws,
      cfg,
      autonomy: 'full',
      bypass: false,
      version: '0.0.0',
    };

    const { stdin, frames, unmount } = render(React.createElement(TuiApp, { opts }));
    const seen = () => frames.join('\n');
    await waitFor(() => /❯/.test(seen()), 1500);
    await new Promise((r) => setTimeout(r, 80));
    stdin.write('blocked');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    await waitFor(() => /user_prompt_submit hook/.test(seen()), 1500);
    assert.equal(calls, 0, 'provider should not be called after prompt hook denial');
    assert.doesNotMatch(seen(), /should not run/);
    unmount();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── Interrupt (Esc) vs quit (Ctrl-C) — keep the session unless Ctrl-C is pressed twice ──
function abortableOpts(): TuiOpts {
  const provider = {
    name: 'hang',
    estimateTokens: () => 0,
    async *send(req: { signal: AbortSignal }) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        req.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    },
  };
  const cfg = loadConfig(process.cwd(), { provider: 'mock', model: 'm' });
  return {
    provider: provider as unknown as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    workspaceRoot: process.cwd(),
    cfg,
    autonomy: 'auto-edit',
    bypass: false,
    version: '0.0.0',
  };
}

test('Esc interrupts a running turn (and the session survives)', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: abortableOpts() }));
  await new Promise((r) => setTimeout(r, 30));
  stdin.write('do it');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r');
  await new Promise((r) => setTimeout(r, 200));
  assert.match(lastFrame() ?? '', /Esc interrupt/, 'turn is running');
  stdin.write('\x1b'); // Esc → interrupt
  await new Promise((r) => setTimeout(r, 200));
  const frame = lastFrame() ?? '';
  assert.match(frame, /interrupted/, 'Esc reports the interrupt');
  assert.doesNotMatch(frame, /Esc interrupt/, 'the running turn stopped');
  assert.match(frame, /❯/, 'composer still present — the session survived');
  unmount();
});

test('a single Ctrl-C does NOT quit; it warns first (no accidental session loss)', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: abortableOpts() }));
  await new Promise((r) => setTimeout(r, 30));
  stdin.write('\x03'); // Ctrl-C once, idle
  await new Promise((r) => setTimeout(r, 80));
  const frame = lastFrame() ?? '';
  assert.match(frame, /press Ctrl-C again to quit/, 'first Ctrl-C warns instead of quitting');
  assert.match(frame, /❯/, 'app still mounted after one Ctrl-C');
  unmount();
});
