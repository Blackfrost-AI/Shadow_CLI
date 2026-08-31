// LSP the Shadow way (plan 3.1): types and tuning constants only — no behavior lives here.
//
// Scope discipline is the feature: diagnostics are collected ONLY for files the agent just
// wrote, deduped, and budget-capped before a note rides the tool result. Every cap below
// exists so a pathological server (or a pathological file) can never tax the turn: omp's #1
// LSP complaint is context pollution; this module is the list of ways we refuse to do that.

/** One normalized diagnostic, regardless of server dialect. Lines/cols are 1-based. */
export interface LspDiagnostic {
  uri: string;
  line: number;
  col: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code?: string;
  source?: string;
}

/** Wire dialect: true LSP (JSON-RPC) or tsserver's native seq/command protocol. */
export type LspServerFlavor = 'lsp' | 'tsserver';

/** File-mutating tools whose successful results get an LSP diagnostics pass. */
export const LSP_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'edit_file',
  'write_file',
  'multi_edit',
  'apply_patch',
]);

/** Max files diagnosed per tool call (an apply_patch can touch many; we sample the first N). */
export const MAX_FILES_PER_CALL = 4;
/** Max diagnostics rendered per file; the rest collapse into `(+N more)`. */
export const MAX_DIAGS_PER_FILE = 6;
/** Total note budget per file, head-heavy (diagnostics.ts capOutput parity). */
export const MAX_NOTE_CHARS = 4_000;
/** How long to wait for a diagnostics batch before giving up on this write's note. */
export const SERVER_DEADLINE_MS = 3_000;
/** SIGTERM → SIGKILL escalation window when stopping a server (diagnostics.ts parity). */
export const KILL_GRACE_MS = 2_000;
/** Files larger than this are skipped (a multi-MB blob is not a diagnose-me artifact). */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Extension → server id. Keys lowercase, no leading dot. */
export const SERVER_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  py: 'pyright',
  go: 'gopls',
  rs: 'rust-analyzer',
});

/** Server id → LSP languageId for didOpen (unknown/user-defined servers fall back to the extension). */
export const SERVER_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  typescript: 'typescript',
  pyright: 'python',
  gopls: 'go',
  'rust-analyzer': 'rust',
});
