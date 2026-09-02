import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headlessInputSource } from '../src/replGate.js';

/**
 * Pins the stdin/stdout routing invariant of the headless loop: which source it consumes is
 * decided by STDIN alone. `shadow | tee` (TTY stdin, redirected stdout) must reach the prompt
 * loop — routing it to the piped branch made the loop read fd 0 synchronously, which BLOCKS on
 * the terminal until EOF (hung process, no prompt). An end-to-end version would need a PTY on
 * stdin, which node:test cannot spawn portably — the pure decision plus the single call site in
 * src/index.ts is the tested seam.
 */
test('a terminal on stdin routes to the prompt loop, even when stdout is redirected', () => {
  assert.equal(headlessInputSource(true), 'repl');
});

test('piped/redirected stdin routes to the captured pipe', () => {
  assert.equal(headlessInputSource(false), 'piped');
});

test('the piped source is unreachable while stdin is a terminal (the fd-0 invariant)', () => {
  for (const stdinIsTTY of [true, false]) {
    const source = headlessInputSource(stdinIsTTY);
    assert.equal(source === 'piped', !stdinIsTTY, 'piped is chosen only for a non-TTY stdin');
  }
});
