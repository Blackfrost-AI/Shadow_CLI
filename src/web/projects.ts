import { homedir } from 'node:os';
import { resolve, parse, join, basename } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { contains } from '../safety/workspaceJail.js';
import { GLOBAL_DIR, loadGlobalConfig, saveGlobalConfig } from '../state/globalStore.js';
import type { JailCapability } from './registry.js';

/**
 * The web console's project allowlist. A browser session may only be created — and its filesystem
 * jail rooted — in a directory added here on purpose. The list lives in the GLOBAL config.json
 * (`projects`, which is in PROJECT_UNTRUSTED_KEYS so a cloned repo cannot widen it).
 *
 * Two comparisons, deliberately different (do not "clean up" into one):
 *  - the DENY gauntlet compares case-insensitively on darwin/win32, because realpath does not
 *    canonicalize case and a deny check that missed `/users/x` (vs `/Users/x`) would fail OPEN;
 *  - the ALLOW check (resolveJail) stays case-sensitive, where a case mismatch merely fails CLOSED.
 */

export interface ProjectEntry {
  id: string;
  path: string;
  label: string;
  addedAt: string;
}

const CASE_FOLD = process.platform === 'darwin' || process.platform === 'win32';
const fold = (p: string): string => (CASE_FOLD ? p.toLowerCase() : p);
/** Case-insensitive-on-darwin containment, DENY-side only. `contains` is exported from workspaceJail. */
const denyContains = (root: string, target: string): boolean => contains(fold(root), fold(target));
const denyEq = (a: string, b: string): boolean => fold(a) === fold(b);

/** existsSync ? realpathSync : resolve — applied to BOTH sides of every comparison. Tilde is
 *  expanded here so config.json only ever holds absolute paths. */
export function normalizeProjectPath(raw: string): string {
  if (typeof raw !== 'string') throw new Error('path must be a string');
  if (raw.includes('\0')) throw new Error('path must not contain a NUL byte');
  let p = raw.trim();
  if (p === '') throw new Error('path must not be empty');
  // Copy local/garage.ts's exact tilde form, NOT gguf.ts's bare startsWith('~') (which mangles a
  // directory literally named ~foo).
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  const abs = resolve(p);
  return existsSync(abs) ? realpathSync(abs) : abs;
}

/** realpath-if-exists-else-resolve, WITHOUT tilde expansion — for normalizing the deny targets so
 *  both sides of a comparison are canonical (e.g. macOS /var → /private/var). Same shape as
 *  normalizeProjectPath, minus the ~ handling the fixed targets never need. */
const real = (p: string): string => (existsSync(p) ? realpathSync(p) : resolve(p));

/** The directories that are never allowlistable as themselves or any descendant. */
const SENSITIVE = [
  join(homedir(), '.ssh'),
  join(homedir(), '.aws'),
  join(homedir(), '.gnupg'),
  join(homedir(), '.config'),
  join(homedir(), '.kube'),
  join(homedir(), 'Library', 'Keychains'),
];

/** Throws with a human-readable reason if `normalized` cannot be an allowlist entry. `normalized`
 *  is already realpath'd (see normalizeProjectPath); every deny target is realpath'd here too, so
 *  the comparison is canonical-vs-canonical on both sides. */
export function assertProjectAddable(normalized: string): void {
  const home = real(homedir());
  const fsRoot = parse(normalized).root;

  // 1. the filesystem root (matches index.ts:846's own parse(p).root idiom).
  if (denyEq(normalized, fsRoot)) throw new Error('refusing to allowlist the filesystem root');
  // 2. $HOME exactly.
  if (denyEq(normalized, home)) throw new Error('refusing to allowlist your home directory');
  // 3. any ANCESTOR of $HOME (contains it) — rejects /Users, which is strictly worse than $HOME.
  if (denyContains(normalized, home)) throw new Error('refusing to allowlist a parent of your home directory');
  // 4. ~/.shadow (credentials.json + the vault) — as self, ancestor, or descendant. The file-tool
  //    jail has NO deny for it, so an allowlist entry of $HOME would make ~/.shadow readable.
  const shadowDir = real(GLOBAL_DIR);
  if (denyContains(normalized, shadowDir) || denyContains(shadowDir, normalized)) {
    throw new Error('refusing to allowlist ~/.shadow (holds credentials and the vault)');
  }
  // 5. enumerated sensitive dirs, as themselves or any descendant. NOT redundant with rule 3:
  //    rule 3 rejects ANCESTORS of $HOME; ~/.ssh is a DESCENDANT, which rule 3 never catches.
  for (const s of SENSITIVE) {
    if (denyContains(real(s), normalized)) throw new Error(`refusing to allowlist a sensitive directory (${s})`);
  }
  // 6. must already exist and be a directory. Refuse to CREATE it — a POST is not a write primitive
  //    on an unvalidated path.
  if (!existsSync(normalized)) throw new Error('path does not exist (allowlisting will not create it)');
  if (!statSync(normalized).isDirectory()) throw new Error('path is not a directory');
}

export function listProjects(): ProjectEntry[] {
  const raw = loadGlobalConfig().projects;
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Partial<ProjectEntry>>)
    .filter((e): e is Partial<ProjectEntry> => Boolean(e) && typeof e.path === 'string')
    .map((e) => ({
      id: typeof e.id === 'string' ? e.id : randomBytes(6).toString('hex'),
      path: e.path as string,
      label: typeof e.label === 'string' ? e.label : basename(e.path as string),
      addedAt: typeof e.addedAt === 'string' ? e.addedAt : '',
    }));
}

/** Normalizes, runs the deny gauntlet, read-modify-writes the whole array. Throws on refusal. */
export function addProject(rawPath: string, label?: string): ProjectEntry {
  const normalized = normalizeProjectPath(rawPath);
  assertProjectAddable(normalized);
  const entries = listProjects();
  // Idempotent (case-sensitive identity, the allow side): re-adding a path returns the existing entry.
  const existing = entries.find((e) => normalizeProjectPath(e.path) === normalized);
  if (existing) return existing;
  const entry: ProjectEntry = {
    id: randomBytes(6).toString('hex'),
    path: normalized,
    label: label && label.trim() ? label.trim() : basename(normalized),
    addedAt: nowIso(),
  };
  saveGlobalConfig({ projects: [...entries, entry] });
  return entry;
}

export function removeProject(id: string): boolean {
  const entries = listProjects();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  saveGlobalConfig({ projects: next });
  return true;
}

/**
 * THE ENFORCEMENT PRIMITIVE. Re-reads config from disk on EVERY call and returns the frozen jail.
 * Throws if `projectRoot` is not a currently-allowlisted project. Called immediately before the
 * turn's buildLoopDeps (C6), never once at session-create — else a DELETE in between leaves a
 * session building against a revoked root (TOCTOU).
 */
export function resolveJail(projectRoot: string): JailCapability {
  const norm = normalizeProjectPath(projectRoot);
  const match = listProjects().find((e) => normalizeProjectPath(e.path) === norm);
  if (!match) throw new Error(`"${projectRoot}" is not an allowlisted project`);
  // Pin the realpath'd root at build time: resolveWithin re-realpaths on every call but never
  // re-consults the allowlist, and /private/tmp is world-writable — `mv work w2 && ln -s / work`
  // would silently re-point an unpinned jail.
  const pinned = existsSync(norm) ? realpathSync(norm) : norm;
  return Object.freeze({ workspaceRoot: pinned, additionalRoots: Object.freeze([]) as readonly string[] });
}

function nowIso(): string {
  return new Date().toISOString();
}
