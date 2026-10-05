// src/app/autocomplete.ts — the composer's completion provider.
//
// Three sources, resolved in order:
//   1. `@`-prefixed  → fuzzy file/directory search over the workspace (the feature Shadow was
//                      missing entirely: there was no way to reference a file by name).
//   2. `/`-prefixed  → fuzzy slash-command names.
//   3. `/cmd <arg>`  → that command's argument completions, which for /model, /resume, /theme,
//                      /add-dir and friends are a function of live session state.
//
// The file index is built lazily and cached, because walking a large workspace on every keystroke
// would make the composer stutter. Completions are served from the cache and the cache is
// refreshed at most once every few seconds.

import { readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from '@earendil-works/pi-tui';

import { fuzzyRank } from '../util/fuzzy.js';
import { approvalText } from '../util/approvalText.js';

function displayItems(items: AutocompleteItem[]): AutocompleteItem[] {
  return items.map((item) => ({ ...item, label: approvalText(item.label ?? item.value),
    description: item.description === undefined ? undefined : approvalText(item.description) }));
}

/** Directories never worth completing into: noise, or huge, or both. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  'coverage',
  '.turbo',
  '.parcel-cache',
  'vendor',
]);

const MAX_FILES = 20000;
const MAX_DEPTH = 8;
const INDEX_TTL_MS = 4000;

/**
 * A flat, cached index of workspace-relative file paths. One walk, then fuzzy-ranked in memory —
 * the same shape the reference client uses (fd-backed there; a bounded readdir walk here, which
 * keeps Shadow dependency-free).
 *
 * The walk is ASYNC and yields between directories. It used to be a synchronous readdirSync
 * recursion over up to 20,000 files, which blocked the event loop for the whole walk — the first
 * `@` on a large repo froze the composer mid-keystroke for hundreds of milliseconds. Concurrent
 * callers share one in-flight build; a superseded build (root changed) is discarded on landing.
 */
class WorkspaceIndex {
  private files: string[] = [];
  private builtAt = 0;
  private building: Promise<string[]> | null = null;
  private generation = 0;

  constructor(private root: string) {}

  setRoot(root: string): void {
    if (root === this.root) return;
    this.root = root;
    this.generation++; // abandon any in-flight walk for the old root
    this.files = [];
    this.builtAt = 0;
  }

  /** Start the background build now so the first `@` usually hits a warm cache. */
  warm(): void {
    void this.get();
  }

  /** Paths matching `query`, best first. Directories come back with a trailing separator. */
  async search(query: string, limit: number): Promise<string[]> {
    const files = await this.get();
    if (!files.length) return [];
    if (!query) {
      // Empty query: show the shallowest entries so `@` alone is still useful.
      return files.slice(0, limit);
    }
    return fuzzyRank(files, query, (f) => f)
      .slice(0, limit)
      .map((s) => s.item);
  }

  private get(): Promise<string[]> {
    if (Date.now() - this.builtAt < INDEX_TTL_MS && this.files.length) {
      return Promise.resolve(this.files);
    }
    if (this.building) return this.building;
    const gen = ++this.generation;
    this.building = this.walk(gen).then((files) => {
      this.building = null;
      if (gen !== this.generation) return this.files; // superseded by a root change
      this.files = files;
      this.builtAt = Date.now();
      return files;
    }).catch(() => {
      // A permission denied or a vanished directory mid-walk just truncates the index.
      this.building = null;
      return this.files;
    });
    return this.building;
  }

  private async walk(gen: number): Promise<string[]> {
    const out: string[] = [];
    // Breadth-first so the shallow entries (the ones an empty `@` shows first) land earliest.
    const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: this.root, rel: '', depth: 0 }];
    while (queue.length > 0) {
      if (gen !== this.generation) return out;
      if (out.length >= MAX_FILES) break;
      const { abs, rel, depth } = queue.shift()!;
      if (depth > MAX_DEPTH) continue;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (out.length >= MAX_FILES) break;
        const name = e.name;
        // Dot files/dirs stay out — including `.env`: completion actively surfacing a secrets
        // file invites the model (and shoulder-surfers) toward it. `.gitignore` is the one
        // harmless exception users genuinely reference.
        if (name.startsWith('.') && name !== '.gitignore') continue;
        const childRel = rel ? `${rel}/${name}` : name;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(name)) continue;
          out.push(`${childRel}/`);
          queue.push({ abs: join(abs, name), rel: childRel, depth: depth + 1 });
        } else if (e.isFile()) {
          out.push(childRel);
        }
      }
      // Yield between directories so input handling and streaming never wait on the walk.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Deterministic order so an empty query is stable rather than filesystem-dependent.
    out.sort();
    return out;
  }
}

