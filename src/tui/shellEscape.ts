import { rejectUnsafeShellInput } from './shellEscapeCore.js';

export { rejectUnsafeShellInput };

export const SHELL_ESCAPE_COMMAND = '/!';

export interface ShellEscapeEnv {
  /** Live busy state — every one of these refuses a shell escape. */
  busy: () => boolean;
  /** Present the operator with an error line (renderer transcript/toast). */
  errorLine: (text: string) => void;
  /** Present the outcome line in the renderer transcript. */
  outcomeLine: (text: string, ok: boolean) => void;
  /** Clear the composer draft (called only after every rejection has passed). */
  clearComposer: () => void;
  /** Arm the abort controller and ALL live-turn state (running flag, run clock, ticker)
   * exactly like a native feature execution; the renderer's own finally owns cleanup. */
  armAbort: (controller: AbortController) => void;
  /** Acquire the process-wide run lock with terminal priority. Returns release. */
  acquireLock: (signal: AbortSignal) => Promise<() => void>;
  /** The host's native tool executor: run_shell through the COMPLETE policy pipeline. */
  runNativeTool: (name: string, input: unknown, signal: AbortSignal, budget: unknown) => Promise<{ ok: boolean; summary: string }>;
  /** Zero-iteration budget for the native loop (this path makes no provider request). */
  newBudget: () => unknown;
}

/**
 * Dispatch ONE explicit operator shell command through the full execution-policy pipeline.
 *
 * Rejections happen in order, cheapest first, and NONE of them ever reaches the pipeline:
 *  1. unsafe input (empty/paste/multiline) — rejected before any state changes;
 *  2. busy state — no shell escapes while a turn/compaction/model-switch runs.
 *
 * There are NO retries: one dispatch, one result. ESC aborts the child shell through the
 * host's abort wiring (armAbort), and the renderer's finally block — the same cleanup path
 * as every native feature execution — owns state restoration. Cleanup must NOT be done in
 * this module: the renderer's end-of-turn logic reads the live controller to report an
 * interruption honestly.
 */
export async function runShellEscape(env: ShellEscapeEnv, raw: string): Promise<void> {
  const verdict = rejectUnsafeShellInput(raw);
  if (!verdict.ok) {
    if (verdict.reason) env.errorLine(verdict.reason);
    return;
  }
  const command = verdict.command!;
  if (env.busy()) {
    env.errorLine('Finish the current operation before starting a shell command.');
    return;
  }
  env.clearComposer();
  const controller = new AbortController();
  env.armAbort(controller);
  let release: (() => void) | undefined;
  try {
    release = await env.acquireLock(controller.signal);
    const result = await env.runNativeTool(
      'run_shell',
      { command, description: 'Operator shell escape (/!)' },
      controller.signal,
      env.newBudget(),
    );
    env.outcomeLine(result.ok ? `shell ok: ${result.summary}` : `shell failed: ${result.summary}`, result.ok);
  } catch (error) {
    if (!controller.signal.aborted) env.errorLine(`shell escape failed: ${(error as Error).message}`);
  } finally {
    release?.();
  }
}
