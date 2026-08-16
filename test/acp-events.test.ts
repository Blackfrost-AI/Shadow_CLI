import test from 'node:test';
import assert from 'node:assert/strict';
import type { LoopEvent } from '../src/agent/events.js';
import type { ToolCall } from '../src/provider/provider.js';
import type { ToolResult } from '../src/tools/types.js';
import { mapEventToUpdate, toolKindFor, riskKind, toolCallTitle } from '../src/acp/events.js';

/**
 * The bus → session/update mapper is the single source of truth for the editor's wire shape.
 * These tests PIN that shape: update discriminators, tool kinds, statuses, and which events are
 * deliberately NOT mapped (a stray mapping would double-render or leak loop internals).
 */

const call = (name: string, id = 't1', input: unknown = { path: 'a.txt' }): ToolCall => ({ id, name, input });

const result = (ok: boolean, summary: string, error?: { code: string; message: string }): ToolResult =>
  ({
    ok,
    summary,
    ...(error ? { error: { ...error, recoverable: false } } : {}),
    meta: { tool: 'x', durationMs: 1, risk: 'read' },
  }) as ToolResult;

test('text delta → agent_message_chunk; empty delta maps to nothing', () => {
  assert.deepEqual(mapEventToUpdate({ type: 'text', delta: 'Hello' }), {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello' },
  });
  assert.equal(mapEventToUpdate({ type: 'text', delta: '' }), null);
});

test('thinking delta → agent_thought_chunk', () => {
  assert.deepEqual(mapEventToUpdate({ type: 'thinking', delta: 'hmm' }), {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'hmm' },
  });
});

test('finding → thought chunk carrying title and body (error severity prefixed)', () => {
  const info = mapEventToUpdate({ type: 'finding', title: 'startup', body: 'ready', severity: 'info' });
  assert.deepEqual(info, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'startup\nready' },
  });
  const bad = mapEventToUpdate({ type: 'finding', title: 'oops', body: 'nope', severity: 'error' });
  assert.equal((bad!.content as { text: string }).text, '[error] oops\nnope');
});

test('error → thought chunk prefixed [error]', () => {
  assert.deepEqual(mapEventToUpdate({ type: 'error', message: 'provider down' }), {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: '[error] provider down' },
  });
});

test('tool_start → tool_call with id, kind, in_progress, and rawInput', () => {
  const update = mapEventToUpdate({
    type: 'tool_start',
    call: call('read_file', 'tc-9', { path: 'x' }),
    risk: 'read',
  });
  assert.deepEqual(update, {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-9',
    title: 'read_file',
    kind: 'read',
    status: 'in_progress',
    rawInput: { path: 'x' },
  });
});

test('tool_start titles are prefixed when the bus tagged a sub-agent', () => {
  const update = mapEventToUpdate({
    type: 'tool_start',
    call: call('run_shell', 'tc-1', { command: 'ls' }),
    risk: 'exec',
    subagent: 'agent-7',
  });
  assert.equal(update!.title, '[subagent agent-7] run_shell');
  assert.equal(update!.kind, 'execute');
});

test('tool_end ok → tool_call_update completed with the summary', () => {
  const update = mapEventToUpdate({
    type: 'tool_end',
    call: call('read_file', 'tc-9'),
    result: result(true, 'read 3 lines'),
  });
  assert.deepEqual(update, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-9',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'read 3 lines' } }],
  });
});

test('tool_end failure → failed with the error message (summary fallback)', () => {
  const failed = mapEventToUpdate({
    type: 'tool_end',
    call: call('run_shell', 'tc-2'),
    result: result(false, '', { code: 'exit', message: 'exit 1' }),
  });
  assert.equal(failed!.status, 'failed');
  assert.equal(((failed!.content as unknown[])[0] as { content: { text: string } }).content.text, 'exit 1');

  const summaryFallback = mapEventToUpdate({
    type: 'tool_end',
    call: call('run_shell', 'tc-3'),
    result: result(false, 'gave up'),
  });
  assert.equal(((summaryFallback!.content as unknown[])[0] as { content: { text: string } }).content.text, 'gave up');
});

