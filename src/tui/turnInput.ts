// Turn-input assembly for the TUI's runOne seam (8.4). Background sub-agent results
// accumulate in a PendingNotifications queue (attachBgAgentDelivery, index.ts) and are
// folded into the NEXT user turn HERE — and only here. Draining anywhere else (mid-turn,
// on a timer) could append a user message between an assistant tool_use and its
// tool_result and 400 the session permanently; that constraint is why this is a named
// helper rather than an inline expression.

/**
 * Merge drained bg-agent notifications into the task text. Headless does the identical
 * thing at its own turn-build seam (index.ts runTurnBody) — this is the TUI twin.
 */
export function drainTurnInput(task: string, pending: { drain(): string[] } | undefined): string {
  const notifications = pending?.drain() ?? [];
  return notifications.length ? `${notifications.join('\n')}\n${task}` : task;
}
