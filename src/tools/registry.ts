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
  private denied = new Set<string>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Remove an exact registered entry when its connector is disabled or replaced. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Apply the immutable capability subtraction selected for this session. Registration remains
   * host-owned, but denied tools disappear from schemas, aliases, deferred search and dispatch.
   * Provider/model/auth configuration is deliberately outside this boundary.
   */
  setDenied(names: Iterable<string>): void {
    this.denied = new Set([...names].map((name) => canonicalToolName(name)));
  }

  isDenied(name: string): boolean {
    return this.denied.has(canonicalToolName(name));
  }

  /** Host-only lookup for wiring wrappers around a compiled tool hidden from model dispatch. */
  getUnscoped(name: string): Tool | undefined {
    return this.tools.get(name) ?? this.tools.get(canonicalToolName(name));
  }

  get(name: string): Tool | undefined {
    // Exact match wins; otherwise map a known foreign name (bash → run_shell, etc.).
    if (this.isDenied(name)) return undefined;
    return this.getUnscoped(name);
  }

  list(opts?: { includeDeferred?: boolean }): Tool[] {
    const all = [...this.tools.values()].filter((tool) => !this.isDenied(tool.name));
    if (opts?.includeDeferred) return all;
    return all.filter((t) => !t.deferred);
  }

  /** Deferred tools (excluded from the default schema). */
  listDeferred(): Tool[] {
    return this.list({ includeDeferred: true }).filter((t) => t.deferred);
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
