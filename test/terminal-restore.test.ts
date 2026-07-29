/**
 * Terminal-state restore — the regression net for the 3.6.0 mouse-reporting incident and its
 * siblings found in the pre-4.0 review.
 *
 * Modes like DECSET 2004/1000, the xterm title stack and the OSC 11 background belong to the USER'S
 * TERMINAL and outlive this process. They were reset from React destructors and from a
 * `waitUntilExit().finally()` continuation, neither of which runs when the process dies on a
 * signal — so a `kill`, a closed SSH session or a crash left bracketed paste on, the title stuck on
 * "Shadow", and the background forced black.
 *
 * Two properties are asserted throughout, because fixing only the first is what caused the SECOND
 * bug (hand-rolled `process.once(sig, off)` handlers made a mouse-enabled session survive SIGINT
 * and SIGHUP outright):
 *   1. every mode enabled has a matching disable in the captured output
 *   2. the process still DIES when signalled
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claimMode,
  releaseMode,
  updateReset,
  restoreTerminal,
  isClaimed,
  setTerminalOutput,
} from '../src/tui/terminalState.js';

function captureStream(): { stream: NodeJS.WriteStream; written: string[] } {
  const written: string[] = [];
  const stream = { write: (s: string) => (written.push(s), true) } as unknown as NodeJS.WriteStream;
  return { stream, written };
}

test('claimMode writes the enable once and restore writes the disable', () => {
  const { stream, written } = captureStream();
  setTerminalOutput(stream);
  claimMode('paste', '\x1b[?2004h', '\x1b[?2004l');
  assert.deepEqual(written, ['\x1b[?2004h']);
  restoreTerminal();
  assert.deepEqual(written, ['\x1b[?2004h', '\x1b[?2004l']);
});

test('re-claiming a mode does not re-emit the enable (idempotent arm)', () => {
  const { stream, written } = captureStream();
  setTerminalOutput(stream);
  claimMode('paste', '\x1b[?2004h', '\x1b[?2004l');
  claimMode('paste', '\x1b[?2004h', '\x1b[?2004l');
  assert.equal(written.filter((w) => w === '\x1b[?2004h').length, 1);
});

test('restore is idempotent — a signal handler and the exit handler may both run it', () => {
  const { stream, written } = captureStream();
  setTerminalOutput(stream);
  claimMode('paste', '\x1b[?2004h', '\x1b[?2004l');
  restoreTerminal();
  restoreTerminal();
  assert.equal(written.filter((w) => w === '\x1b[?2004l').length, 1);
});

test('modes restore in reverse claim order', () => {
  const { stream, written } = captureStream();
  setTerminalOutput(stream);
  claimMode('a', 'A-on', 'A-off');
  claimMode('b', 'B-on', 'B-off');
  restoreTerminal();
  assert.deepEqual(written, ['A-on', 'B-on', 'B-off', 'A-off']);
});

test('updateReset keeps the exit sequence in step with a mid-session /theme switch', () => {
  // runTui captured the LAUNCH theme in a const, so `/theme shadow` pushed OSC 11 with no matching
  // OSC 111 and a clean exit left the terminal black forever.
  const { stream, written } = captureStream();
  setTerminalOutput(stream);
  claimMode('theme-bg', '', 'RESET-none');
  updateReset('theme-bg', 'RESET-black');
  restoreTerminal();
  assert.ok(written.includes('RESET-black'), `expected the LIVE theme reset, got ${JSON.stringify(written)}`);
  assert.ok(!written.includes('RESET-none'), 'the stale launch-time reset must not be used');
});

test('updateReset(null) drops a mode whose reset no longer applies', () => {
  const { stream, written } = captureStream();
  setTerminalOutput(stream);
  claimMode('theme-bg', 'ON', 'OFF');
  updateReset('theme-bg', null);
  restoreTerminal();
  assert.ok(!written.includes('OFF'), 'a dropped mode must not be reset');
});

test('releaseMode resets immediately and unregisters (the clean-unmount path)', () => {
  const { stream, written } = captureStream();
  setTerminalOutput(stream);
  claimMode('mouse', 'M-on', 'M-off');
  releaseMode('mouse');
  assert.deepEqual(written, ['M-on', 'M-off']);
  assert.ok(!isClaimed('mouse'));
  restoreTerminal();
  assert.equal(written.filter((w) => w === 'M-off').length, 1, 'no double reset');
});

// ── The real thing: a child process, actually signalled ──────────────────────────────────────────

/**
 * Spawn a node process that claims modes through the REAL owner, signal it, and read back what
 * reached the "terminal". Output goes to a file because stdout is not flushed reliably by a dying
 * process, and the exit code proves the signal still kills.
 */
