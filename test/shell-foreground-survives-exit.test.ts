// End-to-end proof that a FOREGROUND run_shell command survives Shadow dying.
//
// Companion to shell-survives-exit.test.ts, which covers the background path. This one covers the
// case the user actually hit: a plain `run_shell` (no run_in_background) running a long download
// when the session was torn down mid-progress ("stopped at 35/84 with no error line").
//
// Two separate guarantees, each with its own discriminator:
//
//   1. SURVIVAL — the child is spawned `detached: true`, so it leads its own process group and is
//      not reachable by a SIGHUP sent to Shadow's group. That is exactly what an SSH teardown or a
//      parent-session kill does: the terminal's hangup is delivered to the whole foreground process
//      group. With `detached: false` the command dies with the session.
//
//   2. DURABILITY — stdio is backed by real log FILES on disk, not pipes owned by the dead parent.
//      A file descriptor outlives the reader; a pipe does not. This is also what keeps partial
//      output readable afterwards, which is how you diagnose a run that died at 35/84.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, statSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('FOREGROUND shell survives a hangup sent to Shadow own process group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-fg-survive-'));
  const counter = join(dir, 'counter.txt');
  const parentSrc = join(dir, 'parent.mjs');

  writeFileSync(
    parentSrc,
    `
import { makeRunShell } from ${JSON.stringify(join(REPO, 'src/tools/runShell.ts'))};
import { BgRegistry } from ${JSON.stringify(join(REPO, 'src/tools/bgShell.ts'))};
const bg = new BgRegistry();
const tool = makeRunShell({ sandbox: 'off', bg });
const ctx = { workspaceRoot: ${JSON.stringify(dir)}, signal: new AbortController().signal, streamShell: false, bg };
await tool.run(
  { command: 'i=0; while [ $i -lt 4000 ]; do echo "$i" >> ${counter}; echo "tick $i"; i=$((i+1)); sleep 0.05; done', description: 'fg survivor', timeout: 600000 },
  ctx,
);
`,
  );

  // The parent leads its own process group so we can signal "the session" precisely without
  // touching this test runner.
  const parent = spawn('node', ['--import', 'tsx/esm', parentSrc], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let err = '';
  parent.stdout.on('data', () => {});
  parent.stderr.on('data', (d) => (err += d.toString()));

  for (let i = 0; i < 150; i++) {
    if (existsSync(counter) && statSync(counter).size > 0) break;
    await sleep(100);
  }
  assert.ok(existsSync(counter), `foreground command never started: ${err}`);

  // "The session went away": hang up the parent's whole process group, the way a torn-down
  // terminal does. A non-detached child shares that group and dies here.
  process.kill(-parent.pid!, 'SIGHUP');
  await sleep(500);

  const sizeAtHangup = statSync(counter).size;
  assert.ok(sizeAtHangup > 0, 'command produced no output before the hangup');

  await sleep(1500);
  const sizeLater = statSync(counter).size;
  assert.ok(
    sizeLater > sizeAtHangup,
    `foreground command STOPPED when the session hung up (${sizeAtHangup} -> ${sizeLater} bytes): ` +
      'the child is in Shadow process group instead of its own, so the session teardown killed it',
  );

  spawn('pkill', ['-f', counter], { stdio: 'ignore' }).unref();
});

test('foreground output is written to a durable log file, not a pipe owned by the parent', async () => {
  // The durability half. With pipe-backed stdio the bytes live only in the dead parent's memory and
  // nothing at all is written under .shadow/shell-logs — this test fails outright in that shape.
  const dir = mkdtempSync(join(tmpdir(), 'shadow-fg-log-'));
  const parentSrc = join(dir, 'parent.mjs');

  writeFileSync(
    parentSrc,
    `
import { makeRunShell } from ${JSON.stringify(join(REPO, 'src/tools/runShell.ts'))};
import { BgRegistry } from ${JSON.stringify(join(REPO, 'src/tools/bgShell.ts'))};
const bg = new BgRegistry();
const tool = makeRunShell({ sandbox: 'off', bg });
const ctx = { workspaceRoot: ${JSON.stringify(dir)}, signal: new AbortController().signal, streamShell: false, bg };
await tool.run({ command: 'echo MARKER-ONE; echo MARKER-TWO >&2; sleep 30', description: 'log keeper' }, ctx);
`,
  );

  const parent = spawn('node', ['--import', 'tsx/esm', parentSrc], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  parent.stdout.on('data', () => {});
  parent.stderr.on('data', () => {});

  const logDir = join(dir, '.shadow', 'shell-logs');
  for (let i = 0; i < 150; i++) {
    if (existsSync(logDir)) break;
    await sleep(100);
  }
  await sleep(1200);
  process.kill(parent.pid!, 'SIGKILL');
  await sleep(400);

  assert.ok(existsSync(logDir), 'no shell-log directory was created — stdio is not file-backed');
  const files = readdirSync(logDir);
  const outBody = files
    .filter((f) => f.includes('out'))
    .map((f) => readFileSync(join(logDir, f), 'utf8'))
    .join('');
  const errBody = files
    .filter((f) => f.includes('err'))
    .map((f) => readFileSync(join(logDir, f), 'utf8'))
    .join('');
  assert.match(outBody, /MARKER-ONE/, 'stdout was not durably recorded on disk');
  assert.match(errBody, /MARKER-TWO/, 'stderr was not durably recorded on disk');

  spawn('pkill', ['-f', 'sleep 30'], { stdio: 'ignore' }).unref();
});
