import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASKS } from '../eval/tasks.js';
import type { RunResult } from '../eval/types.js';

const task = (id: string) => {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};

function run(over: Partial<RunResult> = {}): RunResult {
  return {
    exitCode: 0,
    timedOut: false,
    wallMs: 100,
    stdout: '',
    stderr: '',
    toolCalls: [],
    badJson: 0,
    errors: 0,
    iterations: 1,
    stopReason: 'end_turn',
    inputTokens: 0,
    outputTokens: 0,
    ...over,
  };
}

function ws(): string {
  return mkdtempSync(join(tmpdir(), 'eval-unit-'));
}

test('write-file check: exact content passes, wrong content fails', () => {
  const t = task('write-file');
  const a = ws();
  try {
    writeFileSync(join(a, 'hello.txt'), 'hello world\n');
    assert.equal(t.check(a, run()).pass, true);
    writeFileSync(join(a, 'hello.txt'), 'goodbye');
    assert.equal(t.check(a, run()).pass, false);
  } finally {
    rmSync(a, { recursive: true, force: true });
  }
});

test('edit-config check: needs 8080 and no 3000', () => {
  const t = task('edit-config');
  const a = ws();
  try {
    writeFileSync(join(a, 'config.js'), 'export const config = { host: "x", port: 8080 };\n');
    assert.equal(t.check(a, run({ toolCalls: [{ name: 'edit_file', ok: true }] })).pass, true);
    writeFileSync(join(a, 'config.js'), 'export const config = { host: "x", port: 3000 };\n');
    assert.equal(t.check(a, run()).pass, false);
  } finally {
    rmSync(a, { recursive: true, force: true });
  }
});

test('read-file check: needs the marker in output AND a read_file call', () => {
  const t = task('read-file');
  const a = ws();
  try {
    assert.equal(t.check(a, run({ stdout: 'the value is MARKER-7731', toolCalls: [{ name: 'read_file', ok: true }] })).pass, true);
    // marker present but no tool call → fail (it must actually use the tool)
    assert.equal(t.check(a, run({ stdout: 'MARKER-7731' })).pass, false);
  } finally {
    rmSync(a, { recursive: true, force: true });
  }
});

test('no-needless-tools check: 42 + zero tools + end_turn', () => {
  const t = task('no-needless-tools');
  assert.equal(t.check('', run({ stdout: 'It is 42.' })).pass, true);
  assert.equal(t.check('', run({ stdout: '42', toolCalls: [{ name: 'read_file', ok: true }] })).pass, false, 'using a tool fails it');
  assert.equal(t.check('', run({ stdout: 'forty-two' })).pass, false, 'must show the numeral');
});

test('the suite is well-formed (unique ids, every task has a check)', () => {
  const ids = TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const t of TASKS) {
    assert.equal(typeof t.check, 'function');
    assert.equal(typeof t.setup, 'function');
    assert.ok(t.prompt.length > 0);
  }
});
