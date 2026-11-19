/**
 * `/ops` slash-command adapter (plan §9, Phase 4) — shared by BOTH renderers.
 *
 * The command body is identical in Snowfall (app.ts) and Ink (slash.ts): route the
 * argument through the operator-origin sync handler and push every outcome through the
 * renderer's line adapter. Extracted here so neither shell grows (app.ts line budget)
 * and the two renderers cannot drift.
 */
export interface OpsCommandAdapter {
  /** Push one output line; `o?.error` renders as an error line. */
  pushLine: (text: string, o?: { error?: boolean }) => void;
}

/** Runs `/ops <arg>` through the session's ops handler. Never throws. */
export function runOpsSlashCommand(
  opsCommand: ((arg: string, push: (text: string, o?: { error?: boolean }) => void) => void) | undefined,
  arg: string,
  adapter: OpsCommandAdapter,
): void {
  if (!opsCommand) {
    adapter.pushLine('Ops controls unavailable in this session.');
    return;
  }
  opsCommand(arg, (text, o) => adapter.pushLine(text, o));
}

/**
 * Builds a renderer adapter from its own pushLine. Generic over the renderer's partial
 * line type so each shell keeps its exact `kind`/`color` unions — no drift, no widening.
 * `prefix` selects the shell's indentation style ('' for Ink, two spaces for Snowfall).
 */
export function makeOpsAdapter<L extends { text: string }>(
  pushLine: (partial: L) => void,
  opts: { prefix: string; errorColor: string },
): OpsCommandAdapter {
  return {
    pushLine: (text, o) =>
      pushLine(
        (o?.error
          ? { kind: 'error', text: `${opts.prefix}${text}`, color: opts.errorColor }
          : { kind: 'system', text: `${opts.prefix}${text}`, dimColor: true }) as unknown as L,
      ),
  };
}
