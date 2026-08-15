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
 * Run configured hook scripts for a lifecycle phase. Non-zero exit on deny phases
 * blocks the action. Hooks receive JSON on stdin: { phase, workspaceRoot, ... }.
 */
export function runHookPhase(
  phase: HookPhase,
  scripts: string[],
  ctx: Omit<HookContext, 'phase'>,
): { ok: boolean; message?: string } {
  if (!scripts.length) return { ok: true };
  const payload = JSON.stringify({ ...ctx, phase });
  for (const script of scripts) {
    const resolved = resolveHookCommand(script);
    // F07-03: refuse to run a relative hook path. A DENY phase must fail closed (block), so a
    // misconfigured guard hook can never be silently skipped into allowing the action.
    if (resolved.cmd === null) {
      process.stderr.write(`shadow: ${resolved.reason}\n`);
      if (DENY_PHASES.has(phase)) {
        return { ok: false, message: `${phase} hook ${script}: ${resolved.reason}` };
      }
      continue;
    }
    const r = spawnSync(resolved.cmd, [], {
      input: payload,
      encoding: 'utf8',
      cwd: ctx.workspaceRoot,
      timeout: 30_000,
      shell: true,
      env: scrubbedEnv(),
    });
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || `hook exited ${r.status}`).trim();
      if (DENY_PHASES.has(phase)) {
        return { ok: false, message: `${phase} hook ${script} failed: ${msg}` };
      }
    }
  }
  return { ok: true };
}

/**
 * F06-09: fire-and-forget variant for lifecycle phases nothing downstream reads a verdict from
 * (session_start). Same trust rules as runHookPhase — absolute paths only (F07-03), scrubbed env,
 * JSON payload on stdin — but NEVER blocks: the child runs detached + unref'd, capped at 30s.
 * session_start is not a DENY phase, so its synchronicity only ever bought one thing: gating
 * first paint behind every configured init script.
 */
export function runHookPhaseDetached(
  phase: HookPhase,
  scripts: string[],
  ctx: Omit<HookContext, 'phase'>,
): void {
  if (!scripts.length) return;
  const payload = JSON.stringify({ ...ctx, phase });
  for (const script of scripts) {
    const resolved = resolveHookCommand(script);
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
      const killTimer = setTimeout(() => {
        try {
          // detached:true makes the child its own process-group leader — kill the GROUP, so the
          // 30s cap catches whatever the shell spawned, not just the shell itself.
          if (child.pid != null) process.kill(-child.pid, 'SIGTERM');
          else child.kill();
        } catch {
          /* already gone (or the group leader died and -pid is invalid — fall back) */
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }
      }, 30_000);
      killTimer.unref?.();
      child.unref();
    } catch {
      /* a hook that cannot spawn is a config problem, not a launch failure */
    }
  }
}

/** Back-compat wrapper for tool hooks. */
export function runHooks(
  phase: 'pre_tool_use' | 'post_tool_use',
  scripts: string[],
  ctx: Omit<HookContext, 'phase'>,
): { ok: boolean; message?: string } {
  return runHookPhase(phase, scripts, ctx);
}