const PROBE_TIMEOUT_MS = 8_000;

function runSignalProbe(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): {
  written: string;
  status: number;
  elapsedMs: number;
  timedOut: boolean;
} {
  const dir = mkdtempSync(join(tmpdir(), 'term-restore-'));
  const logPath = join(dir, 'out.log');
  const script = `
    import { appendFileSync } from 'node:fs';
    import { claimMode, installRestoreHandlers, setTerminalOutput } from ${JSON.stringify(
      new URL('../src/tui/terminalState.ts', import.meta.url).pathname,
    )};
    setTerminalOutput({ write: (s) => { appendFileSync(${JSON.stringify(logPath)}, s); return true; } });
    installRestoreHandlers();
    claimMode('paste', 'PASTE_ON', 'PASTE_OFF');
    claimMode('title', '', 'TITLE_POP');
    claimMode('theme-bg', 'BG_ON', 'BG_OFF');
    claimMode('mouse', 'MOUSE_ON', 'MOUSE_OFF');
    setInterval(() => {}, 1000);            // stay alive like a real session
    process.kill(process.pid, ${JSON.stringify(signal)});
  `;
  const scriptPath = join(dir, 'probe.mts');
  writeFileSync(scriptPath, script);
  let status = 0;
  let timedOut = false;
  const started = Date.now();
  try {
    execFileSync(process.execPath, ['--import', 'tsx/esm', scriptPath], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
    });
  } catch (e) {
    const err = e as { status?: number; signal?: string; code?: string };
    status = err.status ?? -1;
    // execFileSync kills a hung child itself, which looks like a normal signal death from out
    // here. Without this the "still dies" assertion would PASS for an unkillable process — the
    // exact bug it exists to catch.
    timedOut = err.signal === 'SIGTERM' && Date.now() - started >= PROBE_TIMEOUT_MS - 500;
  }
  const elapsedMs = Date.now() - started;
  const written = readdirSync(dir).includes('out.log') ? readFileSync(logPath, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { written, status, elapsedMs, timedOut };
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(`${signal}: every claimed mode is reset, and the process still dies`, () => {
    const { written } = runSignalProbe(signal);
    for (const reset of ['PASTE_OFF', 'TITLE_POP', 'BG_OFF', 'MOUSE_OFF']) {
      assert.ok(
        written.includes(reset),
        `${signal} left the terminal dirty: ${reset} was never emitted (got ${JSON.stringify(written)})`,
      );
    }
  });

  test(`${signal}: the restore handler re-raises — a cleanup handler must not make us unkillable`, () => {
    // The 3.6.0 mouse fix used process.once(sig, off), which overrides Node's default disposition:
    // with mouse reporting on, the process survived SIGINT and SIGHUP and orphaned itself when the
    // terminal window closed. Reaching this assertion at all means the probe exited on its own.
    const { status, timedOut, elapsedMs } = runSignalProbe(signal);
    assert.ok(!timedOut, `${signal} did NOT terminate the process — it survived ${elapsedMs}ms and had to be force-killed`);
    assert.ok(elapsedMs < PROBE_TIMEOUT_MS / 2, `${signal} took ${elapsedMs}ms to terminate — suspiciously slow`);
    assert.notEqual(status, 0, `${signal} should not produce a clean exit(0) — the process must be terminated`);
  });
}
