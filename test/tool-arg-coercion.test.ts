import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from '../src/tools/readFile.js';
import { webFetch } from '../src/tools/webFetch.js';
import { makeTodoTool } from '../src/tools/todo.js';
import { TodoList } from '../src/agent/todo.js';

// Weak local models routinely emit numeric args as strings ("1048576", "5"). The zod input schemas
// now coerce them instead of hard-failing — the exact slip LUMIX-4B hit on web_fetch's max_bytes.

test('read_file coerces numeric-string offset/limit', () => {
  const r = readFile.inputSchema.safeParse({ path: 'x.ts', offset: '5', limit: '20' });
  assert.equal(r.success, true);
  assert.equal(r.success && r.data.offset, 5);
  assert.equal(r.success && r.data.limit, 20);
});

test('web_fetch coerces a numeric-string max_bytes (the LUMIX-4B slip)', () => {
  const r = webFetch.inputSchema.safeParse({ url: 'https://example.com', max_bytes: '1048576' });
  assert.equal(r.success, true);
  assert.equal(r.success && r.data.max_bytes, 1048576);
});

test('coercion still rejects non-numeric / non-positive / non-int junk', () => {
  assert.equal(readFile.inputSchema.safeParse({ path: 'x', offset: 'abc' }).success, false);
  assert.equal(webFetch.inputSchema.safeParse({ url: 'https://x.com', max_bytes: '-5' }).success, false);
  assert.equal(readFile.inputSchema.safeParse({ path: 'x', limit: '2.5' }).success, false); // not an int
});

test('optional numeric args still omit cleanly', () => {
  const r = readFile.inputSchema.safeParse({ path: 'x' });
  assert.equal(r.success, true);
  assert.equal(r.success && r.data.offset, undefined);
});

// todo_write: weak models sometimes send the list as a JSON string (the second slip LUMIX-4B hit).
const todoSchema = makeTodoTool(new TodoList()).inputSchema;

test('todo_write accepts a JSON-string todos array', () => {
  const r = todoSchema.safeParse({ todos: '[{"subject":"do x","status":"pending"}]' });
  assert.equal(r.success, true);
  assert.equal(r.success && r.data.todos[0]!.subject, 'do x');
});

test('todo_write still accepts a real array', () => {
  assert.equal(todoSchema.safeParse({ todos: [{ subject: 'y', status: 'completed' }] }).success, true);
});

test('todo_write rejects a non-JSON string', () => {
  assert.equal(todoSchema.safeParse({ todos: 'not json at all' }).success, false);
});
