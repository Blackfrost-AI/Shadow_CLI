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

test('a foreground command past its timeout is PROMOTED to a background shell, not killed', async (t) => {
  if (process.platform === 'win32') return t.skip('posix shell only');
  // The defect this pins: a download that outlives the 60s foreground timeout used to be
  // killTree'd, so the work died mid-transfer with no error line in the log. It must now keep
  // running and be pollable. `timeout_ms` is the minimum the schema accepts, so use a short-lived
  // command that outlives it.
  const bg = new BgRegistry();
  const shell = makeRunShell({ sandbox: 'off', bg });

  const started = await shell.run(
    { command: 'echo begun; sleep 4; echo finished', timeout_ms: 1000 },
    ctx,
  );
  assert.ok(started.ok, `promotion is reported as a live result, not a failure: ${started.summary}`);
  const id = started.data?.promotedId;
  assert.ok(id, 'the promoted id is returned to the model');
  assert.equal(started.data?.timedOut, false, 'must not be reported as a timeout — the work is alive');
  assert.equal(started.data?.aborted, false);
  assert.match(started.summary, /NOT killed/);
  assert.match(started.summary, new RegExp(`bash_output\\("${id}"\\)`));

  // The output captured BEFORE the hand-off is preserved in the registry.
  const bashOutput = makeBashOutput(bg);
  const first = await bashOutput.run({ id: id! }, ctx);
  assert.match(first.data?.stdout ?? '', /begun/, 'pre-promotion output survives the hand-off');
  assert.equal(first.data?.running, true, 'the child is still running after promotion');

  // And it keeps running to completion rather than dying with the tool call.
  let all = '';
  let last;
  for (let i = 0; i < 200; i++) {
    last = await bashOutput.run({ id: id! }, ctx);
    all += last.data?.stdout ?? '';
    if (last.data && !last.data.running) break;
    await delay(50);
  }
  all += (await bashOutput.run({ id: id! }, ctx)).data?.stdout ?? '';
  assert.equal(last?.data?.running, false, 'the promoted child ran to completion');
  assert.equal(last?.data?.exitCode, 0, 'and exited cleanly — it was never signalled');
  assert.match(all, /finished/, 'the work after the timeout still happened');
});

test('a foreground command that is interrupted mid-flight is promoted too', async (t) => {
  if (process.platform === 'win32') return t.skip('posix shell only');
  const bg = new BgRegistry();
  const shell = makeRunShell({ sandbox: 'off', bg });
  const ac = new AbortController();
  const abortedCtx: ToolContext = { ...ctx, signal: ac.signal };

  const running = shell.run({ command: 'sleep 3; echo done', timeout_ms: 60000 }, abortedCtx);
  await delay(150);
  ac.abort('user_steer');
  const started = await running;

  assert.ok(started.ok, started.summary);
  const id = started.data?.promotedId;
  assert.ok(id, 'the work survives the interrupt with an id to poll');
  assert.equal(started.data?.aborted, false, 'not reported as aborted work — it is still running');
  assert.match(started.summary, /interrupted/);

  bg.kill(id!, 'SIGKILL');
});

test('releaseForExit leaves detached shells RUNNING (shutdown must not kill user work)', async (t) => {
  if (process.platform === 'win32') return t.skip('posix shell only');
  // The defect: shutdownCore() called bg.killAll(), so every background shell — already spawned
  // `detached: true` — was SIGKILLed on agent exit. A multi-hour download therefore died with no
  // traceback the moment Shadow closed, and nohup/setsid could not help because WE were the killer.
  const bg = new BgRegistry();
  const shell = makeRunShell({ sandbox: 'off', bg });
  const started = await shell.run({ command: 'sleep 3; echo survived', run_in_background: true }, ctx);
  const id = started.data?.backgroundId;
  assert.ok(id, 'background shell started');

  bg.releaseForExit(); // what shutdown now does instead of killAll()

  const bashOutput = makeBashOutput(bg);
  const after = await bashOutput.run({ id: id! }, ctx);
  assert.equal(after.data?.running, true, 'a released shell is still alive after shutdown');

  // And it is genuinely still working, not merely unreaped.
  let sawSurvived = false;
  for (let i = 0; i < 100; i++) {
    const r = await bashOutput.run({ id: id! }, ctx);
    if ((r.data?.stdout ?? '').includes('survived')) { sawSurvived = true; break; }
    await delay(100);
  }
  assert.ok(sawSurvived, 'the released shell ran to completion — its work outlived the app');
  bg.killAll();
});
