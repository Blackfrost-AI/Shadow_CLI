import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Tool } from './types.js';
import { ok } from './types.js';

const inputSchema = z.object({
  query: z.string().min(1).describe('Substring to match against deferred tool names.'),
});

export function makeToolSearch(registry: ToolRegistry): Tool<z.infer<typeof inputSchema>, { tools: string[] }> {
  return {
    name: 'tool_search',
    description:
      'Search deferred (not yet loaded) tools by name. Returns matching tool names so you can ' +
      'discover optional capabilities without bloating the active tool list.',
    risk: 'read',
    inputSchema,
    async run(input, _ctx) {
      const q = input.query.toLowerCase();
      const tools = registry
        .listDeferred()
        .map((t) => t.name)
        .filter((n) => n.includes(q) || q.split(/\s+/).every((w) => n.includes(w)));
      return ok('tool_search', 'read', 0, tools.length ? `Found: ${tools.join(', ')}` : 'No matching tools.', {
        tools,
      });
    },
  };
}