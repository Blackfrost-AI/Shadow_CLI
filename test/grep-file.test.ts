import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grep } from '../src/tools/grep.js';
import type { ToolContext } from '../src/tools/types.js';

function ctxFor(ws: string): ToolContext {
  return { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
}

test('grep accepts a single FILE path (not just a directory)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'grepf-'));
  writeFileSync(join(ws, 'server.log'), 'error one\nok\nerror two\n');
  writeFileSync(join(ws, 'other.txt'), 'error elsewhere\n');
  try {
    const r = await grep.run({ pattern: 'error', path: 'server.log' }, ctxFor(ws));
    assert.ok(r.ok, r.summary);
    assert.equal(r.data?.matches.length, 2, 'matches only within the named file');
    assert.ok(r.data?.matches.every((m) => m.file === 'server.log'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('grep still searches a directory recursively', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'grepd-'));
  writeFileSync(join(ws, 'a.txt'), 'needle\n');
  writeFileSync(join(ws, 'b.txt'), 'nope\n');
  try {
    const r = await grep.run({ pattern: 'needle' }, ctxFor(ws));
    assert.ok(r.ok);
    assert.equal(r.data?.matches.length, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
