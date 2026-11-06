// DAP adapter registry (mission m-10). Resolution is PURE + injectable (lsp/detect.ts
// pattern): nothing is executed, nothing is installed, and NOTHING IS EVER SIMULATED.
//
// Absence is a first-class outcome, never an exception and never a silent fallback: the
// registry returns { state: 'absent' } with the exact reason and the installation
// requirement, and the session layer turns that into a refusal to launch.
//
// Presence requires BOTH, verified by pure fs/PATH probes:
//   1. the adapter's interpreter on PATH (node for js-debug's standalone DAP server;
//      python3 for debugpy), and
//   2. an EXPLICIT adapter installation configured in TRUSTED GLOBAL config only.
// There is deliberately NO project-sourced auto-discovery (unlike LSP's opt-in
// node_modules tsserver): a debug adapter executes a debuggee — a repo must never be
// able to name the program we spawn. A PATH hit alone is NOT presence: the adapter
// implementation must exist on disk at the configured location.

import { existsSync } from 'node:fs';
import { lookpath } from '../formatter.js';
import { isAbsolute, join, resolve } from 'node:path';

/** Languages Shadow can debug. 'ts' routes to the JS adapter (js-debug handles TypeScript). */
export type DapLanguage = 'js' | 'ts' | 'python';

/** Adapter ids — the names shown to the operator in absence reports. */
export type DapAdapterId = 'js-debug' | 'debugpy';

/** How to spawn a PRESENT adapter. argv is fixed: no shell, no config-sourced arguments. */
export interface DapAdapterSpec {
  /** Registry id. */
  id: DapAdapterId;
  language: DapLanguage;
  /** argv[0] — an absolute interpreter or bridge path, existence-verified. */
  command: string;
  /** Fixed argv tail (the adapter's own server entry point). */
  args: string[];
  /** Human-readable installation requirement, shown verbatim in absence reports. */
  installRequirement: string;
}

/** Resolution outcome. `absent` carries the reason the operator must act on. */
export type DapAdapterStatus =
  | { state: 'present'; spec: DapAdapterSpec }
  | { state: 'absent'; id: DapAdapterId; language: DapLanguage; reason: string; installRequirement: string };

/** Trusted GLOBAL config record for one adapter (never project-local — see header). */
export interface DapAdapterOverride {
  /** Absolute path to the adapter installation root (js-debug) or stdio bridge (debugpy). */
  adapterPath: string;
}

export interface ResolveDapAdapterOptions {
  /** Does this absolute path exist? (default fs.existsSync — injectable for tests) */
  exists?: (abs: string) => boolean;
  /** Find a binary on PATH → absolute path or null. (default formatter.lookpath) */
  which?: (bin: string) => string | null;
  /** Trusted GLOBAL config overrides keyed by adapter id. */
  overrides?: Partial<Record<DapAdapterId, DapAdapterOverride>>;
}

// ── registry table ─────────────────────────────────────────────────────────────

/**
 * js-debug ships a STANDALONE DAP server (src/dapDebugServer.js) usable outside VS Code
 * (Neovim does exactly this). The distribution layout is `js-debug/src/dapDebugServer.js`
 * inside the extracted release bundle, so that file is the presence marker.
 */
const JS_DEBUG: {
  id: 'js-debug';
  interpreterBin: 'node';
  markerRel: string;
  installRequirement: string;
} = {
  id: 'js-debug',
  interpreterBin: 'node',
  markerRel: join('js-debug', 'src', 'dapDebugServer.js'),
  installRequirement:
    'Install the vscode-js-debug standalone DAP server: download the release bundle from ' +
    'https://github.com/microsoft/vscode-js-debug/releases, extract it, and set ' +
    "dap.adapters['js-debug'].adapterPath to the extraction directory in trusted GLOBAL config " +
    '(see docs/DAP_DEBUGGING.md).',
};

/**
 * debugpy's CLI speaks DAP over TCP only (its --listen/--connect modes) — it has NO stdio
 * mode. Shadow\'s DAP transport is stdio, so Python debugging additionally requires an
 * operator-provided stdio bridge, configured explicitly. We never claim stock debugpy
 * works over this transport.
 */
const DEBUGPY: {
  id: 'debugpy';
  interpreterBin: 'python3';
  installRequirement: string;
} = {
  id: 'debugpy',
  interpreterBin: 'python3',
  installRequirement:
    'Install debugpy (python3 -m pip install debugpy), then provide a stdio DAP bridge ' +
    '(debugpy has no stdio mode) and set dap.adapters.debugpy.adapterPath to the bridge ' +
    'executable in trusted GLOBAL config (see docs/DAP_DEBUGGING.md).',
};

/**
 * Resolve the adapter for a language. PURE: probes are injected, nothing runs.
 * A PATH interpreter alone is NOT presence — see the file header.
 */
export function resolveDapAdapter(language: DapLanguage, opts: ResolveDapAdapterOptions = {}): DapAdapterStatus {
  const exists = opts.exists ?? ((p) => existsSync(p));
  const which = opts.which ?? lookpath;
  const entry = language === 'python' ? DEBUGPY : JS_DEBUG;

  // 1. Interpreter: necessary but never sufficient.
  const interpreter = which(entry.interpreterBin);
  if (!interpreter) {
    return {
      state: 'absent', id: entry.id, language,
      reason: `Adapter '${entry.id}' is absent: no '${entry.interpreterBin}' on PATH.`,
      installRequirement: entry.installRequirement,
    };
  }

  // 2. Explicit, trusted, on-disk installation.
  const configured = opts.overrides?.[entry.id]?.adapterPath;
  if (typeof configured !== 'string' || configured.trim() === '') {
    return {
      state: 'absent', id: entry.id, language,
      reason: `Adapter '${entry.id}' is absent: no installation is configured.`,
      installRequirement: entry.installRequirement,
    };
  }
  const adapterPath = isAbsolute(configured) ? configured : resolve(configured);
  if (!exists(adapterPath)) {
    return {
      state: 'absent', id: entry.id, language,
      reason: `Adapter '${entry.id}' is absent: configured installation '${adapterPath}' does not exist.`,
      installRequirement: entry.installRequirement,
    };
  }

  // 3. Spawn spec: fixed argv, existence-verified, never shell-mediated.
  if (entry.id === 'js-debug') {
    const server = join(adapterPath, JS_DEBUG.markerRel);
    if (!exists(server)) {
      return {
        state: 'absent', id: entry.id, language,
        reason: `Adapter 'js-debug' is absent: installation at '${adapterPath}' is incomplete ` +
          `('${JS_DEBUG.markerRel}' missing).`,
        installRequirement: entry.installRequirement,
      };
    }
    return { state: 'present', spec: { id: entry.id, language, command: interpreter, args: [server], installRequirement: entry.installRequirement } };
  }

  // debugpy: the configured path IS the stdio bridge executable (spawned directly, no shell).
  return {
    state: 'present',
    spec: { id: 'debugpy', language, command: adapterPath, args: [], installRequirement: entry.installRequirement },
  };
}

/** Every adapter Shadow knows about, for a status report (used by docs/UI; never a spawn source). */
export function dapAdapterCatalog(): Array<{ id: DapAdapterId; language: DapLanguage; installRequirement: string }> {
  return [
    { id: JS_DEBUG.id, language: 'js', installRequirement: JS_DEBUG.installRequirement },
    { id: DEBUGPY.id, language: 'python', installRequirement: DEBUGPY.installRequirement },
  ];
}
