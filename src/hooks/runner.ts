import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

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
    const cmd = script.startsWith('/') ? script : resolve(ctx.workspaceRoot, script);
    const r = spawnSync(cmd, [], {
      input: payload,
      encoding: 'utf8',
      cwd: ctx.workspaceRoot,
      timeout: 30_000,
      shell: true,
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

/** Back-compat wrapper for tool hooks. */
export function runHooks(
  phase: 'pre_tool_use' | 'post_tool_use',
  scripts: string[],
  ctx: Omit<HookContext, 'phase'>,
): { ok: boolean; message?: string } {
  return runHookPhase(phase, scripts, ctx);
}