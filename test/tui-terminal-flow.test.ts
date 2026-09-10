import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink';
import xterm from '@xterm/headless';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { loadConfig } from '../src/config.js';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import { withSynchronizedOutput } from '../src/tui/syncOutput.js';

const pause = (ms = 90) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Use Ink's production renderer and an actual VT buffer. ink-testing-library's debug frames
// concatenate history and cannot reveal stale cursor erasures, native rewrap, or ghost rules.
test('terminal flow: quiet replies, resize during work, retained history, and an editable draft', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-vt-flow-'));
  const terminal = new xterm.Terminal({
    cols: 141,
    rows: 62,
    scrollback: 10000,
    allowProposedApi: true,
    convertEol: true,
  });
  const writes: string[] = [];
  const out = new Writable({
    write(chunk: Buffer, _encoding, done) {
      writes.push(chunk.toString());
      terminal.write(chunk, done);
    },
  });
  const geometry = { columns: 141, rows: 62 };
  Object.defineProperties(out, {
    columns: { get: () => geometry.columns },
    rows: { get: () => geometry.rows },
    isTTY: { value: true },
  });
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const bus = new EventBus();
  let turn = 0;
  let release: (() => void) | undefined;
  let releaseStream: (() => void) | undefined;
  const provider: Provider = {
    name: 'mock',
    estimateTokens: () => 1,
    async *send(): AsyncIterable<ProviderEvent> {
      const n = ++turn;
      yield { type: 'thinking', delta: `fixture reasoning ${n}` };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield { type: 'text', delta: `Answer ${n}.\n\n- A readable list\n- A second item\n\n` };
      yield { type: 'text', delta: '```ts\nconst clean = ' };
      if (n === 2)
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
      yield { type: 'text', delta: 'true;\n```' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const cfg = loadConfig(dir, {
    provider: 'mock',
    model: 'fixture-model',
    lastTheme: 'og',
    showLogo: false,
    reducedMotion: true,
    resumeRecap: false,
    notify: 'off',
    instructionAutopilot: false,
  });
  const opts: TuiOpts = {
    bus,
    provider,
    cfg,
    registry: new ToolRegistry(),
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    sessionLog: { record() {}, recordSnapshot() {} } as unknown as TuiOpts['sessionLog'],
    system: 'Local display fixture.',
    workspaceRoot: dir,
    autonomy: 'manual',
    bypass: false,
    offline: true,
    version: 'test',
  };
  const app = render(React.createElement(TuiApp, { opts }), {
    stdout: withSynchronizedOutput(out as NodeJS.WriteStream),
    stdin: input as unknown as NodeJS.ReadStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const flush = async () => {
    await pause();
    await new Promise<void>((resolve, reject) =>
      out.write('', (error) => (error ? reject(error) : resolve())),
    );
  };
  const screen = () => {
    const b = terminal.buffer.active;
    return Array.from({ length: b.length }, (_, y) => b.getLine(y)!.translateToString(true)).join(
      '\n',
    );
  };
  const resize = async (columns: number, rows: number) => {
    const start = writes.length;
    terminal.resize(columns, rows); // native reflow happens before the application's callback
    Object.assign(geometry, { columns, rows });
    out.emit('resize');
    await pause(200); // settled geometry replay, including Ink's trailing render
    await flush();
    const frames = [
      ...writes
        .slice(start)
        .join('')
        .matchAll(/\x1b\[\?2026h(.*?)\x1b\[\?2026l/gs),
    ];
    const replays = frames.filter((frame) => frame[1]!.includes('\x1b[3J'));
    assert.ok(replays.length > 0, 'settled resize rebuilds the saved conversation');
    for (const frame of replays) {
      assert.match(
        frame[1]!,
        /Answer 1\./,
        'clear and retained history share one synchronized frame',
      );
    }
  };
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await flush();
    assert.ok(predicate(), screen());
  };
  try {
    await flush();
    for (let n = 1; n <= 3; n++) {
      release = undefined;
      input.write(`hello ${n}`);
      await flush();
      input.write('\r');
      await until(() => !!release && screen().includes('Thinking…'));
      assert.equal((screen().match(/Thinking…/g) ?? []).length, 1);
      assert.doesNotMatch(writes.join(''), /Working… \(\d+h/, 'the first running frame has a fresh turn clock');
      if (n === 1) await pause(1100); // the former completion timer only appeared after one second
      if (n === 2) {
        await resize(80, 24);
        await resize(141, 62);
        assert.match(
          screen(),
          /Answer 1\./,
          'resize during reasoning retains the preceding answer',
        );
      }
      release!();
      if (n === 2) {
        await until(() => !!releaseStream);
        await resize(80, 24);
        await resize(141, 62);
        assert.match(screen(), /const clean =/);
        releaseStream!();
      }
      await until(() => screen().includes(`Answer ${n}.`) && !screen().includes('Thinking…'));
      await flush();
    }
    for (const [cols, rows] of [
      [80, 24],
      [141, 62],
      [100, 28],
      [141, 62],
      [141, 16],
      [141, 62],
      [40, 12],
      [141, 62],
    ]) {
      await resize(cols!, rows!);
      const text = screen();
      for (let n = 1; n <= 3; n++) {
        assert.equal(
          (text.match(new RegExp(`hello ${n}`, 'g')) ?? []).length,
          1,
          'user turns survive once',
        );
        assert.equal(
          (text.match(new RegExp(`Answer ${n}\\.`, 'g')) ?? []).length,
          1,
          'answers survive once',
        );
      }
      assert.equal(
        text.split('\n').filter((line) => /^\s*─+\s*$/.test(line)).length,
        2,
        'only the two current composer rules survive resize',
      );
      assert.doesNotMatch(text, /\[DONE\] Thinking|◆ SHADOW|> YOU|done ·|fixture reasoning/);
    }
    input.write('draft with 界 and 👩‍💻');
    await flush();
    input.write('\x0f');
    await flush();
    assert.match(screen(), /Activity/);
    assert.match(screen(), /Thinking/, 'reasoning remains available on demand');
    await resize(80, 24);
    input.write('\x1b');
    await flush();
    await resize(141, 62);
    assert.match(
      screen(),
      /draft with 界 and 👩‍💻/,
      'activity inspection and resize preserve the draft',
    );
    assert.doesNotMatch(
      screen(),
      /Snapshot.*work continues/,
      'the activity overlay leaves no history copy',
    );
  } finally {
    release?.();
    releaseStream?.();
    app.unmount();
    app.cleanup();
    terminal.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
