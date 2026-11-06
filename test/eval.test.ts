import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASKS } from '../eval/tasks.js';
import { isCleanStop, parseSessionEvents } from '../eval/telemetry.js';
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
    compactions: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    iterInputTokens: 0,
    iterOutputTokens: 0,
    subagentInputTokens: 0,
    subagentOutputTokens: 0,
    subagentCostUSD: 0,
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

test('stop-health classification: fixture pass must not override an abnormal stop', () => {
  // A clean terminal state.
  assert.equal(isCleanStop(run()), true);
  // Every abnormal stop reason fails the run even with a correct artifact.
  for (const reason of [
    'provider_error',
    'max_iterations',
    'budget',
    'interrupted',
    'fatal_tool_error',
    'spawn_error',
    'max_tokens',
    'tool_use',
  ]) {
    assert.equal(isCleanStop(run({ stopReason: reason })), false, `${reason} must fail`);
  }
  // No stop reason at all (no session log) → fail.
  assert.equal(isCleanStop(run({ stopReason: '' })), false);
  // Wall-clock kill or nonzero process exit → fail.
  assert.equal(isCleanStop(run({ timedOut: true })), false);
  assert.equal(isCleanStop(run({ exitCode: 1 })), false);
  // refusal / pause_turn are legitimate terminal states.
  assert.equal(isCleanStop(run({ stopReason: 'refusal' })), true);
  assert.equal(isCleanStop(run({ stopReason: 'pause_turn' })), true);
});

test('usage accounting: cumulative snapshots are latest-wins, per-request fields are summed', () => {
  const events: Record<string, unknown>[] = [
    // Three turns of TURN-CUMULATIVE budget snapshots: 10 → 25 → 40.
    { type: 'usage', inputTokens: 10, outputTokens: 2 },
    { type: 'usage', inputTokens: 25, outputTokens: 4 },
    { type: 'usage', inputTokens: 40, outputTokens: 6 },
    // Per-request cache/iteration fields must be SUMMED.
    { type: 'usage', iterInputTokens: 100, iterOutputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5 },
    { type: 'usage', iterInputTokens: 120, iterOutputTokens: 8, cacheReadTokens: 90, cacheWriteTokens: 0 },
    // Two finished sub-agents, each a one-shot total.
    { type: 'subagent_usage', inputTokens: 500, outputTokens: 50, costUSD: 0.5 },
    { type: 'subagent_usage', inputTokens: 300, outputTokens: 30, costUSD: 0.2 },
  ];
  const t = parseSessionEvents(events);
  // Cumulative snapshots: LATEST value retained, not the sum (which would be 75).
  assert.equal(t.inputTokens, 40);
  assert.equal(t.outputTokens, 6);
  // Per-request fields: each request counted exactly once.
  assert.equal(t.iterInputTokens, 220);
  assert.equal(t.iterOutputTokens, 18);
  assert.equal(t.cacheReadTokens, 170);
  assert.equal(t.cacheWriteTokens, 5);
  // Sub-agent one-shot totals: summed across events.
  assert.equal(t.subagentInputTokens, 800);
  assert.equal(t.subagentOutputTokens, 80);
  assert.equal(t.subagentCostUSD, 0.7);
});
