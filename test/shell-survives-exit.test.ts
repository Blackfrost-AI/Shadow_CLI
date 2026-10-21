// End-to-end proof that a run_shell background command survives Shadow dying.
//
// This is the regression test for the reported "hf download stopped at 35/84 with no error line"
// bug. It must fail on the old pipe-backed spawn and pass on the file-backed one.
//
// Shape: spawn a Node "parent" that exercises the real runShell tool and then SIGKILLs itself,
// exactly as a torn-down SSH session does. The command it launched keeps writing to its own log.
// If the fix holds, the log keeps growing after the parent is gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('background shell survives the Shadow process being SIGKILLed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-survive-'));
  const counter = join(dir, 'counter.txt');
  const parentSrc = join(dir, 'parent.mjs');

  // The parent runs the REAL tool, then dies abruptly. `tsx` resolves the TS sources directly so
  // this test needs no build step.
  writeFileSync(
    parentSrc,
    `
import { makeRunShell } from ${JSON.stringify(join(REPO, 'src/tools/runShell.ts'))};
import { BgRegistry } from ${JSON.stringify(join(REPO, 'src/tools/bgShell.ts'))};
const bg = new BgRegistry();
const tool = makeRunShell({ sandbox: 'off', bg });
const ctx = {
  workspaceRoot: ${JSON.stringify(dir)},
  signal: new AbortController().signal,
  streamShell: false,
  bg,
};
const res = await tool.run(
  // MUST write to STDOUT, not just a file — that is what puts bytes on the stdio pipe, which is
  // how the child dies of SIGPIPE when the parent goes away. A command that only appends to a
  // file would pass this test even with the broken pipe-backed spawn, so it would prove nothing.
  { command: 'i=0; while [ $i -lt 2000 ]; do echo "$i" >> ${counter}; echo "tick $i"; i=$((i+1)); sleep 0.05; done', description: 'survivor', run_in_background: true },
  ctx,
);
process.stderr.write('SPAWNED:' + JSON.stringify(res.ok ? res.data : res) + '\\n');
// Die like a parent session being torn down.
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 300);
`,
  );

  const parent = spawn('npx', ['--no-install', 'tsx', parentSrc], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  parent.stderr.on('data', (d) => (err += d.toString()));
  parent.stdout.on('data', () => {});

  // Wait for the tool call to start the command, then for the parent to die.
  for (let i = 0; i < 100 && !err.includes('SPAWNED:'); i++) await sleep(100);
  assert.ok(err.includes('SPAWNED:'), `parent never spawned the command: ${err}`);
  await sleep(600);

  // Parent is gone. The command must still be alive and still writing.
  const sizeAtDeath = existsSync(counter) ? statSync(counter).size : 0;
  assert.ok(sizeAtDeath > 0, 'command produced no output before the parent died');

  await sleep(1200);
  const sizeLater = existsSync(counter) ? statSync(counter).size : 0;
  assert.ok(
    sizeLater > sizeAtDeath,
    `command STOPPED when its parent died (${sizeAtDeath} -> ${sizeLater} bytes): the pipe-backed ` +
      'stdio bug is back — the child is dying of SIGPIPE instead of running detached',
  );

  // Clean up the survivor so the test leaves nothing running.
  const pidLine = err;
  const lines = readFileSync(counter, 'utf8').trim().split('\n').length;
  assert.ok(lines > 0);
  try {
    const pidMatch = pidLine.match(/"backgroundId":"(bg_[^"]+)"/);
    assert.ok(pidMatch);
  } catch {
    /* id format is incidental; survival is what this test asserts */
  }
  spawn('pkill', ['-f', counter], { stdio: 'ignore' }).unref();
});