export interface SlashCommandSpec {
  name: string;
  desc: string;
  /** Optional live argument completion. */
  args?: (prefix: string) => AutocompleteItem[];
}

/** Absolute → workspace-relative, POSIX separators, or null when outside the workspace. */
function toWorkspaceRel(root: string, abs: string): string | null {
  if (!abs.startsWith(root)) return null;
  return relative(root, abs).split(sep).join('/');
}

export class ShadowAutocompleteProvider implements AutocompleteProvider {
  /** `@` opens file completion; pi-tui also fires on `/` for commands. */
  triggerCharacters = ['@'];

  private index: WorkspaceIndex;

  constructor(
    private commands: SlashCommandSpec[],
    workspaceRoot: string,
  ) {
    this.index = new WorkspaceIndex(workspaceRoot);
  }

  setWorkspaceRoot(root: string): void {
    this.index.setRoot(root);
  }

  /** Warm the file index in the background so the first `@` is instant. */
  warm(): void {
    this.index.warm();
  }

  /** Add a path to history-style completion without a walk (a /add-dir grant). */
  static isPathLike(token: string): boolean {
    return /[./]/.test(token) || token.endsWith('/');
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    _options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? '';
    const before = line.slice(0, cursorCol);

    // ── 1. @file mention ──
    // Matches a bare `@` or a partial path after it. Deliberately not anchored to line start:
    // "look at @src/tui/w" should complete.
    const at = /(^|[\s(])@([^\s@]*)$/.exec(before);
    if (at) {
      const query = at[2] ?? '';
      const items = (await this.index.search(query, 20)).map<AutocompleteItem>((p) => ({
        value: `@${p}`,
        label: p.endsWith('/') ? `📁 ${p}` : p,
        description: p.endsWith('/') ? 'directory' : undefined,
      }));
      if (!items.length) return null;
      return { items: displayItems(items), prefix: `@${query}` };
    }

    // ── 2. /command name (no space yet) ──
    const slashOnly = /^\/([^\s]*)$/.exec(before);
    if (slashOnly) {
      const q = slashOnly[1] ?? '';
      const ranked = q
        ? fuzzyRank(this.commands, q, (c) => c.name.slice(1))
        : this.commands.map((c) => ({ item: c, score: 0 }));
      const items = ranked.slice(0, 12).map<AutocompleteItem>((s) => ({
        value: s.item.name,
        label: s.item.name,
        description: s.item.desc,
      }));
      if (!items.length) return null;
      return { items: displayItems(items), prefix: `/${q}` };
    }

    // ── 3. /command <argument> ──
    const withArg = /^\/(\S+)\s+(.*)$/.exec(before);
    if (withArg) {
      const name = `/${withArg[1]}`;
      const argPrefix = withArg[2] ?? '';
      const cmd = this.commands.find((c) => c.name === name);
      if (cmd?.args) {
        const items = cmd.args(argPrefix);
        if (items.length) return { items: displayItems(items), prefix: argPrefix };
      }
      return null;
    }

    // ── 4. bare path (no @) ──
    // A token that already looks like a path completes without the @ sigil, so typing
    // `src/tui/fl` works the way it does in a shell.
    const pathTok = /(^|[\s(])([./][^\s]*)$/.exec(before);
    if (pathTok) {
      const query = pathTok[2] ?? '';
      if (query.length >= 2) {
        const items = (await this.index.search(query.replace(/^\.\//, ''), 20)).map<AutocompleteItem>((p) => ({
          value: p,
          label: p.endsWith('/') ? `📁 ${p}` : p,
        }));
        if (items.length) return { items: displayItems(items), prefix: query };
      }
    }

    return null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? '';
    const before = line.slice(0, cursorCol);
    const after = line.slice(cursorCol);
    // Replace exactly the prefix we reported, so the completion lands where the user is typing.
    const start = Math.max(0, before.length - prefix.length);
    const next = before.slice(0, start) + item.value + after;
    const nextLines = lines.slice();
    nextLines[cursorLine] = next;
    return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
    return /(^|[\s(])@[^\s@]*$/.test(before) || ShadowAutocompleteProvider.isPathLike(before.split(/\s+/).pop() ?? '');
  }
}

/** Existence check used by the composer to warn on a referenced path that isn't there. */
export function pathExists(root: string, rel: string): boolean {
  try {
    statSync(join(root, rel));
    return true;
  } catch {
    return false;
  }
}

export { toWorkspaceRel };
