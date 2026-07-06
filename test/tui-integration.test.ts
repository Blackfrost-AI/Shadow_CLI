import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createProvider } from '../src/provider/index.js';
import { loadConfig } from '../src/config.js';
import { makeAskUserQuestionTool } from '../src/tools/askUser.js';

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
  assert.match(frame, /working… [1-9]\d*s/, 'spinner shows elapsed seconds, not a dead spinner');
  assert.match(frame, /Esc to interrupt/);
  unmount();
});

test('type-ahead: a message typed while running is queued, not interrupting, and flushed in order', async () => {
  const prompts: string[] = [];
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
      // The FIRST turn runs to completion on its own — type-ahead must NOT abort it.
      if (prompts.length === 1) {
        await new Promise((r) => setTimeout(r, 200));
        yield { type: 'text' as const, delta: 'first reply' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
        return;
      }
      yield { type: 'text' as const, delta: `queued reply: ${text}` };
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
  stdin.write('first');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r');
  await waitFor(() => /working/.test(seen()), 1500);

  // Type-ahead while the first turn is in flight: it should be QUEUED (visible), not run yet.
  stdin.write('second');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('\r');
  await waitFor(() => /queued \(1\)/.test(seen()), 1500);
  assert.match(seen(), /queued \(1\): second/, 'the queued message is shown to the user');
  assert.deepEqual(prompts, ['first'], 'the queued message has NOT started a turn yet');

  // The first turn completes on its own (proves no interrupt), THEN the queue flushes.
  await waitFor(() => /first reply/.test(seen()), 1500);
  await waitFor(() => /queued reply: second/.test(seen()), 1500);
  assert.deepEqual(prompts, ['first', 'second'], 'queued message ran after the turn, in order');
  assert.match(seen(), /❯ second/, 'the flushed message commits its user line like a typed one');
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
  await waitFor(() => /working/.test(seen()), 1500);

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
  assert.match(lastFrame() ?? '', /working…/, 'turn is running');
  stdin.write('\x1b'); // Esc → interrupt
  await new Promise((r) => setTimeout(r, 200));
  const frame = lastFrame() ?? '';
  assert.match(frame, /interrupted/, 'Esc reports the interrupt');
  assert.doesNotMatch(frame, /working…/, 'the running turn stopped');
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
