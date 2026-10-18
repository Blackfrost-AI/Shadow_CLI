import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Tool } from './types.js';
import type { ToolSchema } from '../provider/provider.js';
import { canonicalToolName } from './aliases.js';

/**
 * Search tokens for a tool: its name plus every `searchAliases` entry, split on non-word chars.
 * Shared by both matchers so alias handling cannot drift between them.
 */
function tokensFor(t: Tool): string[] {
  return [t.name.toLowerCase(), ...(t.searchAliases ?? []).map((a) => a.toLowerCase())]
    .flatMap((s) => s.split(/[^a-z0-9]+/))
    .filter(Boolean);
}

/**
 * Query tokens. Splits on non-word characters AND underscores so a model that types the canonical
 * name (`sample_run`) matches the same way it would after reading it (`sample run`). Without the
 * underscore split, "sample_run" was one opaque token that matched nothing.
 */
function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Guards that keep a bare substring test over short strings from going vague:
 *  - 1–2 chars must match a whole token, else "pe" hits `patch_bytes`/`target_snapshot`/...
 *  - 3 chars must be a prefix, so "rat" stops matching "restore"/"integrate"
 *  - 4+ chars match as a substring, so "recon" still finds "reconnaissance"
 */
function tokenMatches(tokens: string[], w: string): boolean {
  if (w.length <= 2) return tokens.includes(w);
  if (w.length < 4) return tokens.some((tok) => tok === w || tok.startsWith(w));
  return tokens.some((tok) => tok.includes(w));
}

/**
 * Filler words that carry no intent and would otherwise add score to unrelated tools. Deliberately
 * conservative: words like "run", "tool" and "sample" DO appear in tool names and stay searchable.
 */
const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'in', 'on', 'of', 'for', 'and', 'or', 'is', 'it', 'this', 'that',
  'with', 'from', 'by', 'at', 'as', 'be', 'me', 'my', 'i', 'we', 'you', 'can', 'should',
  'how', 'do', 'does', 'want', 'need', 'please', 'some', 'into', 'then', 'than',
]);

/**
 * Holds the compiled-in tools and exports their JSON-Schema calling contracts
 * to the provider. Tools are local; there is no remote registry.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private denied = new Set<string>();
  /**
   * Deferred tools this session has already been shown via `tool_search`.
   *
   * Deferral exists to keep the default schema small, but discovery was previously a dead end:
   * `tool_search` returned a name and nothing else, the tool never entered `toSchemas()`, and the
   * model had to emit a call for a tool it had never seen a schema for. Live models responded by
   * shelling out to `otool`/`xxd` instead — 15 iterations of improvisation around a tool that was
   * right there. Discovery now promotes: once a tool is found, it is callable with a real schema
   * for the rest of the session.
   */
  private revealed = new Set<string>();

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
    // A revealed tool is no longer hidden: it was already shown to the model, so keeping it out
    // of the schema would force a blind call.
    return all.filter((t) => !t.deferred || this.revealed.has(t.name));
  }

  /** Deferred tools not yet revealed (i.e. currently hidden from the schema). */
  listDeferred(): Tool[] {
    return this.list({ includeDeferred: true }).filter((t) => t.deferred && !this.revealed.has(t.name));
  }

  /**
   * Every deferred tool, revealed or not. Search runs over this pool so a tool stays findable
   * after promotion — otherwise the second search for a tool you already discovered returns
   * nothing and looks like the tool vanished.
   */
  private deferredPool(): Tool[] {
    return this.list({ includeDeferred: true }).filter((t) => t.deferred);
  }

  /**
   * Promote discovered tools into the active schema for the rest of the session.
   *
   * Called by `tool_search` after a match. Promotion is monotonic and idempotent — a revealed tool
   * stays callable, and re-searching is harmless. Denied tools are skipped so search cannot
   * resurrect a capability the session subtracted.
   */
  reveal(names: Iterable<string>): void {
    for (const name of names) {
      const tool = this.getUnscoped(name);
      if (tool?.deferred && !this.isDenied(tool.name)) this.revealed.add(tool.name);
    }
  }

  /** Tools revealed so far this session (for diagnostics and tests). */
  listRevealed(): string[] {
    return [...this.revealed].filter((n) => !this.isDenied(n)).sort();
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
    const words = queryTokens(query);
    if (words.length === 0) return [];
    return this.deferredPool().filter((t) => words.every((w) => tokenMatches(tokensFor(t), w)));
  }

  /**
   * Ranked variant for `tool_search`: matches ANY query word and orders by how many matched.
   *
   * `searchDeferred` requires every word to match, which is right for narrowing but wrong for
   * a model typing a sentence. "detonate sample in sandbox containment" scored zero because
   * "in" and "containment" matched no token — so the one tool that does exactly that reported
   * "No matching tools". Natural-language queries need recall; the rank supplies precision.
   *
   * Filler words are dropped so they cannot contribute score, and a tool must clear at least one
   * meaningful word to appear at all.
   */
  searchDeferredRanked(query: string): Tool[] {
    const words = queryTokens(query).filter((w) => !SEARCH_STOPWORDS.has(w));
    if (words.length === 0) return [];
    const scored = this.deferredPool()
      .map((t) => {
        const tokens = tokensFor(t);
        const score = words.reduce((n, w) => n + (tokenMatches(tokens, w) ? 1 : 0), 0);
        return { t, score };
      })
      .filter((s) => s.score > 0);
    scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
    return scored.map((s) => s.t);
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
