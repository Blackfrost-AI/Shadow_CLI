import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveWithin } from '../src/safety/workspaceJail.js';

// P0 regression coverage for the jail-containment primitive. Several P0 fixes
// (worktree creation, the skills loader) route through `resolveWithin`, so its
// contract is load-bearing:
//   1. a contained path is returned anchored to the root AS THE CALLER SPELLED
//      IT (no silent rewrite through a root-level symlink such as macOS
//      /var → /private/var — this was the bug the two failing tests caught), and
//   2. containment is never weakened: `..` escapes, absolute-outside paths, and
//      symlinks that point out of every granted root are still rejected.

function mk(prefix: string): string {
  return resolve(mkdtempSync(join(tmpdir(), prefix)));
}

test('resolveWithin: a contained relative path is anchored to the caller-spelled root, not realpath-rewritten', () => {
  const ws = mk('p0-ws-');
  try {
    // The whole point: even when realpathSync(ws) !== ws (macOS tmp is a symlink),
    // the returned path must equal resolve(ws, rel), not the /private-rewritten form.
    assert.equal(resolveWithin(ws, 'a/b.txt'), resolve(ws, 'a/b.txt'));
    assert.equal(resolveWithin([ws], 'nested/deep/file.txt'), resolve(ws, 'nested/deep/file.txt'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveWithin: rejects `..` traversal, absolute-outside, and empty input', () => {
  const ws = mk('p0-ws-');
  try {
    assert.throws(() => resolveWithin(ws, '../escape.txt'), /outside the workspace/);
    assert.throws(() => resolveWithin(ws, 'a/../../escape.txt'), /outside the workspace/);
    assert.throws(() => resolveWithin(ws, '/etc/passwd'), /outside the workspace/);
    assert.throws(() => resolveWithin(ws, ''), /non-empty/);
    assert.throws(() => resolveWithin(ws, '   '), /non-empty/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveWithin (multi-root): granted dir allowed (anchored to its spelling); relative still resolves against the workspace; ungranted rejected', () => {
  const ws = mk('p0-ws-');
  const granted = mk('p0-granted-');
  const ungranted = mk('p0-ungranted-');
  try {
    // Absolute path inside a granted root → allowed, anchored to the granted spelling.
    assert.equal(resolveWithin([ws, granted], join(granted, 'out.txt')), resolve(granted, 'out.txt'));
    // Relative paths anchor to the FIRST root (the workspace), never a later grant.
    assert.equal(resolveWithin([ws, granted], 'rel.txt'), resolve(ws, 'rel.txt'));
    // A dir that was not granted stays rejected.
    assert.throws(() => resolveWithin([ws, granted], join(ungranted, 'x.txt')), /outside the workspace/);
  } finally {
    for (const d of [ws, granted, ungranted]) rmSync(d, { recursive: true, force: true });
  }
});

test('resolveWithin: a symlink pointing outside every root is rejected (containment, even for a not-yet-existing tail)', () => {
  const ws = mk('p0-ws-');
  const outside = mk('p0-outside-');
  try {
    symlinkSync(realpathSync(outside), join(ws, 'link')); // ws/link -> outside dir
    assert.throws(() => resolveWithin(ws, 'link'), /outside the workspace/);
    assert.throws(() => resolveWithin(ws, 'link/secret.txt'), /outside the workspace/);
    assert.throws(() => resolveWithin(ws, 'link/brand-new.txt'), /outside the workspace/);
  } finally {
    for (const d of [ws, outside]) rmSync(d, { recursive: true, force: true });
  }
});

test('resolveWithin: a symlink that stays inside the workspace is allowed and collapsed to its real, contained location', () => {
  const ws = mk('p0-ws-');
  try {
    const realDir = join(ws, 'real');
    mkdirSync(realDir);
    symlinkSync(realDir, join(ws, 'alias')); // ws/alias -> ws/real (stays inside)
    const out = resolveWithin(ws, 'alias/file.txt');
    // Inner symlink is collapsed to the real location, and the result is contained.
    assert.equal(out, resolve(ws, 'real/file.txt'));
    assert.ok(out.startsWith(realpathSync(ws)) || out.startsWith(ws));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
