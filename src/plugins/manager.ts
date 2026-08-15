// Plugin manager (P3-07) — local-first, auditable, DATA-ONLY.
//
// A plugin is a directory under ~/.shadow/plugins/<name> carrying a strict manifest.json plus
// any of the five DECLARATIVE content surfaces Shadow already loads from disk:
//
//   commands/*.md        → custom slash commands (F10-07 format)
//   output-styles/*.md   → output styles (F08-12 format)
//   skills/<s>/SKILL.md  → skills index entries
//   agents/*.md          → sub-agent definitions
//   workflows/*.md       → workflow runbooks (listed by /workflows)
//
// Trust model (the whole design hangs on this):
//   * Plugins are PURE DATA. They can only contribute markdown to surfaces that already exist,
//     already carry size caps, symlink rejection, and (for workspace sources) jail checks. There
//     is NO plugin code path that executes anything. Manifests declaring executable surfaces
//     (`hooks`, `mcpServers`, `scripts`, …) are REJECTED at install — those stay manual entries
//     in ~/.shadow/config.json, exactly as the founder's manual-MCP decision (F10-12) intends.
//   * Install ≠ activate. `shadow plugin add` installs DISABLED; the user reviews the files and
//     then enables it (`shadow plugin enable` / `/plugins enable`).
//   * Provenance is recorded (`.shadow-plugin-meta.json`): source URL + commit for git installs,
//     absolute source path for local installs. Codex ships opaque catalogs; a Shadow plugin is a
//     folder you can `ls`.
//   * Workspace-bundled plugin dirs (<repo>/.shadow/plugins) are NEVER auto-loaded — a repo can
//     only OFFER a plugin; installing it is an explicit `shadow plugin add <path>`.
//   * Enablement is global-only by construction: the state lives in ~/.shadow, never in a config
//     key a project file could set.

import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync,
  renameSync, chmodSync, rmSync, statSync, mkdtempSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { scrubbedEnv } from '../util/safeEnv.js';
import { recordEgress, isOfflineMode } from '../safety/egress.js';

/** The five declarative surfaces a plugin may contribute. Anything else is ignored or rejected. */
export const PLUGIN_CONTENT_DIRS = ['commands', 'output-styles', 'skills', 'agents', 'workflows'] as const;
export type PluginContentKind = (typeof PLUGIN_CONTENT_DIRS)[number];

const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MANIFEST_MAX_BYTES = 64 * 1024;
/** Disk-bomb guard: a plugin is markdown; anything bigger is not a plugin. */
const PLUGIN_MAX_BYTES = 8 * 1024 * 1024;
const PLUGIN_MAX_FILES = 500;
const CLONE_TIMEOUT_MS = 120_000;
const META_FILE = '.shadow-plugin-meta.json';

/**
 * Keys a manifest must NEVER carry. These are the EXECUTABLE extension surfaces — a plugin that
 * declares them is trying to grow code-execution capability out of a data-only install. They are
 * configured manually in ~/.shadow/config.json (hooks, mcpServers) and stay that way.
 */
const DANGEROUS_MANIFEST_KEYS = ['hooks', 'mcpServers', 'mcp', 'servers', 'scripts', 'bin', 'exec', 'postInstall'];

const PluginManifestSchema = z
  .object({
    name: z.string().regex(PLUGIN_NAME_RE, 'lowercase letters/digits/_- only, max 64 chars').max(64),
    version: z.string().min(1).max(64),
    description: z.string().min(1).max(300),
    author: z.string().max(120).optional(),
    homepage: z.string().max(300).optional(),
  })
  .strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export type PluginSource =
  | { kind: 'git'; url: string; commit: string }
  | { kind: 'path'; path: string };

export interface PluginMeta {
  /** Installed DISABLED; the user enables it after reviewing the files. */
  enabled: boolean;
  installedAt: string;
  source: PluginSource;
}

export interface PluginInfo {
  name: string;
  dir: string;
  manifest: PluginManifest;
  meta: PluginMeta;
  /** Per-surface contribution counts (what enabling it adds). */
  counts: Record<PluginContentKind, number>;
}

/** Recomputed on call (not a module const) so HOME-isolated tests always see their own dir. */
export function pluginsDir(): string {
  return join(homedir(), '.shadow', 'plugins');
}

function metaPath(name: string): string {
  return join(pluginsDir(), name, META_FILE);
}

