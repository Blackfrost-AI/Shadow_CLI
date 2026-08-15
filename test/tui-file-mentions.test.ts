/**
 * @-file references (F08-04) end-to-end through the real TuiApp: typing `@` opens a file picker,
 * accepting inserts the path, and on submit the referenced file is inlined for the MODEL while the
 * on-screen echo still shows the clean `@path` (not the file dump).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { loadConfig } from '../src/config.js';
import type { Provider, ProviderEvent, Message } from '../src/provider/provider.js';

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');
async function until(pred: () => boolean, ms = 2500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await tick(40); }
  return pred();
}

function makeWs(): string {
  const ws = mkdtempSync(join(tmpdir(), 'fm-tui-'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src/index.ts'), 'export const MAGIC = 42;');
  return ws;
}

function baseOpts(ws: string, provider: TuiOpts['provider']): TuiOpts {
  const cfg = loadConfig(ws, { provider: 'mock', model: 'm' });
  return {
    provider,
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
    sessionLog: { record() {}, recordSnapshot() {}, path: undefined } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    cfg,
    autonomy: 'manual',
    bypass: false,
    version: '0.0.0',
    workspaceRoot: ws,
  };
}

test('typing @ opens a file picker; Tab inserts the workspace-relative path', async () => {
  const ws = makeWs();
  const opts = baseOpts(ws, {} as TuiOpts['provider']);
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('@ind');
    assert.ok(await until(() => /@src\/index\.ts/.test(strip(lastFrame() ?? ''))), 'the file candidate shows in the picker');
    stdin.write('\t');
    await tick();
    assert.match(strip(lastFrame() ?? ''), /@src\/index\.ts/, 'Tab inserted the path into the composer');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('on submit the referenced file is inlined for the model, but the echo stays clean', async () => {
  const ws = makeWs();
  const seen: Message[][] = [];
  const provider: Provider = {
    name: 'capture',
    estimateTokens: () => 1,
    async *send(req): AsyncIterable<ProviderEvent> {
      seen.push(req.messages);
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const opts = baseOpts(ws, provider as unknown as TuiOpts['provider']);
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    // Natural flow: type the mention, Tab to accept (inserts the path + a trailing space, which
    // closes the picker), then Enter submits.
    stdin.write('explain @ind');
    await tick();
    stdin.write('\t');
    await tick();
    stdin.write('\r');
    assert.ok(await until(() => seen.length > 0), 'the turn ran');
    // The MODEL received the inlined file content.
    const flat = JSON.stringify(seen[seen.length - 1]);
    assert.match(flat, /export const MAGIC = 42/, 'file content inlined into the model message');
    assert.match(flat, /--- @src\/index\.ts ---/, 'fenced with the mention header');
    // The on-screen echo shows the clean @path, NOT the file dump.
    const frame = strip(lastFrame() ?? '');
    assert.match(frame, /explain @src\/index\.ts/, 'echo shows the typed line with the @path');
    assert.doesNotMatch(frame, /export const MAGIC = 42/, 'echo does not dump the file content');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});
