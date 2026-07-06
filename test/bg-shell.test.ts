import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { makeRunShell } from '../src/tools/runShell.js';
import { BgRegistry, makeBashOutput, makeKillShell } from '../src/tools/bgShell.js';
import type { ToolContext } from '../src/tools/types.js';

const ctx: ToolContext = { workspaceRoot: tmpdir(), signal: new AbortController().signal, log: () => {}, dryRun: false };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('run_in_background returns an id and bash_output drains the output', async (t) => {
  if (process.platform === 'win32') return t.skip('posix shell only');
  const bg = new BgRegistry();
  const shell = makeRunShell({ sandbox: 'off', bg });
  const bashOutput = makeBashOutput(bg);

  const started = await shell.run({ command: 'echo hello; echo world', run_in_background: true }, ctx);
  assert.ok(started.ok, started.summary);
  const id = started.data?.backgroundId;
  assert.ok(id, 'a background id is returned');

  let all = '';
  let last;
  for (let i = 0; i < 100; i++) {
    last = await bashOutput.run({ id: id! }, ctx);
    all += last.data?.stdout ?? '';
    if (last.data && !last.data.running) break;
    await delay(20);
  }
  all += (await bashOutput.run({ id: id! }, ctx)).data?.stdout ?? ''; // final drain
  assert.equal(last?.data?.running, false, 'the shell finished');
  assert.match(all, /hello/);
  assert.match(all, /world/);
});

test('kill_shell terminates a long-running background shell', async (t) => {
  if (process.platform === 'win32') return t.skip('posix shell only');
  const bg = new BgRegistry();
  const shell = makeRunShell({ sandbox: 'off', bg });
  const kill = makeKillShell(bg);
  const bashOutput = makeBashOutput(bg);

  const started = await shell.run({ command: 'sleep 5', run_in_background: true }, ctx);
  const id = started.data?.backgroundId;
  assert.ok(id);

  const killed = await kill.run({ id: id! }, ctx);
  assert.ok(killed.ok);
  assert.equal(killed.data?.killed, true);

  let running = true;
  for (let i = 0; i < 100; i++) {
    const r = await bashOutput.run({ id: id! }, ctx);
    running = r.data?.running ?? false;
    if (!running) break;
    await delay(20);
  }
  assert.equal(running, false, 'the killed shell is no longer running');
});

test('bash_output / kill_shell report an unknown id', async () => {
  const bg = new BgRegistry();
  assert.equal((await makeBashOutput(bg).run({ id: 'bash_999' }, ctx)).ok, false);
  assert.equal((await makeKillShell(bg).run({ id: 'bash_999' }, ctx)).ok, false);
});
