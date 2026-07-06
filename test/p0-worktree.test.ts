import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorktree,
  removeWorktree,
  makeWorktreeCreateTool,
  makeWorktreeRemoveTool,
} from '../src/tools/worktree.js';
import type { ToolContext } from '../src/tools/types.js';

// P0-2: tools/worktree.ts must reject model-controlled ids that carry shell
// metacharacters (command-substitution -> RCE) or path traversal (../../ ->
// arbitrary-dir delete), and must build paths with execFileSync argv + resolveWithin
// containment so a malicious id can never be shell-parsed or escape worktreesRoot.

const ctxFor = (ws: string): ToolContext => ({
  workspaceRoot: ws,
  signal: new AbortController().signal,
  log: () => {},
  dryRun: false,
});

// Inputs that previously reached `git worktree add --detach "${wtPath}"` / rmSync.
const INJECTION_IDS = [
  '$(touch pwned)',
  '`touch pwned`',
  'foo;rm -rf x',
  'foo && id',
  'foo|whoami',
  'foo $(id)',
  'foo bar', // space breaks the unquoted-argv assumption
];
const TRAVERSAL_IDS = [
  '../../etc',
  '../../../etc/passwd',
  '..',
  '.',
  '/etc/passwd',
  'a/../../b',
  'sub/dir', // separators are not a single safe segment
];

test('worktree_create rejects command-injection ids at the tool boundary (no exec, no file written)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p0-wt-create-inj-'));
  try {
    const tool = makeWorktreeCreateTool();
    const ctx = ctxFor(ws);
    for (const id of INJECTION_IDS) {
      const res = await tool.run({ id } as any, ctx);
      assert.equal(res.ok, false, `injection id must be rejected: ${id}`);
      assert.equal(res.error?.code, 'invalid_id', `expected invalid_id for: ${id}`);
    }
    // The command-substitution payload must never have executed.
    assert.equal(existsSync(join(ws, 'pwned')), false, 'no command substitution should have run');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('worktree_create + worktree_remove reject path-traversal / absolute ids', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p0-wt-trav-'));
  try {
    const createTool = makeWorktreeCreateTool();
    const removeTool = makeWorktreeRemoveTool();
    const ctx = ctxFor(ws);
    for (const id of TRAVERSAL_IDS) {
      const c = await createTool.run({ id } as any, ctx);
      assert.equal(c.ok, false, `create must reject traversal id: ${id}`);
      assert.equal(c.error?.code, 'invalid_id', `create invalid_id for: ${id}`);

      const r = await removeTool.run({ id } as any, ctx);
      assert.equal(r.ok, false, `remove must reject traversal id: ${id}`);
      assert.equal(r.error?.code, 'invalid_id', `remove invalid_id for: ${id}`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('worktree_create accepts a well-formed id and creates a dir under .shadow/worktrees', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p0-wt-ok-'));
  try {
    const tool = makeWorktreeCreateTool();
    const res = await tool.run({ id: 'good-id_1.2' } as any, ctxFor(ws));
    assert.equal(res.ok, true, 'a safe id must be accepted');
    // git worktree add fails outside a repo -> fallback plain dir; either way it lands
    // inside the managed worktrees root.
    assert.ok(existsSync(join(ws, '.shadow/worktrees', 'good-id_1.2')), 'worktree dir created under managed root');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('removeWorktree (core) cannot delete an arbitrary absolute dir outside worktreesRoot', () => {
  const ws = mkdtempSync(join(tmpdir(), 'p0-wt-base-'));
  const victim = mkdtempSync(join(tmpdir(), 'p0-wt-victim-'));
  try {
    const sentinel = join(victim, 'keep.txt');
    writeFileSync(sentinel, 'do not delete');
    // Absolute path fully outside the managed worktrees dir -> resolveWithin throws.
    assert.throws(() => removeWorktree(ws, victim), /outside the workspace/);
    assert.ok(existsSync(sentinel), 'victim dir must be untouched');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(victim, { recursive: true, force: true });
  }
});

test('removeWorktree (core) sibling ".shadow/worktrees-evil" is not treated as inside (sep boundary)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'p0-wt-sib-'));
  try {
    const evilDir = join(ws, '.shadow', 'worktrees-evil');
    mkdirSync(evilDir, { recursive: true });
    const sentinel = join(evilDir, 'keep.txt');
    writeFileSync(sentinel, 'do not delete');
    // Bare startsWith(worktreesRoot) would have matched "worktrees-evil"; the sep
    // boundary + resolveWithin reject it.
    assert.throws(() => removeWorktree(ws, evilDir), /outside the workspace/);
    assert.ok(existsSync(sentinel), 'sibling dir must be untouched');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('createWorktree (core) throws on a traversal id instead of escaping worktreesRoot', () => {
  const ws = mkdtempSync(join(tmpdir(), 'p0-wt-core-create-'));
  const victim = mkdtempSync(join(tmpdir(), 'p0-wt-core-victim-'));
  try {
    assert.throws(() => createWorktree(ws, '../../../../../../../../tmp/escape'), /outside the workspace/);
    assert.ok(existsSync(victim), 'no escape should have occurred');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(victim, { recursive: true, force: true });
  }
});

test('removeWorktree (core) round-trips a legitimately-created fallback worktree', () => {
  const ws = mkdtempSync(join(tmpdir(), 'p0-wt-roundtrip-'));
  try {
    const info = createWorktree(ws, 'rt-1');
    assert.ok(existsSync(info.path), 'worktree created');
    // Passing the absolute managed path (as agent isolation cleanup does) must work.
    removeWorktree(ws, info.path);
    assert.equal(existsSync(info.path), false, 'worktree removed');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
