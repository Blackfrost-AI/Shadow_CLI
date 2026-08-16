import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { scrubbedEnv } from '../util/safeEnv.js';

/**
 * F07-03: a hook script path is only ever run if it is ABSOLUTE. Hook scripts come solely from the
 * trusted global config (~/.shadow) — a project `shadow.config.json` cannot set `hooks` (see
 * PROJECT_UNTRUSTED_KEYS in config.ts). The old behavior resolved a RELATIVE global hook path against
 * the CURRENT workspace root and ran it with `shell: true` before any LLM call or approval gate: a
 * cloned repo shipping that same relative path was a zero-interaction drive-by RCE (session_start
 * fires first). We never resolve a hook against the workspace. An absolute path is unambiguous and
 * behaves exactly as before; a relative one is REFUSED — never executed, never silently re-pointed —
 * with a warning steering the user to an absolute path in ~/.shadow.
 */
function resolveHookCommand(script: string): { cmd: string } | { cmd: null; reason: string } {
  if (isAbsolute(script)) return { cmd: script };
  return {
    cmd: null,
    reason:
      `relative hook path "${script}" is not run (resolved against the workspace would be a ` +
      `drive-by RCE risk) — set an absolute path in ~/.shadow/config.json`,
  };
}

export type HookPhase =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'session_start'
  | 'session_end'
  | 'user_prompt_submit'
  | 'pre_compact'
  | 'post_compact'
  | 'stop'
  | 'subagent_stop'
  | 'notification';

// ─── F08-09 hooks v2: structured entries, tool-name matchers, stdout verdicts ──────────────────
//
// v1 entries were bare command strings. v2 accepts either form (the string form is unchanged),
// or `{ command, matcher? }` where `matcher` filters TOOL phases by tool name. A matcher is a
// `|`-separated list of globs (`edit_*|multi_edit`; `*` = any run, `?` = one char) matched
// case-sensitively against the full tool name. Matchers are only consulted on the tool phases
// (pre/post_tool_use); on every other phase an entry runs regardless of any matcher it carries.
//
// A hook that EXITS 0 may additionally print ONE JSON object on stdout (logs go to stderr — a
// stdout that does not parse as a single JSON object is treated as no verdict, exactly like v1):
//   { "decision": "block" | "deny", "reason": "..." }   — deny phases only; blocks the action
//                                                          with `reason` even on exit 0.
//   { "context": "..." }                                 — additional context, folded into what
//                                                          the model sees (tool phases: the tool
//                                                          result; user_prompt_submit: the prompt).
// Hooks can only make an action MORE restricted: `decision` is honored on deny phases only and can
// never approve past the autonomy gate (which already ran before pre_tool_use). Hook stdout is
// UNTRUSTED INPUT — context/reason are stripped of control characters and clamped before folding.

export interface HookEntry {
  command: string;
  matcher?: string;
}
export type HookEntrySpec = string | HookEntry;

/** Accept the v1 string form or the v2 object form; both normalize to {@link HookEntry}. */
export function normalizeHookEntry(entry: HookEntrySpec): HookEntry {
  if (typeof entry === 'string') return { command: entry };
  return entry;
}

