import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoOnboard, NO_PROVIDER_HINT } from '../src/cli/autoOnboard.js';

/**
 * First-run auto-onboard decision (plan item 1.1): an unconfigured, genuinely
 * interactive launch drops into the `shadow onboard` wizard; one-shot/headless
 * and non-TTY launches keep the stderr hint + exit path.
 */

// The canonical "should launch the wizard" shape: first run, interactive terminal.
const interactiveFirstRun = {
  configured: false,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  taskMode: false,
  replMode: false,
};

test('shouldAutoOnboard: TTY + unconfigured → true', () => {
  assert.equal(shouldAutoOnboard(interactiveFirstRun), true);
});

test('shouldAutoOnboard: already configured → false', () => {
  assert.equal(shouldAutoOnboard({ ...interactiveFirstRun, configured: true }), false);
});

test('shouldAutoOnboard: one-shot --task (print) mode → false', () => {
  assert.equal(shouldAutoOnboard({ ...interactiveFirstRun, taskMode: true }), false);
});

test('shouldAutoOnboard: --repl (headless) mode → false', () => {
  assert.equal(shouldAutoOnboard({ ...interactiveFirstRun, replMode: true }), false);
});

test('shouldAutoOnboard: stdin not a TTY (piped input) → false', () => {
  assert.equal(shouldAutoOnboard({ ...interactiveFirstRun, stdinIsTTY: false }), false);
});

test('shouldAutoOnboard: stdout not a TTY (redirected output) → false', () => {
  assert.equal(shouldAutoOnboard({ ...interactiveFirstRun, stdoutIsTTY: false }), false);
});

test('shouldAutoOnboard: headless flags win even when both streams are TTYs', () => {
  assert.equal(shouldAutoOnboard({ ...interactiveFirstRun, taskMode: true, replMode: true }), false);
});

test('shouldAutoOnboard: configured wins even in headless/non-TTY shapes', () => {
  assert.equal(
    shouldAutoOnboard({ ...interactiveFirstRun, configured: true, stdinIsTTY: false, taskMode: true }),
    false,
  );
});

test('NO_PROVIDER_HINT: the fallback hint still points at `shadow onboard`', () => {
  assert.match(NO_PROVIDER_HINT, /No model provider configured/);
  assert.match(NO_PROVIDER_HINT, /shadow onboard/);
});
