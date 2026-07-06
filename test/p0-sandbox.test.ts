import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osSandboxStatus, sandboxToolAvailable, wrapCommand } from '../src/safety/sandbox.js';

// P0-9: the OS sandbox fails open (run_shell runs UNCONFINED) on hosts without
// the platform sandbox tool — most Linux images have no bubblewrap. The status
// advertised to the model/user must reflect *actual* tool availability, not a
// hard-coded "ON", or the system prompt lies about the security boundary.

test('osSandboxStatus: disabled (yolo / --no-sandbox / full autonomy) → OFF', () => {
  assert.equal(osSandboxStatus(false), 'OFF');
});

test('osSandboxStatus: requested status reflects actual sandbox-tool availability', () => {
  const status = osSandboxStatus(true);
  if (sandboxToolAvailable()) {
    assert.match(status, /^ON\b/, 'tool present → advertise ON');
    assert.doesNotMatch(status, /UNCONFINED/);
  } else {
    assert.equal(status, 'REQUESTED but UNAVAILABLE — run_shell runs UNCONFINED');
    assert.match(status, /UNCONFINED/, 'tool missing → must warn run_shell is unconfined');
  }
});

test('advertised status agrees with whether wrapCommand actually sandboxes run_shell', () => {
  const wrapped = wrapCommand({ command: 'echo hi', workspaceRoot: '/tmp', allowNetwork: true, enabled: true });
  // The truthful advertised status must match the boundary run_shell actually gets.
  assert.equal(sandboxToolAvailable(), wrapped.sandboxed, 'availability probe must match real confinement');
  if (wrapped.sandboxed) {
    assert.match(osSandboxStatus(true), /^ON\b/);
  } else {
    assert.match(osSandboxStatus(true), /UNCONFINED/);
    assert.ok(wrapped.note, 'unsandboxed result must carry the fail-open note for run_shell to surface');
  }
});