/** Glob/pipe-match a tool name: `edit_*|multi_edit` → true for `edit_file`, `multi_edit`. */
export function matchToolName(matcher: string, tool: string): boolean {
  return matcher.split('|').some((alt) => {
    const g = alt.trim();
    if (!g) return false;
    const re = new RegExp(
      '^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return re.test(tool);
  });
}

const TOOL_PHASES = new Set<HookPhase>(['pre_tool_use', 'post_tool_use']);

/** False only for a tool-phase entry whose matcher excludes the current tool. */
function entryApplies(phase: HookPhase, entry: HookEntry, tool?: string): boolean {
  if (!TOOL_PHASES.has(phase) || entry.matcher == null || entry.matcher === '') return true;
  return tool != null && matchToolName(entry.matcher, tool);
}

/** Max chars of hook `context` folded into one action; excess is dropped with a marker. Enforced
 *  per phase AND on the per-action join ({@link combineHookContexts}), so pre+post context together
 *  can never exceed the cap in a single tool action. */
export const MAX_HOOK_CONTEXT_CHARS = 8000;

/** Cap on a FAILED hook's deny message — stderr can echo workspace data up to maxBuffer (~1 MB);
 *  the model only needs the head of a genuine error. */
export const MAX_HOOK_FAILURE_CHARS = 2000;

/** Hook timing. Exported so tests can shrink the 30 s cap without sleeping for real; production
 *  code must not mutate it. */
export const hookTiming = { timeoutMs: 30_000, detachedGraceMs: 2_000 };

/** Strip C0 (but keep \t \n), DEL, C1 controls, AND the Unicode format/invisible set — hook stdout
 *  rides into the model context: bidi overrides (U+202A–202E, isolates U+2066–2069), zero-widths
 *  (U+200B–200F, U+2060–206F, U+FEFF, U+00AD) and the U+2028/U+2029 line separators are exactly the
 *  bypass set the C0/C1 strip defends against (visually spoofed or invisible payload in the
 *  transcript the model reads). */
function cleanHookText(s: string): string {
  return s.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    '',
  );
}

/** Join hook contexts from separate phases that fold into ONE action, clamping the TOTAL.
 *  pre_tool_use and post_tool_use each clamp at MAX_HOOK_CONTEXT_CHARS independently; without the
 *  join clamp one tool action could carry ~2× the cap. */
export function combineHookContexts(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (!present.length) return undefined;
  let joined = present.join('\n');
  if (joined.length > MAX_HOOK_CONTEXT_CHARS) {
    joined = joined.slice(0, MAX_HOOK_CONTEXT_CHARS) + '\n…(hook context truncated)';
  }
  return joined;
}

interface HookStdoutVerdict {
  block?: string;
  context?: string;
}

/**
 * Parse an exit-0 hook's stdout as ONE JSON object. Anything that is not a single JSON object
 * (logs, empty output, garbage after the object) yields NO verdict — v1 behavior, and it keeps a
 * hook that merely prints logs from accidentally blocking anything.
 */
export function parseHookStdout(raw: string): HookStdoutVerdict {
  const t = raw.trim();
  if (!t.startsWith('{')) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const o = obj as Record<string, unknown>;
  // OWN-property reads only: a prototype-chain lookup would let a polluted Object.prototype
  // (set by anything else in-process) inject a fake verdict or context into EVERY hook's stdout.
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  const out: HookStdoutVerdict = {};
  const decision =
    has('decision') && typeof o.decision === 'string' ? o.decision.trim().toLowerCase() : undefined;
  if (decision === 'block' || decision === 'deny') {
    out.block =
      has('reason') && typeof o.reason === 'string' && o.reason.trim()
        ? cleanHookText(o.reason.trim())
        : 'blocked by hook decision';
  }
  if (has('context') && typeof o.context === 'string' && o.context.trim()) {
    out.context = cleanHookText(o.context.trim());
  }
  return out;
}

export interface HookPhaseResult {
  ok: boolean;
  message?: string;
  /** Accumulated `context` from exit-0 hooks (control-stripped, clamped), if any. */
  context?: string;
}

export interface HookContext {
  phase: HookPhase;
  workspaceRoot: string;
  tool?: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
  prompt?: string;
  sessionId?: string;
  extra?: Record<string, unknown>;
}

const DENY_PHASES = new Set<HookPhase>(['pre_tool_use', 'user_prompt_submit']);

/**
 * Run configured hook entries for a lifecycle phase. Non-zero exit on deny phases blocks the
 * action; an exit-0 hook may additionally block via a stdout `{decision:"block"}` verdict and/or
 * contribute `{context}` folded into what the model sees (see the v2 block above). Hooks receive
 * JSON on stdin: { phase, workspaceRoot, ... }.
 */
