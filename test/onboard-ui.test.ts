import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { visibleWidth } from '@earendil-works/pi-tui';
import { runClaudeCode } from '../src/auth/claudeCode.js';
import { isolateHome } from './helpers/isolateHome.js';
isolateHome('onboard-ui');
const { HeadlessTerminal } = await import('./helpers/snowfallTerminal.js');
const { TerminalOnboardUI, OnboardScreen, OnboardCancelled, BACK } =
  await import('../src/onboard/ui.js');

test('onboarding uses arrows, multi-digit numbers, search, and model multi-selection', () => {
  const view = new OnboardScreen(
    () => {},
    () => 36,
  );
  view.choices = Array.from({ length: 25 }, (_, i) => ({
    id: `m${i + 1}`,
    label: `Model ${i + 1}`,
  }));
  let answer: unknown;
  view.accept = (value) => {
    answer = value;
  };
  view.options = { search: true, multiple: true };
  view.handleInput('\x1b[B');
  view.handleInput(' ');
  view.handleInput('1');
  view.handleInput('2');
  assert.equal(answer, undefined, 'digits do not submit');
  view.handleInput(' ');
  view.handleInput('\r');
  assert.deepEqual(answer, ['m2', 'm12']);
  view.configure({ stage: 2, title: 'Models' });
  view.choices.push({ id: '@manual', label: 'Enter a model ID…' });
  view.handleInput('/');
  view.handleInput('Model 25');
  assert.match(stripVTControlCharacters(view.render(80).join('\n')), /Model 25/);
  view.handleInput('\x1b'); // First Escape clears search.
  assert.notEqual(answer, BACK);
  view.handleInput('\x1b');
  assert.equal(answer, BACK);
  view.handleInput('/');
  view.handleInput('unlisted-id');
  view.handleInput('\r');
  assert.deepEqual(answer, ['@manual', 'unlisted-id']);
});

test('one terminal owner survives masked entry, the next field, resize, and cancellation', async () => {
  const terminal = new HeadlessTerminal(120, 36);
  const ui = new TerminalOnboardUI(terminal);
  try {
    const secret = ui.text({ stage: 1, title: 'API key' }, { secret: true });
    terminal.input('\x1b[200~test-private-key-value\x1b[201~');
    terminal.input('\x1b[D');
    terminal.input('\x7f');
    terminal.input('u');
    await terminal.flush();
    assert.doesNotMatch(terminal.writes.join(''), /test-private|key-value/);
    assert.match(terminal.lines().join('\n'), /••••/);
    terminal.input('\r');
    assert.equal(typeof (await secret), 'string');
    const endpoint = ui.text(
      { stage: 1, title: 'Endpoint URL' },
      { initial: 'https://example.test/v1' },
    );
    for (const [width, rows] of [
      [80, 24],
      [28, 8],
      [200, 40],
      [120, 36],
    ]) {
      terminal.resize(width!, rows!);
      await terminal.flush();
      assert.equal(terminal.stopped, false);
      for (const line of ui.view.render(width!)) assert.ok(visibleWidth(line) <= width!);
      assert.ok(ui.view.render(width!).length <= rows!);
    }
    terminal.input('\r');
    assert.equal(await endpoint, 'https://example.test/v1');
    const pending = ui.text({ stage: 2, title: 'Model ID' });
    const rejected = assert.rejects(pending, OnboardCancelled);
    terminal.input('\x03');
    await rejected;
  } finally {
    ui.close();
    terminal.screen.dispose();
  }
  assert.equal(terminal.stopped, true);
  assert.match(terminal.writes.join(''), /\x1b\[23;2t/);
});

test('Escape cancels an active check and aborts its request without closing setup', async () => {
  const terminal = new HeadlessTerminal();
  const ui = new TerminalOnboardUI(terminal);
  let aborted = false;
  try {
    const checking = ui.busy(
      { stage: 2, title: 'Discover models' },
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    terminal.input('\x1b');
    assert.equal(await checking, BACK);
    assert.equal(aborted, true);
    const next = ui.choose({ stage: 1, title: 'Retry' }, [{ id: 'yes', label: 'Retry' }]);
    terminal.input('\r');
    assert.deepEqual(await next, ['yes']);
  } finally {
    ui.close();
    terminal.screen.dispose();
  }
});

test('external login restores the wizard after completion and passes a cancellation signal', async () => {
  const terminal = new HeadlessTerminal();
  const ui = new TerminalOnboardUI(terminal);
  try {
    assert.equal(await ui.external(async (signal) => {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      assert.equal(terminal.stopped, true);
      return 'signed in';
    }), 'signed in');
    assert.equal(terminal.stopped, false);
    const next = ui.choose({ stage: 2, title: 'Continue' }, [{ id: 'yes', label: 'Continue' }]);
    terminal.input('\r');
    assert.deepEqual(await next, ['yes']);
  } finally {
    ui.close();
    terminal.screen.dispose();
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(`external login awaits child cleanup on ${signal} and releases its signal handlers`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shadow-external-login-'));
    const ready = join(directory, 'ready');
    const cleaned = join(directory, 'cleaned');
    const terminal = new HeadlessTerminal();
    const before = process.listeners(signal);
    const ui = new TerminalOnboardUI(terminal);
    const normalHandlers = process.listeners(signal);
    let settled = false;
    try {
      // A real inherited-stdio process models official login; it needs time to
      // clean up after termination. No credentials, browser or network is used.
      const script = `const fs=require('node:fs');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(process.argv[2],'done');process.exit(0)},30));fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
      const pending = ui.external((abortSignal) => runClaudeCode(process.execPath,
        ['-e', script, ready, cleaned], { signal: abortSignal, timeoutMs: 5000, inheritStdio: true }))
        .finally(() => { settled = true; });
      const rejected = assert.rejects(pending, OnboardCancelled);
      for (let attempt = 0; !existsSync(ready) && attempt < 200; attempt++) await delay(10);
      assert.ok(existsSync(ready), 'fixture login started');
      assert.equal(terminal.stopped, true);
      process.emit(signal);
      assert.equal(settled, false, 'cancellation must await the child');
      await rejected;
      if (process.platform !== 'win32') assert.equal(readFileSync(cleaned, 'utf8'), 'done');
      const pid = Number(readFileSync(ready, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.deepEqual(process.listeners(signal), normalHandlers, 'wizard handlers restored');
    } finally {
      ui.close();
      terminal.screen.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
    assert.deepEqual(process.listeners(signal), before, 'no external-login signal handler leaked');
  });
}
