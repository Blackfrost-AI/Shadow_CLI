import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok } from './types.js';
import type { TodoList, TodoStatus } from '../agent/todo.js';

// The `todo_write` tool: the agent maintains a structured checklist of the work
// it is doing. Whole-list-replace semantics (the simplest contract for a weak
// model — it resends its full current list each call, no incremental update
// logic to get wrong). The loop renders the live list into the system prompt
// every turn (see agent/todo.ts + loop.ts), so the model always sees its plan
// pinned in front of it.
//
// Risk tier 'read': this mutates only session state (the in-memory TodoList),
// never the workspace, so it is auto-approved at every autonomy level except
// 'manual' (where the user opted into confirming everything). It is NOT a file
// write — gating it like `write_file` would wrongly prompt the user mid-task.

const todoItemSchema = z.object({
  subject: z.string().min(1).describe('Short imperative title for the task, e.g. "Fix the failing login test".'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe(
      "'pending' = not started, 'in_progress' = the one item you are working on now, 'completed' = done and verified.",
    ),
  description: z
    .string()
    .optional()
    .describe('Optional one-line detail — what this step involves or how you will verify it.'),
});

const inputSchema = z.object({
  todos: z
    .preprocess(
      // Weak models sometimes send the list as a JSON STRING instead of a real array — parse it so the
      // call succeeds instead of failing "Expected array, received string". A non-JSON string falls
      // through unchanged so zod still reports a clear error.
      (v) => {
        if (typeof v !== 'string') return v;
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      },
      z.array(todoItemSchema),
    )
    .describe(
      'The FULL task list in order, replacing the previous list. Mark the one item you are actively working on in_progress; check items off as you complete and verify them. Use this for any task with 3+ steps.',
    ),
});

type TodoInput = z.infer<typeof inputSchema>;

export interface TodoData {
  todos: ReturnType<TodoList['snapshot']>;
}

/** Build the `todo_write` tool bound to a session-scoped {@link TodoList}. */
export function makeTodoTool(todos: TodoList): Tool<TodoInput, TodoData> {
  return {
    name: 'todo_write',
    description:
      'Maintain a structured task list for the current job and check items off as you complete them. ' +
      'Call this at the START of any non-trivial task (3+ steps) to write your plan, set the first item in_progress, ' +
      'and update the list as you go: mark an item completed when done, then set the next one in_progress. ' +
      'This is whole-list-replace — resend your full current list every call, in order. ' +
      'The list stays pinned in your system prompt EVERY turn (see Task list section) AND displayed live in the TUI green "Task list" panel (with ✓ > marks, subjects + descriptions). ' +
      'Never use it for single trivial actions. The harness and TUI keep it visible to you and the user.',
    risk: 'read',
    inputSchema,
    async run(input, _ctx): Promise<ToolResult<TodoData>> {
      const start = Date.now();
      const items = todos.write(
        input.todos.map((t) => ({
          subject: t.subject,
          status: t.status as TodoStatus,
          description: t.description,
        })),
      );
      const done = items.filter((i) => i.status === 'completed').length;
      const active = items.find((i) => i.status === 'in_progress');
      const head = active
        ? `List updated (${items.length} items, ${done} done). Now working on: "${active.subject}".`
        : `List updated (${items.length} items, ${done} done).`;
      return ok('todo_write', 'read', Date.now() - start, head, { todos: items });
    },
  };
}
