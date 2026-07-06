import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLog } from '../src/state/session.js';

/**
 * P0-10: the session log is an append-only replay of the whole run — user inputs,
 * tool calls, tool results — so even after `redact`, a secret the redactor misses
 * can land on disk. It must not be world-readable, and it must not be git-addable.
 * The sessions directory is 0700, the log file is 0600, and `.shadow/.gitignore`
 * ignores everything.
 */
test('session log dir is 0700 and log file is 0600', () => {
  const ws = mkdtempSync(join(tmpdir(), 'p0-session-'));
  try {
    const log = SessionLog.open(ws);
    log.record({ kind: 'user', text: 'hello' }); // creates the file lazily
    assert.equal(log.lastError, undefined, 'append must not error');

    const dir = join(ws, '.shadow', 'sessions');
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'sessions dir must be 0700');
    assert.equal(statSync(log.path).mode & 0o777, 0o600, 'session log file must be 0600');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('opening a session log writes .shadow/.gitignore of "*"', () => {
  const ws = mkdtempSync(join(tmpdir(), 'p0-session-gi-'));
  try {
    SessionLog.open(ws);
    const gitignore = readFileSync(join(ws, '.shadow', '.gitignore'), 'utf8');
    assert.equal(gitignore.trim(), '*', '.shadow/.gitignore must ignore everything');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
