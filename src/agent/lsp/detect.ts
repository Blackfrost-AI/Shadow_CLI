// LSP server detection (plan 3.1). PURE + injectable: inspects files and PATH only — nothing
// is executed and NOTHING IS EVER INSTALLED. A server activates solely because the user's own
// machine already has it (a binary on PATH, or a local node_modules typescript the user opted
// into — see the trust gate below).
//
// Trust posture: the `lsp.servers` override map comes from the TRUSTED GLOBAL config only —
// `lsp` is in PROJECT_UNTRUSTED_KEYS, so a cloned repo cannot name commands we spawn. The same
// rule covers the project's OWN node_modules: a repo-controlled tsserver.js is a repo-controlled
// program, so it is only ever a spawn target after the user sets `lsp.trustNodeModules: true`
// in their GLOBAL config. PATH-resolved binaries need no opt-in (machine-resolved, like the
// formatter binaries).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { lookpath } from '../formatter.js';
import type { LspServerFlavor } from './protocol.js';

/** Where a repo's own typescript install lives (a repo-controlled spawn target — see header). */
export function localTsserverPath(projectDir: string): string {
  return join(projectDir, 'node_modules', 'typescript', 'lib', 'tsserver.js');
}

/** A resolved server: how to spawn it and which wire dialect it speaks. */
export interface LspServerSpec {
  id: string;
  flavor: LspServerFlavor;
  /** argv[0] — absolute when resolvable (PATH hit / local file / execPath). */
  command: string;
  args: string[];
  /**
   * True ONLY for servers resolved from the project's own tree (the node_modules tsserver) —
   * i.e. a repo-controlled spawn target. The service refuses those unless the user set
   * `lsp.trustNodeModules` in trusted GLOBAL config. PATH hits and config overrides are
   * machine/user-resolved → false.
   */
  projectSourced: boolean;
}

/** The `lsp.servers` config record (trusted global config only). */
export interface LspServerOverride {
  command: string;
  args?: string[];
}

export interface DetectLspOptions {
  /** Does this absolute path exist? (default: fs.existsSync — injectable for tests) */
  exists?: (abs: string) => boolean;
  /** Find a binary on PATH → absolute path or null. (default: formatter.lookpath) */
  which?: (bin: string) => string | null;
  /** Node binary for running a local tsserver.js (default: process.execPath). */
  execPath?: string;
  /** `lsp.servers` config record: overrides a detected id or adds a user-defined server. */
  overrides?: Record<string, LspServerOverride>;
  /** The GLOBAL-config trust opt-in for node_modules-sourced servers (default false). */
  trustNodeModules?: boolean;
}

/** Auto-detection order (before overrides are applied). */
const AUTO_IDS = ['typescript', 'pyright', 'gopls', 'rust-analyzer'] as const;

/**
 * Detect available LSP servers for a project. Returns one entry per server id that is actually
 * present on this machine, overridden/extended by the config record. Never throws.
 */
export function detectLspServers(projectDir: string, opts?: DetectLspOptions): LspServerSpec[] {
  const exists = opts?.exists ?? existsSync;
  const which = opts?.which ?? ((bin: string) => lookpath(bin));
  const execPath = opts?.execPath ?? process.execPath;
  const trustNodeModules = opts?.trustNodeModules === true;
  const found = new Map<string, LspServerSpec>();

  // typescript — the project's OWN install, but ONLY behind the global trust opt-in: that file
  // is repo content, and spawning it runs repo code. tsserver speaks its native seq protocol
  // (not JSON-RPC) → flavor 'tsserver'.
  const localTsserver = localTsserverPath(projectDir);
  if (exists(localTsserver) && trustNodeModules) {
    found.set('typescript', { id: 'typescript', flavor: 'tsserver', command: execPath, args: [localTsserver], projectSourced: true });
  } else {
    // Untrusted-or-absent local install → a user-installed typescript-language-server (true
    // LSP, machine-resolved) is the fallback — we never add it.
    const tsLs = which('typescript-language-server');
    if (tsLs) found.set('typescript', { id: 'typescript', flavor: 'lsp', command: tsLs, args: ['--stdio'], projectSourced: false });
  }

  // pyright / gopls / rust-analyzer — PATH binaries speaking real LSP over stdio.
  const pyright = which('pyright-langserver');
  if (pyright) found.set('pyright', { id: 'pyright', flavor: 'lsp', command: pyright, args: ['--stdio'], projectSourced: false });
  const gopls = which('gopls');
  if (gopls) found.set('gopls', { id: 'gopls', flavor: 'lsp', command: gopls, args: [], projectSourced: false });
  const rustAnalyzer = which('rust-analyzer');
  if (rustAnalyzer) found.set('rust-analyzer', { id: 'rust-analyzer', flavor: 'lsp', command: rustAnalyzer, args: [], projectSourced: false });

  // Config overrides: replace a detected id (or add a user-defined server) by id. Global config
  // only (PROJECT_UNTRUSTED_KEYS) — user-named commands are trusted by construction.
  for (const [id, override] of Object.entries(opts?.overrides ?? {})) {
    if (typeof override?.command !== 'string' || override.command.trim() === '') continue;
    found.set(id, { id, flavor: 'lsp', command: override.command, args: override.args ?? [], projectSourced: false });
  }

  // Deterministic order: the auto ids first, then any user-added ids alphabetically.
  const auto = AUTO_IDS.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
  const extra = [...found.keys()]
    .filter((id) => !(AUTO_IDS as readonly string[]).includes(id))
    .sort()
    .map((id) => found.get(id)!);
  return [...auto, ...extra];
}
