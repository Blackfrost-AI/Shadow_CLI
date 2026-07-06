import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import type { ProjectMemory } from '../state/memory.js';

// A tool the agent calls to manage its own project-memory KV
// (<workspaceRoot>/.shadow/memory.json). remember/forget MUTATE that store, and
// stored facts are injected into the system prompt on later sessions — so a
// prompt-injected model could persist instructions into future runs. It therefore
// carries the 'write' risk tier (gated like any other write at auto-read/manual;
// auto-approved at auto-edit/full, same as file writes). recall/list are reads.

const inputSchema = z.object({
  action: z
    .enum(['remember', 'recall', 'forget', 'list'])
    .describe(
      "'remember' stores a fact (needs key + value); 'recall' fetches one (needs key); " +
        "'forget' deletes one (needs key); 'list' returns every stored fact.",
    ),
  key: z
    .string()
    .min(1)
    .optional()
    .describe('Short stable identifier for the fact, e.g. "build_command". Required for remember/recall/forget.'),
  value: z
    .string()
    .optional()
    .describe('The fact to store. Required for remember. Keep it concise and durable; never store secrets.'),
});

type MemoryInput = z.infer<typeof inputSchema>;

export interface MemoryData {
  action: MemoryInput['action'];
  key?: string;
  value?: string;
  found?: boolean;
  deleted?: boolean;
  facts?: Record<string, string>;
}

/** Build the `memory` tool bound to a loaded {@link ProjectMemory} store. */
export function makeMemoryTool(mem: ProjectMemory): Tool<MemoryInput, MemoryData> {
  return {
    name: 'memory',
    description:
      'Read and write durable, workspace-level facts that should survive across tasks and restarts. ' +
      'Remember things future-you needs — the build command, the test command, where key modules live, ' +
      'project conventions — and recall them later instead of re-discovering them. ' +
      'Actions: remember (key+value), recall (key), forget (key), list. ' +
      'This stores facts in Shadow’s own memory, not the workspace files. Never store secrets or passwords.',
    risk: 'write', // remember/forget mutate the store + feed future system prompts — gate as a write
    inputSchema,
    async run(input, _ctx): Promise<ToolResult<MemoryData>> {
      const start = Date.now();
      switch (input.action) {
        case 'remember': {
          if (!input.key || input.value === undefined) {
            return fail('memory', 'read', Date.now() - start, 'bad_input', "remember requires both 'key' and 'value'.");
          }
          mem.set(input.key, input.value);
          return ok('memory', 'read', Date.now() - start, `Remembered "${input.key}".`, {
            action: 'remember',
            key: input.key,
            value: input.value,
          });
        }
        case 'recall': {
          if (!input.key) {
            return fail('memory', 'read', Date.now() - start, 'bad_input', "recall requires 'key'.");
          }
          const value = mem.get(input.key);
          return ok(
            'memory',
            'read',
            Date.now() - start,
            value === undefined ? `No fact stored under "${input.key}".` : `Recalled "${input.key}".`,
            { action: 'recall', key: input.key, value, found: value !== undefined },
          );
        }
        case 'forget': {
          if (!input.key) {
            return fail('memory', 'read', Date.now() - start, 'bad_input', "forget requires 'key'.");
          }
          const deleted = mem.delete(input.key);
          return ok(
            'memory',
            'read',
            Date.now() - start,
            deleted ? `Forgot "${input.key}".` : `Nothing stored under "${input.key}".`,
            { action: 'forget', key: input.key, deleted },
          );
        }
        case 'list': {
          const facts = mem.all();
          const n = Object.keys(facts).length;
          return ok('memory', 'read', Date.now() - start, `${n} fact${n === 1 ? '' : 's'} stored.`, {
            action: 'list',
            facts,
          });
        }
      }
    },
  };
}
