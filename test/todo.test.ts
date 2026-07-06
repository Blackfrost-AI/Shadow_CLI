import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import type { Tool, ToolContext } from '../src/tools/types.js';
import { makeTodoTool } from '../src/tools/todo.js';
import { TodoList, type TodoItem } from '../src/agent/todo.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AutoApproveGate } from '../src/agent/approval.js';

function buildTodoLoop(
  provider: Provider,
  tools: Tool[],
  gate: import('../src/agent/approval.js').ApprovalGate,
  opts: {
    maxIterations?: number;
    signal?: AbortSignal;
    task?: string;
    system?: string;
    autonomy?: import('../src/safety/permissions.js').AutonomyLevel;
    todoList?: TodoList;
  } = {},
): { loop: AgentLoop; events: LoopEvent[] } {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const budget = new Budget(
    { maxIterations: opts.maxIterations ?? 25 },
    'mock',
    { mock: { input: 1, output: 1 } },
    Date.now(),
  );
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: opts.task ?? 'do the thing' }] });
  const deps: LoopDeps = {
    provider,
    registry,
    gate,
    bus,
    budget,
    context,
    signal: opts.signal ?? new AbortController().signal,
    model: 'mock',
    system: opts.system ?? 'base',
    maxOutputTokens: 1024,
    workspaceRoot: process.cwd(),
    dryRun: false,
    maxToolResultChars: 16_384,
    contextBudget: 1_000_000,
    todoList: opts.todoList,
  };
  return { loop: new AgentLoop(deps, opts.autonomy ?? 'full'), events };
}

type SnapshotItem = {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  description?: string;
};

function snapshot(items: readonly TodoItem[]): SnapshotItem[] {
  return items.map((it) => ({ id: it.id, subject: it.subject, status: it.status, description: it.description ?? undefined }));
}

function makeEventProvider(events: ProviderEvent[][]): Provider & { getSystems(): string[] } {
  const queue = [...events];
  const systems: string[] = [];
  return {
    name: 'evented',
    async *send(req) {
      systems.push(req.system);
      for (const ev of queue.shift() ?? [{ type: 'done', stopReason: 'end_turn' }]) yield ev;
    },
    estimateTokens() {
      return 1;
    },
    getSystems() {
      return [...systems];
    },
  };
}

test('todo_write round-trip preserves items and renders a task block', async () => {
  const todos = new TodoList();
  const tool = makeTodoTool(todos);
  const result = await tool.run({ todos: [{ subject: 'A', status: 'pending' }, { subject: 'B', status: 'completed' }] } as never, {} as ToolContext);

  assert.equal(result.ok, true);
  assert.deepEqual(snapshot(result.data?.todos ?? []), [
    { id: 'todo-1', subject: 'A', status: 'pending', description: undefined },
    { id: 'todo-2', subject: 'B', status: 'completed', description: undefined },
  ]);
  assert.equal(todos.block(), '\n\n## Task list\n1. [pending] A\n2. [done] B');
});

test('loop pins todo_write output into the next system prompt', async () => {
  const todos = new TodoList();
  const provider = makeEventProvider([
    [{ type: 'tool_call', call: { id: 'todo', name: 'todo_write', input: { todos: [{ subject: 'A', status: 'pending' }, { subject: 'B', status: 'completed' }] } } }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', delta: 'done.' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const { loop } = buildTodoLoop(provider, [makeTodoTool(todos)], new AutoApproveGate(), { maxIterations: 3, todoList: todos });
  await loop.run();
  assert.match(provider.getSystems()[1] ?? '', /## Task list/);
});

test('summarization does not remove the todo block from system prompt', async () => {
  const todos = new TodoList();
  const provider = makeEventProvider([
    [{ type: 'tool_call', call: { id: 'todo', name: 'todo_write', input: { todos: [{ subject: 'write tests', status: 'in_progress' }] } } }, { type: 'done', stopReason: 'tool_use' }],
    [{ type: 'text', delta: 'summary note ' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  const { loop } = buildTodoLoop(provider, [makeTodoTool(todos)], new AutoApproveGate(), { maxIterations: 3, todoList: todos });
  await loop.run();
  assert.match(provider.getSystems()[1] ?? '', /## Task list\n1\. \[in-progress\] write tests/);
});

test('todo_write emits a bus event with the current items', async () => {
  const todos = new TodoList();
  const events: LoopEvent[] = [];
  todos.onUpdate((items) => events.push({ type: 'todo', items }));
  const tool = makeTodoTool(todos);
  const result = await tool.run({ todos: [{ subject: 'A', status: 'completed' }] } as never, {} as ToolContext);

  assert.equal(result.ok, true);
  const todoEvents = events.filter((e): e is Extract<LoopEvent, { type: 'todo' }> => e.type === 'todo');
  assert.deepEqual(
    todoEvents.map((e) => e.items.map((it) => ({ id: it.id, subject: it.subject, status: it.status }))),
    [[{ id: 'todo-1', subject: 'A', status: 'completed' }]],
  );
});
