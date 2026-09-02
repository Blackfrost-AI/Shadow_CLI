import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { atomicWrite } = await import('../src/tools/util.js');

// A config/credentials rewrite that silently resets permission bits (600 → 644) publishes the
// file world-readable between the unlink and the next chmod. atomicWrite must carry the EXISTING
// bits forward when the caller doesn't specify a mode.
test('atomicWrite preserves an existing file’s permission bits on rewrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-mode-'));
  try {
    const p = join(dir, 'secret.json');
    writeFileSync(p, '{}', { mode: 0o600 });
    chmodSync(p, 0o600); // make the precondition umask-independent
    atomicWrite(p, '{"a":1}');
    assert.equal(statSync(p).mode & 0o777, 0o600, 'rewrite must not reset 600 → 644');
    // An EXPLICIT mode still wins (the caller knows best).
    atomicWrite(p, '{"a":2}', 0o640);
    assert.equal(statSync(p).mode & 0o777, 0o640);
    // Content really was replaced.
    assert.equal(statSync(p).size, '{"a":2}'.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
