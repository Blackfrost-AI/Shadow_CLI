/**
 * Tool-result spill — oversized output is recoverable, not silently truncated.
 *
 * The property that matters: when a tool emits more than the cap, the model must still be able to
 * get the rest. And when the spill itself cannot be written, the result must degrade to exactly the
 * old truncation behaviour — never to an error and never to a `spilled: true` that lies about a
 * file that isn't there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spillIfOversized, spillDir } from '../src/agent/toolSpill.js';

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-spill-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('output under the cap is returned untouched', () => {
  withTmp((workspaceRoot) => {
    const body = 'short output';
    const r = spillIfOversized(body, { maxChars: 100, toolName: 'grep', toolCallId: 'c1', workspaceRoot });
    assert.equal(r.text, body);
    assert.equal(r.spilled, false);
    assert.equal(r.path, undefined);
  });
});

test('output exactly at the cap does not spill', () => {
  withTmp((workspaceRoot) => {
    const body = 'x'.repeat(100);
    const r = spillIfOversized(body, { maxChars: 100, toolName: 'grep', toolCallId: 'c1', workspaceRoot });
    assert.equal(r.spilled, false);
    assert.equal(r.text, body);
  });
});

test('oversized output spills the FULL body and hands back a locator', () => {
  withTmp((workspaceRoot) => {
    const body = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const r = spillIfOversized(body, { maxChars: 500, toolName: 'grep', toolCallId: 'c1', workspaceRoot });

    assert.equal(r.spilled, true);
    assert.ok(r.path, 'a spilled result must carry a path');
    assert.ok(existsSync(r.path!), 'the spilled file must exist');

    // The whole body round-trips — this is the point: nothing is lost.
    assert.equal(readFileSync(r.path!, 'utf8'), body);

    // The inline text is bounded and names the file.
    assert.ok(r.text.length < body.length, 'inline text must be smaller than the full body');
    assert.match(r.text, /full output saved to/);
    assert.match(r.text, /read_file|grep/);
  });
});

test('the spilled file is not world-readable', () => {
  withTmp((workspaceRoot) => {
    const body = 'y'.repeat(2000);
    const r = spillIfOversized(body, { maxChars: 100, toolName: 'run_shell', toolCallId: 'c9', workspaceRoot });
    assert.equal(r.spilled, true);
    const mode = statSync(r.path!).mode & 0o777;
    assert.equal(mode, 0o600, `spill file must be 0600, got ${mode.toString(8)}`);
  });
});

test('the spill directory is private to the session tree', () => {
  withTmp((workspaceRoot) => {
    const body = 'z'.repeat(2000);
    spillIfOversized(body, { maxChars: 100, toolName: 'grep', toolCallId: 'c2', workspaceRoot });
    const dirMode = statSync(spillDir(workspaceRoot)).mode & 0o777;
    assert.equal(dirMode, 0o700, `spill dir must be 0700, got ${dirMode.toString(8)}`);
  });
});

test('a tool name or call id cannot traverse out of the spill directory', () => {
  withTmp((workspaceRoot) => {
    const body = 'w'.repeat(2000);
    const r = spillIfOversized(body, {
      maxChars: 100,
      toolName: '../../etc/passwd',
      toolCallId: '../../../../tmp/evil',
      workspaceRoot,
    });
    assert.equal(r.spilled, true);
    // Stays inside the spill dir despite a hostile name.
    const dir = spillDir(workspaceRoot);
    assert.ok(r.path!.startsWith(dir), `${r.path} must stay under ${dir}`);
    assert.ok(!r.path!.includes('..'), 'no traversal segments in the spill path');
  });
});
test('an unwritable location degrades to a plain truncation, never a false spill claim', () => {
  const body = 'q'.repeat(5000);
  // A path under a regular file can't be mkdir'd — a stand-in for a read-only workspace.
  const fileNotDir = join(tmpdir(), `shadow-spill-blocker-${process.pid}`);
  rmSync(fileNotDir, { force: true });
  try {
    writeFileSync(fileNotDir, 'x');
    const r = spillIfOversized(body, {
      maxChars: 200,
      toolName: 'grep',
      toolCallId: 'c3',
      workspaceRoot: '/nonexistent',
      dir: join(fileNotDir, 'sub'),
    });
    assert.equal(r.spilled, false);
    assert.equal(r.path, undefined);
    // Bounded, and honest that the full output was not saved.
    assert.ok(r.text.length < body.length);
    assert.match(r.text, /truncated/);
    assert.match(r.text, /couldn't save/);
  } finally {
    rmSync(fileNotDir, { force: true });
  }
});

test('a non-positive or non-finite cap never spills', () => {
  withTmp((workspaceRoot) => {
    for (const maxChars of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = spillIfOversized('some output', { maxChars, toolName: 't', toolCallId: 'c', workspaceRoot });
      assert.equal(r.spilled, false, `cap ${maxChars} must not spill`);
    }
  });
});