import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../tools/util.js';

// Project memory: a flat string→string KV of durable facts about the workspace
// (build/test commands, key file locations, conventions). Backed by
// <workspaceRoot>/.shadow/memory.json so it survives restarts. Every mutation
// persists atomically (temp file + rename) — a reader never sees a half-written
// file. `asContext` renders the facts for injection into the system prompt at
// startup, so the model recalls them without being re-told each session.

const MEMORY_FILE = join('.shadow', 'memory.json');

/** F08-05: soft cap on index lines in the system prompt. */
export const MEMORY_INDEX_CAP = 40;
/** F08-05: per-fact value cap in the index — enough to recognize the fact, recall fetches the rest. */
const MEMORY_INDEX_VALUE_CHARS = 100;
/** Fact-key cap — bounds both the stored key and its rendered line (a 5k-char key would ride
 *  into every request's index forever; line-count caps alone never see it). */
export const MEMORY_KEY_MAX = 200;

/**
 * Flatten whitespace AND control characters to single spaces. `\s` alone misses U+0085 (NEL)
 * and the C0/C1 control blocks — an ESC sequence or NEL in a fact must not survive into the
 * system prompt (line-break spoofing / terminal mangling), so both values AND keys render
 * through this.
 */
function flatten(s: string): string {
  return s.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/** Truncate at `max` chars without ever splitting a surrogate pair (no lone half in the prompt). */
function capPairSafe(flat: string, max: number): string {
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // trailing high surrogate — drop it
  return cut;
}

/** Flatten a fact value to one truncated line for the index. */
function oneLine(value: string): string {
  const flat = flatten(value);
  return flat.length > MEMORY_INDEX_VALUE_CHARS ? `${capPairSafe(flat, MEMORY_INDEX_VALUE_CHARS)}…` : flat;
}

/** One-line rendering of a KEY — keys are USER/MODEL data (they can carry '\n', '## ', ESC). */
function keyLabel(key: string): string {
  const flat = flatten(key);
  return flat.length > MEMORY_KEY_MAX ? `${capPairSafe(flat, MEMORY_KEY_MAX)}…` : flat;
}

/** Own-property assignment that also works for `__proto__` (plain `=` would hit the prototype
 *  setter and silently drop the fact). */
function setFact(facts: Record<string, string>, key: string, value: string): void {
  if (key === '__proto__') {
    Object.defineProperty(facts, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    facts[key] = value;
  }
}

export class ProjectMemory {
  private constructor(
    private readonly filePath: string,
    private readonly facts: Record<string, string>,
  ) {}

  /** Load from disk, tolerating a missing or corrupt file (→ empty store). */
  static load(workspaceRoot: string): ProjectMemory {
    const filePath = join(workspaceRoot, MEMORY_FILE);
    const facts: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          // JSON.parse can hand back an OWN __proto__ property — plain assignment would hit
          // the prototype setter and drop the fact (load/set asymmetry).
          if (typeof v === 'string') setFact(facts, k, v);
        }
      }
    } catch {
      // missing or corrupt — start empty
    }
    return new ProjectMemory(filePath, facts);
  }

  get(key: string): string | undefined {
    // Own-property lookup only — without the guard, get('toString')/get('__proto__') would
    // return Object.prototype members (a function / the prototype), not a stored fact.
    if (!Object.prototype.hasOwnProperty.call(this.facts, key)) return undefined;
    return this.facts[key];
  }

  set(key: string, value: string): void {
    // Keys are model/user-controlled and render into every future system prompt: sanitize at
    // WRITE time too (line breaks flattened, length capped) so a hostile key cannot fake new
    // index lines or `## ` sections. The render path sanitizes again for keys that arrive via
    // a hand-edited memory.json.
    const k = capPairSafe(flatten(key), MEMORY_KEY_MAX);
    if (!k) return; // nothing left after sanitizing — refuse rather than store a ghost key
    setFact(this.facts, k, value);
    this.persist();
  }

  delete(key: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(this.facts, key)) return false;
    delete this.facts[key];
    this.persist();
    return true;
  }

  /** A copy of all facts (callers cannot mutate the store through it). */
  all(): Record<string, string> {
    return { ...this.facts };
  }

  /** Render facts as a markdown bullet list for the system prompt, '' if empty. Keys render
   *  through the sanitizer (full values are this renderer's purpose, so they stay intact). */
  asContext(): string {
    const keys = Object.keys(this.facts);
    if (keys.length === 0) return '';
    return keys.map((k) => `- **${keyLabel(k)}**: ${this.facts[k]}`).join('\n');
  }

  /**
   * F08-05: one-line-per-fact INDEX for the system prompt — the model sees WHAT is remembered and
   * fetches full values on demand via the memory tool (recall). Full-value injection grows every
   * request linearly with every fact ever remembered; the index keeps the cost flat while recall
   * stays one tool call away. Soft-capped: beyond `cap` facts an overflow note points at
   * list/recall instead of silently dropping keys. '' if empty.
   */
  asIndex(cap: number = MEMORY_INDEX_CAP): string {
    const keys = Object.keys(this.facts);
    if (keys.length === 0) return '';
    // keyLabel on the KEY too — keys that arrived via a hand-edited memory.json (bypassing
    // set()) may still carry '\n'/ESC and would otherwise forge extra index lines or headings.
    const lines = keys.slice(0, cap).map((k) => `- ${keyLabel(k)}: ${oneLine(this.facts[k]!)}`);
    if (keys.length > cap) {
      lines.push(`… +${keys.length - cap} more — use the memory tool (action: list or recall)`);
    }
    return lines.join('\n');
  }

  private persist(): void {
    atomicWrite(this.filePath, JSON.stringify(this.facts, null, 2) + '\n');
  }
}
