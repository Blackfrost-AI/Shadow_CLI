import './helpers/interactiveEnv.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { TuiOpts } from '../src/tui.js';

const isolated = isolateHome('ink-session-names');
const previousSessionDir = process.env.SHADOW_SESSION_DIR;
delete process.env.SHADOW_SESSION_DIR;
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, isolated.home);
const { TuiApp } = await import('../src/tui.js');
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

const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await pause(30);
  assert.ok(predicate(), 'Ink session state reached the expected value');
}

test('Ink renames its title, preserves names on /new and resumes from a name-filtered menu', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-names-ink-'));
  const context = new Context({ contextBudget: 10000, triggerRatio: 0.8, keepLastTurns: 4 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'Fix the website header' }] });
  const first = SessionLog.open(root);
  first.recordSnapshot(context, 0);
  const box = { current: first };
  const opts: TuiOpts = {
    provider: { name: 'mock', estimateTokens: () => 1, async *send() { yield { type: 'done', stopReason: 'end_turn' }; } },
    cfg: loadConfig(root, { provider: 'mock', model: 'fixture', mouse: false, notify: 'off', resumeRecap: false }),
    registry: new ToolRegistry(), bus: new EventBus(), context, sessionLog: first, sessionLogBox: box,
    system: 'Session names fixture.', workspaceRoot: root, autonomy: 'manual', bypass: false, offline: true, version: '10.0.0-test',
  };
  const view = render(<TuiApp opts={opts} />);
  Object.defineProperty(view.stdout, 'isTTY', { value: true });
  const submit = async (text: string) => { view.stdin.write(text); await pause(); view.stdin.write('\r'); await pause(); };
  try {
    await pause();
    await submit('/rename Frontend README.md');
    await until(() => box.current.title === 'Frontend README.md');
    assert.ok(view.frames.some((frame) => frame.includes('\x1b]2;Frontend README.md — Shadow\x07')));
    await submit('/new');
    await until(() => box.current.path !== first.path);
    assert.equal(SessionLog.titleFor(first.path), 'Frontend README.md');
    assert.ok(view.frames.some((frame) => frame.includes('\x1b]2;New session — Shadow\x07')));
    view.stdin.write('/resume readme.md');
    await pause();
    assert.match(view.lastFrame() ?? '', /Frontend README.md/, 'names containing filenames remain searchable');
    view.stdin.write('\r');
    await until(() => box.current.title === 'Frontend README.md');
    assert.notEqual(box.current.path, first.path, 'resuming keeps the original named log intact');
    assert.equal(context.messages().length, 1);
  } finally {
    view.unmount(); box.current.close(); first.close(); rmSync(root, { recursive: true, force: true });
  }
});
