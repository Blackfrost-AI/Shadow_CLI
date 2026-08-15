import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderSubAgentPanel,
  subagentColorIndex,
  formatTokens,
  type SubAgentView,
} from '../src/tui/subagentPanel.js';

function agent(over: Partial<SubAgentView> = {}): SubAgentView {
  return {
    taskId: over.taskId ?? 't1',
    subagentType: over.subagentType ?? 'explore',
    description: over.description,
    tool: over.tool,
    argPreview: over.argPreview,
    toolUseCount: over.toolUseCount ?? 0,
    inputTokens: over.inputTokens ?? 0,
    outputTokens: over.outputTokens ?? 0,
    startedAt: over.startedAt ?? 1000,
    background: over.background ?? false,
    done: over.done,
    ok: over.ok,
  };
}

test('formatTokens: compact human units', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(942), '942');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(262144), '262k');
});

test('subagentColorIndex is deterministic and in range', () => {
  const a = subagentColorIndex('explore', 5);
  const b = subagentColorIndex('explore', 5);
  assert.equal(a, b, 'same type → same slot');
  for (const t of ['explore', 'reviewer', 'general-purpose', 'planner', 'x']) {
    const i = subagentColorIndex(t, 5);
    assert.ok(i >= 0 && i < 5, `${t} → in range`);
  }
  assert.equal(subagentColorIndex('x', 0), 0, 'empty palette is safe');
});

test('a single agent folds onto one line with type, status and counters', () => {
  const lines = renderSubAgentPanel([agent({ subagentType: 'reviewer', tool: 'read_file', argPreview: 'a.ts', toolUseCount: 3, inputTokens: 1000, outputTokens: 240 })], 2, 5);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.kind, 'agent');
  assert.equal(lines[0]!.label, 'reviewer');
  assert.match(lines[0]!.detail, /read_file a\.ts/);
  assert.match(lines[0]!.detail, /3 tools/);
  assert.match(lines[0]!.detail, /1\.2k tok/);
  assert.ok(lines[0]!.running);
});

test('a fresh agent with no tool reads Initializing…; after a tool it reads running…', () => {
  assert.match(renderSubAgentPanel([agent()], 2, 5)[0]!.detail, /Initializing…/);
  assert.match(renderSubAgentPanel([agent({ toolUseCount: 2, background: true })], 2, 5)[0]!.detail, /running…/);
});

test('a done agent shows Done / failed and is not running', () => {
  const done = renderSubAgentPanel([agent({ done: true, ok: true })], 2, 5)[0]!;
  assert.match(done.detail, /Done/);
  assert.equal(done.running, false);
  assert.match(renderSubAgentPanel([agent({ done: true, ok: false })], 2, 5)[0]!.detail, /failed/);
});

test('two agents in a 2-row budget: header + one summary/agent row, spinner while any running', () => {
  const lines = renderSubAgentPanel(
    [agent({ taskId: 'a', toolUseCount: 2 }), agent({ taskId: 'b', subagentType: 'reviewer', toolUseCount: 3 })],
    2,
    5,
  );
  assert.ok(lines.length <= 2, 'must not exceed the row budget');
  assert.equal(lines[0]!.kind, 'header');
  assert.match(lines[0]!.detail, /Running 2 agents/);
  assert.ok(lines[0]!.running, 'header animates while any agent runs');
});

test('tight budget (maxRows=1) with ≥2 agents degrades to ONE summary row with the tool total', () => {
  const lines = renderSubAgentPanel(
    [agent({ taskId: 'a', toolUseCount: 2 }), agent({ taskId: 'b', toolUseCount: 3 }), agent({ taskId: 'c' })],
    1,
    5,
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.kind, 'summary');
  assert.match(lines[0]!.detail, /Running 3 agents · 5 tool calls…/);
});

test('overflow beyond the budget folds into a +N more row; running agents are shown first', () => {
  const many = [
    agent({ taskId: 'a', done: true, ok: true, startedAt: 1 }),
    agent({ taskId: 'b', startedAt: 2 }),
    agent({ taskId: 'c', startedAt: 3 }),
    agent({ taskId: 'd', startedAt: 4 }),
  ];
  const lines = renderSubAgentPanel(many, 3, 5); // header + 2 body rows
  assert.equal(lines[0]!.kind, 'header');
  assert.ok(lines.length <= 3);
  const more = lines.find((l) => l.kind === 'more');
  assert.ok(more, 'an overflow row is present');
  // The finished agent must NOT occupy a slot ahead of a running one.
  const agentLines = lines.filter((l) => l.kind === 'agent');
  assert.ok(agentLines.every((l) => l.running), 'running agents are shown before the +N more fold');
});

test('all-done panel reads "N agents finished" and does not animate', () => {
  const lines = renderSubAgentPanel(
    [agent({ taskId: 'a', done: true, ok: true }), agent({ taskId: 'b', done: true, ok: true })],
    2,
    5,
  );
  assert.match(lines[0]!.detail, /2 agents finished/);
  assert.equal(lines[0]!.running, false);
});

test('empty input and zero budget produce no lines', () => {
  assert.deepEqual(renderSubAgentPanel([], 2, 5), []);
  assert.deepEqual(renderSubAgentPanel([agent()], 0, 5), []);
});