export function runHookPhase(
  phase: HookPhase,
  entries: HookEntrySpec[],
  ctx: Omit<HookContext, 'phase'>,
): HookPhaseResult {
  if (!entries.length) return { ok: true };
  const payload = JSON.stringify({ ...ctx, phase });
  const contexts: string[] = [];
  for (const spec of entries) {
    const entry = normalizeHookEntry(spec);
    // Deny-phase fail-closed seam: a tool-phase guard hook that carries a matcher must never be
    // SILENTLY skipped because a caller omitted `tool` — refuse the action instead of skipping
    // the guard into allowing it. (All current tool-phase callers pass `tool`; this keeps the
    // "deny phases fail closed" guarantee independent of caller discipline.)
    if (
      DENY_PHASES.has(phase) &&
      TOOL_PHASES.has(phase) &&
      entry.matcher != null &&
      entry.matcher !== '' &&
      ctx.tool == null
    ) {
      return {
        ok: false,
        message: `${phase} hook ${entry.command}: entry has a tool matcher but the phase carries no tool context — refusing to skip a guard hook`,
      };
    }
    if (!entryApplies(phase, entry, ctx.tool)) continue;
    const resolved = resolveHookCommand(entry.command);
    // F07-03: refuse to run a relative hook path. A DENY phase must fail closed (block), so a
    // misconfigured guard hook can never be silently skipped into allowing the action.
    if (resolved.cmd === null) {
      process.stderr.write(`shadow: ${resolved.reason}\n`);
      if (DENY_PHASES.has(phase)) {
        return { ok: false, message: `${phase} hook ${entry.command}: ${resolved.reason}` };
      }
      continue;
    }
    const r = spawnSync(resolved.cmd, [], {
      input: payload,
      encoding: 'utf8',
      cwd: ctx.workspaceRoot,
      timeout: hookTiming.timeoutMs,
      // SIGTERM can be trapped/ignored by the hook; with the default killSignal spawnSync would
      // then WAIT for the child, freezing the only JS thread (and with it the TUI's key handling)
      // indefinitely. SIGKILL cannot be ignored, so the cap is actually enforceable.
      killSignal: 'SIGKILL',
      shell: true,
      env: scrubbedEnv(),
    });
    // A FAILED hook never contributes a verdict or context — its stdout is treated as the error
    // message only (fail-closed: a hook that crashes cannot inject context or approve anything).
    // r.error must count as failure too: on timeout Node sets it while a late-exiting child can
    // still report status 0 — its out-of-window verdict must NOT be honored.
    if (r.error != null || r.status !== 0) {
      const errCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
      const rawMsg = cleanHookText((r.stderr || r.stdout || '').trim());
      const msg =
        rawMsg ||
        (errCode === 'ETIMEDOUT'
          ? `hook timed out after ${Math.round(hookTiming.timeoutMs / 1000)}s (killed)`
          : r.error != null
            ? `hook failed to run (${r.error.message})`
            : `hook exited ${r.status}`);
      // stderr can echo workspace data up to maxBuffer (~1 MB) — clamp before it rides into the
      // model context as the deny message (same discipline as the 8 000-char context cap).
      const clamped =
        msg.length > MAX_HOOK_FAILURE_CHARS
          ? `${msg.slice(0, MAX_HOOK_FAILURE_CHARS)}…(hook error truncated)`
          : msg;
      if (DENY_PHASES.has(phase)) {
        return { ok: false, message: `${phase} hook ${entry.command} failed: ${clamped}` };
      }
      continue;
    }
    const verdict = parseHookStdout(r.stdout ?? '');
    if (verdict.block && DENY_PHASES.has(phase)) {
      return { ok: false, message: `${phase} hook ${entry.command} blocked: ${verdict.block}` };
    }
    if (verdict.context) contexts.push(verdict.context);
  }
  if (!contexts.length) return { ok: true };
  let joined = contexts.join('\n');
  if (joined.length > MAX_HOOK_CONTEXT_CHARS) {
    joined = joined.slice(0, MAX_HOOK_CONTEXT_CHARS) + '\n…(hook context truncated)';
  }
  return { ok: true, context: joined };
}