function writeMeta(name: string, meta: PluginMeta): void {
  const dir = join(pluginsDir(), name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = metaPath(name);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Shape-check the provenance block — a hand-edited/corrupt meta must never reach display code. */
function isValidSource(s: unknown): s is PluginSource {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (o.kind === 'git') return typeof o.url === 'string' && typeof o.commit === 'string';
  if (o.kind === 'path') return typeof o.path === 'string';
  return false;
}

function readMeta(name: string): PluginMeta | null {
  try {
    const raw = JSON.parse(readFileSync(metaPath(name), 'utf8')) as Partial<PluginMeta>;
    if (typeof raw.enabled !== 'boolean' || typeof raw.installedAt !== 'string') return null;
    if (!isValidSource(raw.source)) return null;
    return raw as PluginMeta;
  } catch {
    return null;
  }
}

/**
 * Strip the character classes a hostile manifest/index could use to break one-line display
 * surfaces: C0 controls + DEL (terminal injection), zero-width characters, and the bidi
 * override/embedding ranges U+202A-E / U+2066-9 (visual URL spoofing).
 */
export function displaySafe(s: string, cap: number): string {
  const flat = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ').trim();
  return flat.length > cap ? flat.slice(0, cap) + '…' : flat;
}

/**
 * Parse + validate a manifest with the security-relevant failure modes spelled out: unknown keys
 * fail CLOSED, and executable-surface keys get a message that says exactly why.
 */
export function parseManifest(raw: string): PluginManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('manifest.json must be a JSON object');
  }
  const keys = Object.keys(json as object);
  const dangerous = keys.filter((k) => DANGEROUS_MANIFEST_KEYS.includes(k));
  if (dangerous.length > 0) {
    throw new Error(
      `manifest declares executable extension point(s): ${dangerous.join(', ')} — plugins are DATA-only ` +
        `(commands, output-styles, skills, agents, workflows). Hooks and MCP servers are configured ` +
        `manually in ~/.shadow/config.json and can never be installed by a plugin.`,
    );
  }
  const parsed = PluginManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`manifest.json invalid — ${issues}`);
  }
  return parsed.data;
}

// ── install ──────────────────────────────────────────────────────────────────

interface CopyState {
  files: number;
  bytes: number;
}

/**
 * Recursive copy that only ever DESCENDS into real directories and copies real `.md` files:
 * every symlink (file or dir) is skipped, dot-entries are skipped inside content dirs, `.git` is
 * never copied, and non-markdown files are left behind (data-only is literal). Enforces the
 * file/byte caps by STAT — before any read — and throws before a disk-bomb lands.
 */
function copyTree(src: string, dest: string, state: CopyState, allowDots: boolean): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // a symlink could escape the copied tree at read time
    if (!allowDots && entry.name.startsWith('.')) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o700 });
      copyTree(from, to, state, false);
    } else if (entry.isFile()) {
      // DATA-only is literal: only markdown documents cross the install boundary.
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      // Caps are enforced by STAT, before any read — a multi-GB file must never be buffered
      // into memory just to discover it is too big.
      let size: number;
      try {
        size = statSync(from).size;
      } catch {
        continue;
      }
      if (state.files + 1 > PLUGIN_MAX_FILES) {
        throw new Error(`plugin exceeds the ${PLUGIN_MAX_FILES}-file cap — not installed`);
      }
      if (state.bytes + size > PLUGIN_MAX_BYTES) {
        throw new Error(`plugin exceeds the ${PLUGIN_MAX_BYTES / (1024 * 1024)} MB cap — not installed`);
      }
      let buf: Buffer;
      try {
        buf = readFileSync(from);
      } catch {
        continue;
      }
      state.files += 1;
      state.bytes += buf.length;
      writeFileSync(to, buf, { mode: 0o600 });
    }
  }
}

function readManifestFrom(dir: string): PluginManifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    throw new Error(`no manifest.json in ${path} — a plugin needs a manifest declaring name/version/description`);
  }
  if (lstatSync(path).isSymbolicLink()) throw new Error('manifest.json is a symlink — refused');
  const size = statSync(path).size;
  if (size > MANIFEST_MAX_BYTES) throw new Error('manifest.json is too large');
  return parseManifest(readFileSync(path, 'utf8'));
}