test('tool_denied → failed update explaining the denial', () => {
  const update = mapEventToUpdate({
    type: 'tool_denied',
    call: call('run_shell', 'tc-4'),
    reason: 'denylisted: rm -rf',
  });
  assert.equal(update!.sessionUpdate, 'tool_call_update');
  assert.equal(update!.status, 'failed');
  assert.equal(((update!.content as unknown[])[0] as { content: { text: string } }).content.text, 'denied: denylisted: rm -rf');
});

test('todo → plan entries with the 1:1 status map and medium priority', () => {
  const update = mapEventToUpdate({
    type: 'todo',
    items: [
      { id: 'todo-1', subject: 'explore', status: 'completed' },
      { id: 'todo-2', subject: 'implement', status: 'in_progress' },
      { id: 'todo-3', subject: 'test', status: 'pending' },
    ],
  });
  assert.deepEqual(update, {
    sessionUpdate: 'plan',
    entries: [
      { content: 'explore', priority: 'medium', status: 'completed' },
      { content: 'implement', priority: 'medium', status: 'in_progress' },
      { content: 'test', priority: 'medium', status: 'pending' },
    ],
  });
});

test('tool kind table: known tools map by name, unknown tools fall back to risk', () => {
  const cases: Array<[string, string]> = [
    ['run_shell', 'execute'],
    ['bg_shell', 'execute'],
    ['read_file', 'read'],
    ['view_image', 'read'],
    ['glob', 'search'],
    ['grep', 'search'],
    ['web_fetch', 'search'],
    ['web_search', 'search'],
    ['tool_search', 'search'],
    ['write_file', 'edit'],
    ['edit_file', 'edit'],
    ['multi_edit', 'edit'],
    ['apply_patch', 'edit'],
  ];
  for (const [name, kind] of cases) assert.equal(toolKindFor(call(name)), kind, name);
  // Unknown tool: risk decides; no risk at all → other.
  assert.equal(toolKindFor(call('mystery'), 'exec'), 'execute');
  assert.equal(toolKindFor(call('mystery'), 'network'), 'other');
  assert.equal(toolKindFor(call('mystery')), 'other');
});

test('riskKind covers all four risk classes', () => {
  assert.equal(riskKind('read'), 'read');
  assert.equal(riskKind('write'), 'edit');
  assert.equal(riskKind('exec'), 'execute');
  assert.equal(riskKind('network'), 'other');
});

test('toolCallTitle: plain name, sub-agent prefixed', () => {
  assert.equal(toolCallTitle(call('grep')), 'grep');
  assert.equal(toolCallTitle(call('grep'), 'bg-1'), '[subagent bg-1] grep');
});

test('unmapped events return null — no accidental editor traffic', () => {
  const unmapped: LoopEvent[] = [
    { type: 'mode', mode: 'thinking' },
    { type: 'user', text: 'hi' },
    { type: 'reasoning_done', text: 'r' },
    { type: 'assistant_done', text: 'a' }, // already streamed as text deltas — never re-emit
    { type: 'usage', inputTokens: 1, outputTokens: 1, costUSD: 0, contextPct: 1 },
    { type: 'latency', ms: 5 },
    { type: 'compaction', trigger: 'auto' },
    { type: 'autonomy', level: 'auto-edit' },
    { type: 'retry', attempt: 1, delayMs: 1, reason: 'x' },
    { type: 'debug', code: 'x', message: 'y' },
    { type: 'stop', reason: 'end_turn', finalAnswer: '' },
    { type: 'shell_output', callId: 'c', stream: 'stdout', chunk: 'out' },
    { type: 'shell_pid', pid: 1, warn: null },
    { type: 'model_fallback', from: 'a', to: 'b', reason: 'r' },
    { type: 'plan_mode', plan: { mode: 'planning' } },
    { type: 'task_notification', taskId: 't', answer: 'a' },
    { type: 'bg_agent_launched', taskId: 't', prompt: 'p' },
    { type: 'subagent_usage', costUSD: 0 },
    { type: 'subagent_start', taskId: 't', subagentType: 'x' },
    { type: 'subagent_end', taskId: 't', ok: true },
    { type: 'cancel_subagent', taskId: 't' },
  ];
  for (const e of unmapped) assert.equal(mapEventToUpdate(e), null, e.type);
});
