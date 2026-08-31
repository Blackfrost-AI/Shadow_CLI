// LSP the Shadow way (plan 3.1) — public surface. The loop calls ONE function, `lspNoteFor`,
// after a file-mutating tool succeeds; everything else here is plumbing it can ignore.
//
// Gate chain (in order, cheapest first): kill switch → disabled → not-ok/dry-run → not a
// write tool → inside-workspace paths (input.path + apply_patch's result.data.files, capped)
// → collect (open/change + await, shared deadline) → render → dedupe → budget. Any failure
// anywhere answers null — the write result is sacred.
//
// Service cache: MODULE-level, keyed by workspace root (gguf.ts pattern) — servers outlive
// AgentLoops. `stopLspServices` is wired into shutdownCore AND a process 'exit' hook so an
// unref'd server can never outlive us.

import { relative, resolve } from 'node:path';
import { insideProject } from '../formatter.js';
import type { EventBus } from '../events.js';
import { renderDiagnostics } from './note.js';
import { LSP_WRITE_TOOL_NAMES, MAX_FILES_PER_CALL, SERVER_DEADLINE_MS, type LspDiagnostic } from './protocol.js';
import { createLspService, type LspService, type LspServiceConfig } from './service.js';

export { frameMessage, LspDecoder, MAX_BUFFERED_BYTES } from './framing.js';
export { renderDiagnostics, NoteDeduper } from './note.js';
export { createLspNoteBudget } from './noteBudget.js';
export { detectLspServers } from './detect.js';
export type { LspServerSpec, LspServerOverride, DetectLspOptions } from './detect.js';
export {
  createLspService,
  RESTART_CAP,
  type LspServiceConfig,
  type LspServiceSnapshot,
  type LspServerStatus,
  type CollectOptions,
} from './service.js';
export { createLspConnection, type ServerConnection, type ConnectionState } from './client.js';
export { createTsserverConnection } from './tsserver.js';
export {
  LSP_WRITE_TOOL_NAMES,
  MAX_FILES_PER_CALL,
  MAX_DIAGS_PER_FILE,
  MAX_NOTE_CHARS,
  SERVER_DEADLINE_MS,
  KILL_GRACE_MS,
  MAX_FILE_BYTES,
  SERVER_BY_EXT,
  SERVER_LANGUAGE,
  type LspDiagnostic,
  type LspServerFlavor,
} from './protocol.js';

// ── module-level service cache ─────────────────────────────────────────────────

const services = new Map<string, LspService>();
let exitHooked = false;

function installExitHook(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', stopLspServices);
}

/** The (cached) LSP service for a workspace. Created once per process per root. */
export function getLspService(workspaceRoot: string, config?: LspServiceConfig, env?: NodeJS.ProcessEnv): LspService {
  let svc = services.get(workspaceRoot);
  if (!svc) {
    svc = createLspService({ projectDir: workspaceRoot, config, env });
    services.set(workspaceRoot, svc);
    installExitHook();
  }
  return svc;
}

/** Stop every spawned server (shutdownCore + process exit). */
export function stopLspServices(): void {
  for (const [, svc] of services) svc.stop();
  services.clear();
}

/** SHADOW_NO_LSP=1 — same spelling and semantics as the formatter's SHADOW_NO_FORMAT. */
export function lspKillSwitchActive(env?: NodeJS.ProcessEnv): boolean {
  return (((env ?? process.env) as Record<string, string | undefined>).SHADOW_NO_LSP ?? '') === '1';
}

// ── the loop hook ──────────────────────────────────────────────────────────────

export interface LspNoteForOptions {
  /** Tool name (e.g. 'write_file'). */
  tool: string;
  /** Did the tool succeed? Notes ride successes only. */
  ok: boolean;
  dryRun?: boolean;
  /** The tool's parsed input ({ path } for the file tools). */
  input?: unknown;
  /** The tool's result (apply_patch paths come from result.data.files). */
  result?: { data?: unknown } | null;
  workspaceRoot: string;
  /** The `lsp` config block. */
  lsp?: LspServiceConfig;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Test seam; defaults to the cached service for workspaceRoot. */
  service?: LspService;
  bus?: EventBus | null;
}

