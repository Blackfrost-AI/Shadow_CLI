import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import React from 'react';
import { render } from 'ink-testing-library';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { TuiOpts } from '../src/tui.js';

const fixture = isolateHome('draft-copy');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, fixture.home);
const { TuiApp } = await import('../src/tui.js');
const { EventBus } = await import('../src/agent/events.js');

test('Ctrl+X C copies the full logical draft and expanded paste, without modifying input', async (t) => {
  // Fake helper discovery + mocked spawn: this test must NEVER touch the user's clipboard.
  for (const name of ['pbcopy', 'wl-copy', 'clip.EXE']) writeFileSync(join(fixture.home, name), '', { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = fixture.home;
  const copies: string[] = [];
  const mockSpawn = t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: (text: string) => void } };
    child.stdin = Object.assign(new EventEmitter(), { end: (text: string) => { copies.push(text); queueMicrotask(() => child.emit('close', 0)); } });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { process.env.PATH = previousPath; mockSpawn.mock.restore(); syncBuiltinESMExports(); });
  const opts = {
    provider: {}, registry: {}, bus: new EventBus(), context: { pinTask() {}, append() {} },
    sessionLog: { record() {} }, system: '', workspaceRoot: fixture.home,
    cfg: { provider: 'mock', model: 'demo', mouse: false }, autonomy: 'auto-edit', bypass: false, version: 'test',
  } as unknown as TuiOpts;
  const app = render(React.createElement(TuiApp, { opts }));
  t.after(() => app.unmount());
  await delay(120);
  const draft = '  Keep these spaces. ' + 'A long wrapped paragraph. '.repeat(12) + '\n\n    Indented second paragraph.  ';
  app.stdin.write('\x1b[200~' + draft + '\x1b[201~');
  await delay(90);
  app.stdin.write('\x18');
  app.stdin.write('c');
  await delay(90);
  assert.equal(copies.at(-1), draft);
  assert.match(app.lastFrame() ?? '', /Copied draft/);
  app.stdin.write('\x1b'); // clear this draft, then paste a condensed chip
  const big = Array.from({ length: 45 }, (_, i) => `  Line ${i}`).join('\n');
  app.stdin.write('\x1b[200~' + big + '\x1b[201~');
  await delay(90);
  app.stdin.write('\x18');
  app.stdin.write('c');
  await delay(90);
  assert.equal(copies.at(-1), big, 'copy expands the chip, including lines outside the viewport');
  assert.match(app.lastFrame() ?? '', /Pasted text #/, 'copying did not clear the draft');
});
