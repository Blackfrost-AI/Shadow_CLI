import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForeignTool, recoverCommandArrayPatch } from '../src/tools/foreignAdapter.js';

test('normalizeForeignTool maps shell_command + workdir to run_shell', () => {
  const r = normalizeForeignTool({
    name: 'shell_command',
    input: { command: 'ls', working_directory: '/tmp/proj' },
  });
  assert.equal(r.name, 'run_shell');
  assert.match(String((r.input as { command: string }).command), /cd '\/tmp\/proj'/);
  assert.match(String((r.input as { command: string }).command), /ls/);
});

test('normalizeForeignTool maps update_plan to todo_write', () => {
  const r = normalizeForeignTool({
    name: 'update_plan',
    input: {
      plan: [
        { id: '1', content: 'step one', status: 'in_progress' },
        { id: '2', content: 'step two', status: 'pending' },
      ],
    },
  });
  assert.equal(r.name, 'todo_write');
  const todos = (r.input as { todos: Array<{ status: string }> }).todos;
  assert.equal(todos.length, 2);
  assert.equal(todos[0]!.status, 'in_progress');
});

test('recoverCommandArrayPatch extracts apply_patch envelope', () => {
  const patch = '*** Begin Patch\n*** End Patch';
  const r = recoverCommandArrayPatch({ command: ['apply_patch', patch] });
  assert.equal(r, patch);
  const n = normalizeForeignTool({ name: 'codex', input: { command: ['apply_patch', patch] } });
  assert.equal(n.name, 'apply_patch');
  assert.deepEqual(n.input, { patch });
});

test('normalizeForeignTool maps Edit old_str/new_str to edit_file', () => {
  const r = normalizeForeignTool({
    name: 'Edit',
    input: { path: 'a.ts', old_str: 'foo', new_str: 'bar' },
  });
  assert.equal(r.name, 'edit_file');
  assert.deepEqual(r.input, { path: 'a.ts', old_str: 'foo', new_str: 'bar', old_string: 'foo', new_string: 'bar' });
});

// --- P1A-09: shape-map Claude-style TodoWrite calls into the canonical todo_write shape ---

test('P1A-09 maps Claude TodoWrite (content/status) onto todo_write subject/status', () => {
  const r = normalizeForeignTool({
    name: 'TodoWrite',
    input: {
      todos: [
        { content: 'Fix the failing login test', status: 'in_progress' },
        { content: 'Add a regression suite', status: 'pending' },
      ],
    },
  });
  assert.equal(r.name, 'todo_write');
  const todos = (r.input as { todos: Array<Record<string, unknown>> }).todos;
  assert.equal(todos.length, 2);
  assert.equal(todos[0]!.subject, 'Fix the failing login test');
  assert.equal(todos[0]!.status, 'in_progress');
  assert.equal(todos[1]!.subject, 'Add a regression suite');
  assert.equal(todos[1]!.status, 'pending');
});

test('P1A-09 folds Claude activeForm (and does/doing synonyms) onto description/status', () => {
  const r = normalizeForeignTool({
    name: 'TodoWrite',
    input: {
      todos: [
        { content: 'Scaffold the module', status: 'doing', activeForm: 'scaffolding the module' },
        { content: 'Ship it', status: 'completed' },
      ],
    },
  });
  const todos = (r.input as { todos: Array<Record<string, unknown>> }).todos;
  assert.equal(todos[0]!.status, 'in_progress');
  assert.equal(todos[0]!.description, 'scaffolding the module');
  assert.equal(todos[1]!.status, 'completed');
});

test('P1A-09 leaves canonical todo_write (subject-based) args untouched', () => {
  const input = {
    todos: [
      { subject: 'Native item', status: 'pending', description: 'unchanged' },
    ],
  };
  const r = normalizeForeignTool({ name: 'todo_write', input });
  assert.equal(r.name, 'todo_write');
  assert.deepEqual(r.input, input);
});