/** Paths a tool call just wrote: input.path for the file tools, apply_patch's touched list. */
function writtenPaths(tool: string, input: unknown, result: { data?: unknown } | null | undefined): string[] {
  const paths: string[] = [];
  const inp = (input ?? {}) as { path?: unknown };
  if (typeof inp.path === 'string' && inp.path !== '') paths.push(inp.path);
  if (tool === 'apply_patch') {
    const data = (result?.data ?? {}) as { files?: unknown };
    if (Array.isArray(data.files)) for (const f of data.files) if (typeof f === 'string' && f !== '') paths.push(f);
  }
  return paths;
}

/** Stable per-batch signature for the deduper. */
function signature(diags: LspDiagnostic[]): string {
  return diags.map((d) => `${d.line}:${d.col}:${d.code ?? ''}:${d.message}`).join(';');
}

// Registered once per service so a bus present on any call receives the (rare) disable notice.
const busNotified = new WeakSet<LspService>();

/**
 * The diagnostics note for one tool result: `\n\n[lsp: typescript] 2 errors…` or null.
 * Never throws; a skipped/failed pass costs nothing.
 */
export async function lspNoteFor(opts: LspNoteForOptions): Promise<string | null> {
  try {
    if (lspKillSwitchActive(opts.env)) return null;
    if (opts.lsp?.enabled === false) return null;
    if (!opts.ok || opts.dryRun) return null;
    if (!LSP_WRITE_TOOL_NAMES.has(opts.tool)) return null;

    const service = opts.service ?? getLspService(opts.workspaceRoot, opts.lsp, opts.env);
    if (opts.bus && !busNotified.has(service)) {
      busNotified.add(service);
      const bus = opts.bus;
      service.onNotice((message) => bus.emit({ type: 'finding', title: 'LSP diagnostics paused', body: message, severity: 'warn' }));
    }

    // Resolve, contain, dedupe, cap. Files outside the workspace are never sent to a server.
    const seen = new Set<string>();
    const files: string[] = [];
    for (const p of writtenPaths(opts.tool, opts.input, opts.result)) {
      const abs = resolve(opts.workspaceRoot, p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      if (!insideProject(opts.workspaceRoot, abs)) continue;
      files.push(abs);
      if (files.length >= MAX_FILES_PER_CALL) break;
    }
    if (files.length === 0) return null;

    // One shared deadline across all files: worst case the note costs timeoutMs, not N×.
    const timeoutMs = opts.lsp?.timeoutMs ?? SERVER_DEADLINE_MS;
    const deadlineAt = Date.now() + timeoutMs;
    const budget = service.noteBudget();
    const deduper = service.noteDeduper();
    // Session budget already latched exhausted → notes are suppressed for the rest of the
    // session; collecting anyway would burn the deadline on every write for nothing.
    if (budget.exhausted()) return null;
    let note = '';
    for (const abs of files) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) break;
      const diags = await service.collect(abs, { deadlineMs: remaining, signal: opts.signal });
      if (!diags || diags.length === 0) continue;
      const serverId = service.serverIdFor(abs) ?? 'lsp';
      const relPath = relative(opts.workspaceRoot, abs) || abs;
      const rendered = renderDiagnostics({ serverId, relPath, diags });
      if (rendered === null) continue; // clean file — silence is free
      if (!deduper.shouldEmit(diags[0]!.uri, signature(diags))) continue; // identical note seen already
      if (!budget.allows(rendered.length)) {
        // A note blocked by the SESSION cap exhausts it in place — `record` never runs for a
        // refused note, so without this the latch (and its one finding) could never trip.
        if (budget.blockedBySession(rendered.length)) budget.markExhausted();
        break; // budgets never widen mid-call
      }
      note += rendered;
      budget.record(rendered.length);
    }

    // Exactly one bus finding the first time the SESSION budget latches exhausted.
    if (budget.announceExhausted() && opts.bus) {
      opts.bus.emit({
        type: 'finding',
        title: 'LSP diagnostics notes paused for this session',
        body: `Per-session note budget (${budget.snapshot().maxSessionChars} chars) reached; further LSP notes are suppressed. Writes are unaffected — set lsp.notes.maxSessionChars to adjust.`,
        severity: 'info',
      });
    }

    return note === '' ? null : note;
  } catch {
    return null; // an LSP problem never fails the write
  }
}
