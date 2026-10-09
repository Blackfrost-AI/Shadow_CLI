import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export interface MemoryMetadata {
  author: 'user' | 'generated' | 'legacy';
  scope: 'workspace';
  source?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
}
export interface MemoryEntry extends MemoryMetadata { key: string; value: string }
export type MemoryWriteOptions = Partial<Pick<MemoryMetadata, 'author' | 'source' | 'reviewedAt'>>;

export class ProjectMemory {
  private constructor(
    private readonly filePath: string,
    private readonly facts: Record<string, string>,
    private readonly metadata: Map<string, MemoryMetadata>,
  ) {}

  /** Load from disk, tolerating a missing or corrupt file (→ empty store). */
  static load(workspaceRoot: string): ProjectMemory {
    const filePath = join(workspaceRoot, MEMORY_FILE);
    const facts: Record<string, string> = {};
    const metadata = new Map<string, MemoryMetadata>();
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const envelope = parsed as Record<string, unknown>;
        const versioned = envelope.version === 2 && envelope.entries && typeof envelope.entries === 'object' && !Array.isArray(envelope.entries);
        const entries = versioned ? envelope.entries as Record<string, unknown> : envelope;
        for (const [k, v] of Object.entries(entries)) {
          if (!versioned && typeof v === 'string') {
            setFact(facts, k, v);
            metadata.set(k, { author: 'legacy', scope: 'workspace', createdAt: '', updatedAt: '', source: 'legacy memory.json (origin unknown)' });
          } else if (versioned && v && typeof v === 'object') {
            const entry = v as Record<string, unknown>;
            if (typeof entry.value !== 'string') continue;
            setFact(facts, k, entry.value);
            metadata.set(k, {
              author: entry.author === 'user' || entry.author === 'generated' ? entry.author : 'legacy',
              scope: 'workspace',
              createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
              updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
              ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
              ...(typeof entry.reviewedAt === 'string' ? { reviewedAt: entry.reviewedAt } : {}),
            });
          }
        }
      }
    } catch {
      // missing or corrupt — start empty
    }
    return new ProjectMemory(filePath, facts, metadata);
  }

  /** Slash commands and the model tool may hold separate stores in the same session. */
  private refresh(): void {
    const loaded = ProjectMemory.load(dirname(dirname(this.filePath)));
    for (const key of Object.keys(this.facts)) delete this.facts[key];
    for (const [key, value] of Object.entries(loaded.facts)) setFact(this.facts, key, value);
    this.metadata.clear();
    for (const [key, value] of loaded.metadata) this.metadata.set(key, value);
  }

  get(key: string): string | undefined {
    this.refresh();
    // Own-property lookup only — without the guard, get('toString')/get('__proto__') would
    // return Object.prototype members (a function / the prototype), not a stored fact.
    if (!Object.prototype.hasOwnProperty.call(this.facts, key)) return undefined;
    return this.facts[key];
  }

  set(key: string, value: string, opts: MemoryWriteOptions = {}): void {
    this.refresh();
    // Keys are model/user-controlled and render into every future system prompt: sanitize at
    // WRITE time too (line breaks flattened, length capped) so a hostile key cannot fake new
    // index lines or `## ` sections. The render path sanitizes again for keys that arrive via
    // a hand-edited memory.json.
    const k = capPairSafe(flatten(key), MEMORY_KEY_MAX);
    if (!k) return; // nothing left after sanitizing — refuse rather than store a ghost key
    const previous = this.metadata.get(k);
    const now = new Date().toISOString();
    setFact(this.facts, k, value);
    this.metadata.set(k, {
      author: opts.author ?? 'generated', scope: 'workspace',
      source: opts.source === undefined ? previous?.source : capPairSafe(flatten(opts.source), 500),
      createdAt: previous?.createdAt || now, updatedAt: now,
      ...(opts.reviewedAt ? { reviewedAt: opts.reviewedAt } : {}),
    });
    this.persist();
  }

  delete(key: string): boolean {
    this.refresh();
    if (!Object.prototype.hasOwnProperty.call(this.facts, key)) return false;
    delete this.facts[key];
    this.metadata.delete(key);
    this.persist();
    return true;
  }

  /** Full provenance is available without changing the legacy string-valued read API. */
  inspect(key: string): MemoryEntry | undefined {
    const value = this.get(key);
    const meta = this.metadata.get(key);
    return value === undefined || !meta ? undefined : { key, value, ...meta };
  }

  private entriesSnapshot(): MemoryEntry[] {
    return Object.keys(this.facts).map((key) => ({ key, value: this.facts[key]!, ...this.metadata.get(key)! }));
  }

  entries(): MemoryEntry[] {
    this.refresh();
    return this.entriesSnapshot();
  }

  /** Editing requires an existing key, so a typo cannot silently create a second memory. */
  update(key: string, value: string, opts: MemoryWriteOptions = {}): boolean {
    if (this.get(key) === undefined) return false;
    this.set(key, value, opts);
    return true;
  }

  /** Facts are stale when unreviewed since their last edit, or older than the supplied cutoff. */
  stale(before: string): MemoryEntry[] {
    return this.entries().filter((entry) => !entry.reviewedAt || entry.reviewedAt < entry.updatedAt || entry.reviewedAt < before);
  }

  /** A copy of all facts (callers cannot mutate the store through it). */
  all(): Record<string, string> {
    this.refresh();
    return { ...this.facts };
  }

  /** Render facts as a markdown bullet list for the system prompt, '' if empty. Keys render
   *  through the sanitizer (full values are this renderer's purpose, so they stay intact). */
  asContext(): string {
    this.refresh();
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
    this.refresh();
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
    const entries = Object.fromEntries(this.entriesSnapshot().map(({ key, ...entry }) => [key, entry]));
    atomicWrite(this.filePath, JSON.stringify({ version: 2, entries }, null, 2) + '\n');
  }
}