/** The shared install path for both `add <path>` and the clone step of `add <git-url>`. */
function installFromDir(srcDir: string, source: PluginSource): PluginInfo {
  const real = resolve(srcDir);
  let st;
  try {
    st = lstatSync(real);
  } catch {
    throw new Error(`source not found: ${srcDir}`);
  }
  if (st.isSymbolicLink()) throw new Error('plugin source is a symlink — pass the real directory');
  if (!st.isDirectory()) throw new Error(`plugin source is not a directory: ${srcDir}`);

  const manifest = readManifestFrom(real);
  const dest = join(pluginsDir(), manifest.name);
  if (existsSync(dest)) {
    throw new Error(
      `plugin "${manifest.name}" is already installed — \`shadow plugin remove ${manifest.name}\` first, then re-add`,
    );
  }

  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const state: CopyState = { files: 0, bytes: 0 };
  try {
    // manifest.json first (required, already validated above)
    writeFileSync(join(dest, 'manifest.json'), readFileSync(join(real, 'manifest.json')), { mode: 0o600 });
    state.files += 1;
    state.bytes += statSync(join(real, 'manifest.json')).size;
    // optional provenance/readme files (plain files only, dotfiles excluded)
    for (const entry of readdirSync(real, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const lower = entry.name.toLowerCase();
      if (!/^(readme|license|notice|copying|authors)(\.[a-z0-9]+)?$/i.test(lower)) continue;
      const from = join(real, entry.name);
      const size = statSync(from).size; // cap by STAT before buffering
      if (state.files + 1 > PLUGIN_MAX_FILES || state.bytes + size > PLUGIN_MAX_BYTES) {
        throw new Error('plugin exceeds the size caps — not installed');
      }
      const buf = readFileSync(from);
      state.files += 1;
      state.bytes += buf.length;
      writeFileSync(join(dest, entry.name), buf, { mode: 0o600 });
    }
    // the five content surfaces (recursive; symlinks + dot-entries skipped; .git never copied)
    for (const sub of PLUGIN_CONTENT_DIRS) {
      const from = join(real, sub);
      try {
        if (!lstatSync(from).isDirectory()) continue;
      } catch {
        continue;
      }
      mkdirSync(join(dest, sub), { recursive: true, mode: 0o700 });
      copyTree(from, join(dest, sub), state, false);
    }
    const meta: PluginMeta = { enabled: false, installedAt: new Date().toISOString(), source };
    writeMeta(manifest.name, meta);
    return describePlugin(manifest.name)!;
  } catch (err) {
    // A failed install leaves NOTHING behind — our own partial tree is safe to remove.
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
}

/**
 * URL allowlist for `shadow plugin add <url>`. git understands several transports that EXECUTE
 * things (`ext::` runs an arbitrary command; `git://` is unauthenticated), and a leading `-`
 * would be parsed as an option. Fail closed on everything except the four shapes we reasoned about.
 */
export function assertAllowedGitUrl(raw: string): void {
  if (!raw || raw.length > 2048) throw new Error('plugin source URL is empty or too long');
  // No whitespace or control characters — real clone URLs don't contain them, and this kills
  // argument-smuggling in one stroke.
  if (/[\u0000-\u0020\u007f]/.test(raw)) throw new Error('plugin source URL contains whitespace/control characters');
  if (raw.startsWith('-')) throw new Error('plugin source may not start with "-" (git option injection)');
  if (/^ext::/i.test(raw)) throw new Error('ext:: git transport executes commands — refused');
  if (/^https:\/\//i.test(raw)) return;
  if (/^ssh:\/\//i.test(raw)) return;
  if (/^file:\/\//i.test(raw)) return;
  if (/^git@[\w.-]+:[\w./_-]+$/i.test(raw)) return; // scp-style ssh remote
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    throw new Error(`unsupported git URL scheme (only https://, ssh://, file://, or git@host:path are allowed): ${raw}`);
  }
  throw new Error(`not a recognized git URL or local path: ${raw}`);
}

/** Install a plugin from a local directory (copied — a plugin is self-contained once installed). */
export function installPluginFromPath(srcPath: string): PluginInfo {
  return installFromDir(srcPath, { kind: 'path', path: resolve(srcPath) });
}

/** The host a git URL points at (for the egress receipt); null for local file:// installs. */
function gitRemoteHost(url: string): string | null {
  if (/^file:\/\//i.test(url)) return null;
  const scheme = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/i);
  if (scheme) return scheme[1].toLowerCase();
  const scp = url.match(/^git@([\w.-]+):/i);
  return scp ? scp[1].toLowerCase() : null;
}

/**
 * Install from a git URL: shallow clone into a temp dir, record the commit, install the tree.
 * The clone runs with a SCRUBBED env (no ambient secrets reach the remote) and
 * GIT_TERMINAL_PROMPT=0 (a private repo fails fast instead of hanging on a credential prompt —
 * clone it yourself and `shadow plugin add <path>` if you need auth).
 *
 * The clone is a git CHILD PROCESS, so it bypasses the fetch-based egress broker — it therefore
 * honors the offline wall here explicitly and journals its own receipt (purpose 'plugin-clone')
 * so `shadow egress` stays a complete record. `opts.offline` lets the CLI pass `--offline`
 * directly (this code path runs before any session bootstrap would set the global flag).
 */
export function installPluginFromGit(url: string, opts: { offline?: boolean } = {}): PluginInfo {
  assertAllowedGitUrl(url);
  const offline = opts.offline ?? isOfflineMode();
  const host = gitRemoteHost(url);
  if (offline && host) {
    recordEgress(host, 'plugin-clone', 'denied');
    throw new Error(`offline mode: plugin install from ${host} is blocked (local file:// sources still work)`);
  }
  // mkdtempSync creates the dir 0700 BEFORE git runs — a private repo's bytes never sit
  // world-readable in /tmp for the install window.
  const tmp = mkdtempSync(join(tmpdir(), 'shadow-plugin-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', '--', url, tmp], {
      env: scrubbedEnv(undefined, { GIT_TERMINAL_PROMPT: '0' }),
      timeout: CLONE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    let commit = '';
    try {
      commit = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], {
        env: scrubbedEnv(),
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
    } catch {
      /* provenance best-effort */
    }
    if (host) recordEgress(host, 'plugin-clone', 'allowed'); // broker-bypass receipt (git child process)
    return installFromDir(tmp, { kind: 'git', url, commit });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const detail = (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString()) ?? e.message ?? 'clone failed';
    if (err instanceof Error && 'code' in err && String(detail).includes('already installed')) throw err;
    throw new Error(`git clone failed for ${url}: ${displaySafe(detail.split('\n')[0] ?? detail, 200)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // our own temp clone — never user data
  }
}

/** Classify the `add` argument: an existing directory is a path install, otherwise a git URL. */
export function installPluginFromArg(arg: string, opts: { offline?: boolean } = {}): PluginInfo {
  const trimmed = arg.trim();
  if (!trimmed) throw new Error('usage: shadow plugin add <git-url|path>');
  try {
    if (lstatSync(resolve(trimmed)).isDirectory()) return installPluginFromPath(trimmed);
  } catch {
    /* not a local dir — treat as URL */
  }
  return installPluginFromGit(trimmed, opts);
}

// ── query + lifecycle ────────────────────────────────────────────────────────

function countSurface(dir: string, kind: PluginContentKind): number {
  try {
    if (kind === 'skills') {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .filter((d) => existsSync(join(dir, d.name, 'SKILL.md'))).length;
    }
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/** Read one installed plugin; null if the directory is absent or the manifest/meta are broken. */
export function describePlugin(name: string): PluginInfo | null {
  // The name regex is the traversal wall: every lifecycle op (enable/disable/remove) funnels
  // through here, so `../foo` can never reach writeMeta/renameSync.
  if (!PLUGIN_NAME_RE.test(name)) return null;
  const dir = join(pluginsDir(), name);
  try {
    if (!lstatSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  let manifest: PluginManifest;
  try {
    manifest = readManifestFrom(dir);
  } catch {
    return null;
  }
  const meta = readMeta(name);
  if (!meta) return null;
  const counts = {} as Record<PluginContentKind, number>;
  for (const sub of PLUGIN_CONTENT_DIRS) counts[sub] = countSurface(join(dir, sub), sub);
  return { name, dir, manifest, meta, counts };
}

/** All installed plugins, sorted by name. Directories with broken manifests are skipped silently. */
export function listPlugins(): PluginInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(pluginsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: PluginInfo[] = [];
  for (const name of entries.sort((a, b) => a.localeCompare(b))) {
    const info = describePlugin(name);
    if (info) out.push(info);
  }
  return out;
}

export function setPluginEnabled(name: string, enabled: boolean): PluginInfo {
  const info = describePlugin(name);
  if (!info) throw new Error(`plugin "${name}" is not installed`);
  writeMeta(name, { ...info.meta, enabled });
  return describePlugin(name)!;
}

/**
 * Remove = ARCHIVE: the plugin dir moves to `~/.shadow/plugins/.removed/<name>-<timestamp>` so a
 * mistaken remove is recoverable. Returns the archive path.
 */
export function removePlugin(name: string): string {
  const info = describePlugin(name);
  if (!info) throw new Error(`plugin "${name}" is not installed`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = join(pluginsDir(), '.removed');
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const dest = join(archiveDir, `${name}-${stamp}`);
  renameSync(info.dir, dest);
  return dest;
}

/**
 * The enabled-plugin directories for one content surface — the loader integration point. Order
 * follows listPlugins() (name-sorted); loaders insert these BETWEEN the workspace roots and the
 * user's own home dirs, so the user's own files win collisions and plugins win over repos.
 */
export function enabledPluginDirs(subdir: PluginContentKind): string[] {
  const out: string[] = [];
  for (const p of listPlugins()) {
    if (!p.meta.enabled) continue;
    const d = join(p.dir, subdir);
    try {
      if (lstatSync(d).isDirectory()) out.push(d);
    } catch {
      /* surface absent */
    }
  }
  return out;
}
