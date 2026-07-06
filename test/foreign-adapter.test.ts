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