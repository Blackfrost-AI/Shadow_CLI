import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { multiEdit } from '../src/tools/multiEdit.js';
import type { ToolContext } from '../src/tools/types.js';

function ctxFor(ws: string): ToolContext {
  return { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
}

test('multi_edit applies edits in order, atomically, and carries a diff', async () => {
  const ws = resolve(mkdtempSync(join(tmpdir(), 'medit-')));
  const f = join(ws, 'a.ts');
  writeFileSync(f, 'const a = 1\nconst b = 2\nconst c = 3\n');
  try {
    const r = await multiEdit.run(
      {
        path: f,
        edits: [
          { old_string: 'const a = 1', new_string: 'const a = 10' },
          { old_string: 'const c = 3', new_string: 'const c = 30' },
        ],
      },
      ctxFor(ws),
    );
    assert.ok(r.ok, r.summary);
    assert.equal(readFileSync(f, 'utf8'), 'const a = 10\nconst b = 2\nconst c = 30\n');
    assert.ok(r.meta.diff?.some((l) => l.tag === '+' && l.text === 'const a = 10'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('multi_edit is all-or-nothing — a failing edit writes nothing', async () => {
  const ws = resolve(mkdtempSync(join(tmpdir(), 'medit-')));
  const f = join(ws, 'a.ts');
  const original = 'const a = 1\nconst b = 2\n';
  writeFileSync(f, original);
  try {
    const r = await multiEdit.run(
      {
        path: f,
        edits: [
          { old_string: 'const a = 1', new_string: 'const a = 10' }, // would succeed
          { old_string: 'DOES NOT EXIST', new_string: 'x' }, // fails → whole call aborts
        ],
      },
      ctxFor(ws),
    );
    assert.equal(r.ok, false);
    assert.equal(readFileSync(f, 'utf8'), original, 'file is untouched when any edit fails');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('multi_edit later edits see the result of earlier ones', async () => {
  const ws = resolve(mkdtempSync(join(tmpdir(), 'medit-')));
  const f = join(ws, 'a.ts');
  writeFileSync(f, 'X\n');
  try {
    const r = await multiEdit.run(
      { path: f, edits: [{ old_string: 'X', new_string: 'Y' }, { old_string: 'Y', new_string: 'Z' }] },
      ctxFor(ws),
    );
    assert.ok(r.ok, r.summary);
    assert.equal(readFileSync(f, 'utf8'), 'Z\n', 'second edit operated on the first edit’s output');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
