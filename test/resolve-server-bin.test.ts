/**
 * resolveServerBin — finds a bare server binary (llama-server / mlx_lm.server) in Shadow's own
 * install dir and common local-bins before falling back to a bare PATH lookup.
 *
 * The bug it fixes: Shadow installs to ~/.local/bin and spawns `llama-server` by bare name, relying
 * on the inherited PATH. Launched from a context whose PATH omits ~/.local/bin, the spawn ENOENTs
 * even though the binary sits right beside the Shadow executable. The resolver checks the Shadow
 * binary's own directory first. Candidate dirs are injectable so the gate is deterministic in tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveServerBin } from '../src/gguf.js';

test('an explicit path is returned untouched (never scanned)', () => {
  assert.equal(resolveServerBin('/opt/models/llama-server', []), '/opt/models/llama-server');
  assert.equal(resolveServerBin('./bin/llama-server', []), './bin/llama-server');
  assert.equal(resolveServerBin('C:\\tools\\llama-server.exe', []), 'C:\\tools\\llama-server.exe');
});

test('a bare name with no candidate dir falls back to the bare name (PATH lookup preserved)', () => {
  assert.equal(resolveServerBin('llama-server', []), 'llama-server');
  assert.equal(resolveServerBin('llama-server', ['/no/such/dir']), 'llama-server');
});

test('an executable sitting in a candidate dir resolves to its absolute path (the ~/.local/bin fix)', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX exec-bit semantics');
  const dir = mkdtempSync(join(tmpdir(), 'rsb-'));
  const exe = join(dir, 'llama-server');
  writeFileSync(exe, '#!/bin/sh\necho hi\n');
  chmodSync(exe, 0o755);
  assert.equal(resolveServerBin('llama-server', [dir]), exe, 'found beside the (simulated) Shadow binary');
});

test('a NON-executable match is skipped — the resolver keeps scanning, then falls back', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX exec-bit semantics');
  const bad = mkdtempSync(join(tmpdir(), 'rsb-bad-'));
  writeFileSync(join(bad, 'llama-server'), 'not executable\n');
  chmodSync(join(bad, 'llama-server'), 0o644);
  // only a non-exec match → fall back to bare name
  assert.equal(resolveServerBin('llama-server', [bad]), 'llama-server');
  // …but a later candidate dir WITH an executable still wins (order + skip both exercised)
  const good = mkdtempSync(join(tmpdir(), 'rsb-good-'));
  const exe = join(good, 'llama-server');
  writeFileSync(exe, '#!/bin/sh\n');
  chmodSync(exe, 0o755);
  assert.equal(resolveServerBin('llama-server', [bad, good]), exe, 'skips non-exec, takes the real one');
});
