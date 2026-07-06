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
          if (typeof v === 'string') facts[k] = v;
        }
      }
    } catch {
      // missing or corrupt — start empty
    }
    return new ProjectMemory(filePath, facts);
  }

  get(key: string): string | undefined {
    return this.facts[key];
  }

  set(key: string, value: string): void {
    this.facts[key] = value;
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

  /** Render facts as a markdown bullet list for the system prompt, '' if empty. */
  asContext(): string {
    const keys = Object.keys(this.facts);
    if (keys.length === 0) return '';
    return keys.map((k) => `- **${k}**: ${this.facts[k]}`).join('\n');
  }

  private persist(): void {
    atomicWrite(this.filePath, JSON.stringify(this.facts, null, 2) + '\n');
  }
}
