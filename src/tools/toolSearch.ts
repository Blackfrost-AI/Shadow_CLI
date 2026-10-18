import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolRegistry } from './registry.js';
import type { Tool } from './types.js';
import { ok } from './types.js';

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'What you are trying to do, in your own words — e.g. "detonate sample", "patch binary", ' +
        '"snapshot drift". Matched case-insensitively against deferred tool names and their intent ' +
        'aliases.',
    ),
});

/** One discovered tool, with everything needed to call it correctly on the next turn. */
export interface DiscoveredTool {
  name: string;
  description: string;
  risk: string;
  parameters: Record<string, unknown>;
}

/**
 * How many full schemas to return. A search that matches everything is a search that told the
 * model nothing; a short, ranked list with callable schemas is more useful than a long name dump.
 */
const MAX_SCHEMAS = 4;

export function makeToolSearch(
  registry: ToolRegistry,
): Tool<z.infer<typeof inputSchema>, { tools: string[]; schemas: DiscoveredTool[] }> {
  return {
    name: 'tool_search',
    description:
      'Search deferred (not yet loaded) tools by intent. Returns each matching tool with its full ' +
      'argument schema, so you can call it directly on the next turn. Search by what you are trying ' +
      'to accomplish, not by guessing a name.',
    risk: 'read',
    inputSchema,
    async run(input, _ctx) {
      // Ranked ANY-word match with filler words dropped. `searchDeferred` (ALL words) is too
      // strict for a model typing a sentence: "detonate sample in sandbox containment" scored
      // zero on "in"/"containment" and reported "No matching tools" for the one tool that does
      // exactly that. Rank supplies the precision that dropping the AND gives up.
      const matched = registry.searchDeferredRanked(input.query);

      // Rank exact name matches first, then prefix matches, then the rest — the registry already
      // filtered on all query words, so this only decides presentation order.
      const q = input.query.toLowerCase().trim();
      const ranked = [...matched].sort((a, b) => {
        const score = (t: Tool) => {
          const n = t.name.toLowerCase();
          if (n === q) return 0;
          if (n.startsWith(q)) return 1;
          if (n.includes(q)) return 2;
          return 3;
        };
        return score(a) - score(b) || a.name.localeCompare(b.name);
      });

      const schemas: DiscoveredTool[] = ranked.slice(0, MAX_SCHEMAS).map((t) => {
        const json = zodToJsonSchema(t.inputSchema, {
          target: 'jsonSchema7',
          $refStrategy: 'none',
        }) as Record<string, unknown>;
        delete json.$schema;
        return {
          name: t.name,
          description: t.description,
          risk: t.risk,
          parameters: json,
        };
      });

      const tools = ranked.map((t) => t.name);
      // Promotion is the point: without it the model gets a name it cannot construct a call for.
      registry.reveal(tools);
      const summary = tools.length
        ? `Found ${tools.length} tool(s) and loaded them into your active tool list: ` +
          `${tools.join(', ')}. Call them by canonical name — the schemas above are complete.`
        : `No deferred tool matches "${input.query}". Try a single concrete verb or noun ` +
          `(e.g. "detonate", "patch", "snapshot", "findings", "recon").`;

      return ok('tool_search', 'read', 0, summary, { tools, schemas });
    },
  };
}