// Detached hook groups still alive. The 30 s cap timer is unref'd (it must not hold the event
// loop open for a fire-and-forget hook), so it DIES WITH THE PARENT — without this registry a
// session that ends early leaves the hook group running with nothing ever killing it. The
// process-exit handler SIGKILLs every group still tracked, so the cap holds across session exit:
// a detached hook runs at most min(30 s, session lifetime).
const detachedGroups = new Set<number>();
let detachedExitHookInstalled = false;
function trackDetachedGroup(pgid: number): void {
  detachedGroups.add(pgid);
  if (!detachedExitHookInstalled) {
    detachedExitHookInstalled = true;
    process.on('exit', () => {
      for (const g of detachedGroups) {
        try {
          process.kill(-g, 'SIGKILL');
        } catch {
          /* already gone (or the pgid was reused — see the known-race note at the timer) */
        }
      }
    });
  }
}

/**
 * F06-09: fire-and-forget variant for lifecycle phases nothing downstream reads a verdict from
 * (session_start). Same trust rules as runHookPhase — absolute paths only (F07-03), scrubbed env,
 * JSON payload on stdin — but NEVER blocks: the child runs detached + unref'd, capped at 30 s
 * (TERM, then SIGKILL after a grace period; a group still alive when the SESSION ends is SIGKILL'd
 * by the exit registry above). session_start is not a DENY phase, so its synchronicity only ever
 * bought one thing: gating first paint behind every configured init script.
 */
export function runHookPhaseDetached(
  phase: HookPhase,
  entries: HookEntrySpec[],
  ctx: Omit<HookContext, 'phase'>,
): void {
  if (!entries.length) return;
  const payload = JSON.stringify({ ...ctx, phase });
  for (const spec of entries) {
    const entry = normalizeHookEntry(spec);
    if (!entryApplies(phase, entry, ctx.tool)) continue;
    const resolved = resolveHookCommand(entry.command);
    if (resolved.cmd === null) {
      process.stderr.write(`shadow: ${resolved.reason}\n`);
      continue;
    }
    try {
      const child = spawn(resolved.cmd, [], {
        cwd: ctx.workspaceRoot,
        shell: true,
        env: scrubbedEnv(),
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
      });
      // Spawn failures (bad cwd, EMFILE…) surface as ASYNC 'error' events — without a handler
      // that is an uncaught exception that kills the whole session at startup. Same for stdin:
      // a hook that closes its stdin (`exec 0<&-`, or exiting before we write) turns the write
      // into an EPIPE 'error' on the stream. Both are hook problems, not launch failures.
      child.on('error', () => {});
      child.stdin?.on('error', () => {});
      child.stdin?.write(payload);
      child.stdin?.end();
      // detached:true makes the child its own process-group leader — kill the GROUP, so the cap
      // catches whatever the shell spawned, not just the shell itself. Known race: if the group
      // leader dies and the pgid is REUSED within the window, the signal goes to an unrelated
      // group — improbable in a session's lifetime, accepted for the simplicity of -pid.
      const killGroup = (sig: NodeJS.Signals): void => {
        try {
          if (child.pid != null) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          /* group leader gone (or -pid unsupported, e.g. Windows) — fall back to the leader */
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      };
      const killTimer = setTimeout(() => {
        // SIGTERM first (lets a well-behaved hook clean up), then SIGKILL — a TERM-immune group
        // must not outlive the cap either.
        killGroup('SIGTERM');
        const escalate = setTimeout(() => killGroup('SIGKILL'), hookTiming.detachedGraceMs);
        escalate.unref?.();
      }, hookTiming.timeoutMs);
      killTimer.unref?.();
      if (child.pid != null) trackDetachedGroup(child.pid);
      child.on('exit', () => {
        if (child.pid != null) detachedGroups.delete(child.pid);
      });
      child.unref();
    } catch {
      /* a hook that cannot spawn is a config problem, not a launch failure */
    }
  }
}

/** Back-compat wrapper for tool hooks. */
export function runHooks(
  phase: 'pre_tool_use' | 'post_tool_use',
  entries: HookEntrySpec[],
  ctx: Omit<HookContext, 'phase'>,
): HookPhaseResult {
  return runHookPhase(phase, entries, ctx);
}
