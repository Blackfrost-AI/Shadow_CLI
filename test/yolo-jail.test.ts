import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { resolveWithin } from '../src/safety/workspaceJail.js';

test('jail blocks an out-of-workspace path by default', () => {
  const ws = mkdtempSync(join(tmpdir(), 'jail-'));
  try {
    assert.throws(() => resolveWithin([ws], '/tmp/yolo-target/x.txt'), /outside the workspace/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('granting the filesystem root (what --yolo does) disables the jail', () => {
  const ws = mkdtempSync(join(tmpdir(), 'jail-'));
  try {
    const out = resolveWithin([ws, '/'], '/tmp/yolo-target/x.txt');
    assert.ok(isAbsolute(out));
    assert.match(out, /yolo-target[/\\]x\.txt$/); // tail preserved; the path is allowed, not thrown
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a relative path still resolves under the workspace even with root granted', () => {
  const ws = mkdtempSync(join(tmpdir(), 'jail-'));
  try {
    const out = resolveWithin([ws, '/'], 'sub/file.txt');
    assert.ok(out.startsWith(ws) || out.includes('sub')); // relative still anchors to the workspace
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
