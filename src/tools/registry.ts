import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Tool } from './types.js';
import type { ToolSchema } from '../provider/provider.js';
import { canonicalToolName } from './aliases.js';

/**
 * Holds the compiled-in tools and exports their JSON-Schema calling contracts
 * to the provider. Tools are local; there is no remote registry.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    // Exact match wins; otherwise map a known foreign name (bash → run_shell, etc.).
    return this.tools.get(name) ?? this.tools.get(canonicalToolName(name));
  }

  list(opts?: { includeDeferred?: boolean }): Tool[] {
    const all = [...this.tools.values()];
    if (opts?.includeDeferred) return all;
    return all.filter((t) => !t.deferred);
  }

  /** Deferred tools (excluded from the default schema). */
  listDeferred(): Tool[] {
    return [...this.tools.values()].filter((t) => t.deferred);
  }

  /** Case-insensitive substring search over deferred tool names. */
  searchDeferred(query: string): Tool[] {
    const q = query.toLowerCase();
    return this.listDeferred().filter(
      (t) => t.name.includes(q) || q.split(/\s+/).every((w) => t.name.includes(w)),
    );
  }

  /** Export each tool as {name, description, parameters: JSONSchema} for the model. */
  toSchemas(): ToolSchema[] {
    return this.list().map((t) => {
      const json = zodToJsonSchema(t.inputSchema, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      }) as Record<string, unknown>;
      // strip the top-level $schema key; providers want a bare object schema
      delete json.$schema;
      return { name: t.name, description: t.description, parameters: json };
    });
  }
}
