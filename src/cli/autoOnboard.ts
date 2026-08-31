/**
 * The first-run "auto-launch the onboard wizard" decision. Pure so it can be
 * unit-tested without touching TTYs/flags/config (see test/auto-onboard.test.ts).
 *
 * Auto-onboard fires only for a genuine interactive first run: no provider
 * configured, BOTH stdin and stdout are TTYs, and we're not in a one-shot /
 * headless mode (`--task` prompt or `--repl` — the same modes `main()` lumps
 * into `headless`). Anything else keeps the stderr hint + exit path.
 */
export interface AutoOnboardInput {
  /** True when a usable provider/model is already configured. */
  configured: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  /** One-shot prompt mode (`--task <prompt>`) — output is consumed by a script. */
  taskMode: boolean;
  /** Plain-text REPL mode (`--repl`) — headless in the startup flow. */
  replMode: boolean;
}

export function shouldAutoOnboard(i: AutoOnboardInput): boolean {
  if (i.configured) return false;
  if (i.taskMode || i.replMode) return false;
  return i.stdinIsTTY && i.stdoutIsTTY;
}

/** stderr hint shown when no provider is configured and the wizard can't run. */
export const NO_PROVIDER_HINT = 'No model provider configured. Run `shadow onboard` to set one up.';
