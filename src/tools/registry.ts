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

  /**
   * Case-insensitive substring search over deferred tool names AND their `searchAliases`.
   *
   * Matching the name alone was a discoverability trap: a security tool called `bin_recon` could
   * only be found by already knowing the word "recon", so "malware", "binary", "macho" and
   * "disassemble" all returned nothing and the tool was unreachable to a model that did not
   * already know its name. Aliases make intent→tool lookup work.
   *
   * A multi-word query must match every word (each word may hit the name or an alias), so
   * "patch binary" still narrows rather than widening to everything.
   *
   * Two guards keep the alias lists honest, because a bare substring test over short strings is
   * how search goes vague:
   *
   *  1. A query of 1–2 characters must match a whole WORD, not a substring. Otherwise "pe"
   *     matches `patch_bytes`, `target_snapshot` and `engagement_ops` (via "phase"/"pentest")
   *     and returns most of the toolkit — useless as a lookup.
   *  2. A word that is only a PREFIX of a longer alias must be at least 4 characters. This
   *     stops "rat" from matching "restore"/"integrate" while still letting "recon" match
   *     "reconnaissance".
   */
  searchDeferred(query: string): Tool[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return this.listDeferred().filter((t) => {
      const tokens = [t.name.toLowerCase(), ...(t.searchAliases ?? []).map((a) => a.toLowerCase())]
        .flatMap((s) => s.split(/[^a-z0-9]+/))
        .filter(Boolean);
      return words.every((w) => {
        if (w.length <= 2) return tokens.includes(w);
        if (w.length < 4) return tokens.some((tok) => tok === w || tok.startsWith(w));
        return tokens.some((tok) => tok.includes(w));
      });
    });
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
