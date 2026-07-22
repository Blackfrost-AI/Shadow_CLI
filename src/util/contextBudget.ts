/**
 * Clamp the agent context budget so auto-compaction fires BEFORE a local server
 * rejects the request (e.g. llama.cpp / vLLM "request exceeds available context size").
 *
 * `contextBudget` in config is a soft target (default 128k). When we KNOW the server
 * window (`ctx` / max-model-len), soft budget is ~72% of that so compact fires under
 * the hard ceiling.
 *
 * When the window is UNKNOWN: do NOT invent 32k. LAN 70B–700B+ serves often run
 * 128k–512k; inventing 32k made those thrash compact and feel "broken". Trust
 * `configured` until a real `ctx` is set on the model preset.
 */

/**
 * Soft context budget for a local model.
 * @param configured - user/config budget (e.g. 128_000)
 * @param ctxWindow - server window from the model entry / launcher. Omit when unknown.
 */
export function clampLocalContextBudget(configured: number, ctxWindow?: number): number {
  if (!ctxWindow || ctxWindow <= 0) {
    // Unknown window — leave configured alone (128k default / user override).
    return configured;
  }
  // Leave a little room so a final request can't fill the entire window with history alone.
  const hard = Math.max(6_144, ctxWindow - 1_536);
  // Soft target: compact well under the hard limit.
  const soft = Math.max(4_096, Math.floor(hard * 0.72));
  return Math.min(configured, soft);
}

/** Recommended keepLastTurns for a given soft budget (smaller windows keep less tail). */
export function keepLastTurnsForBudget(budget: number, configuredKeep: number): number {
  if (budget <= 16_000) return Math.min(configuredKeep, 4);
  if (budget <= 40_000) return Math.min(configuredKeep, 6);
  return configuredKeep;
}

/** Trigger ratio: fire earlier on small windows so one fat tool result can't overshoot. */
export function triggerRatioForBudget(budget: number, configured: number): number {
  if (budget <= 40_000) return Math.min(configured, 0.8);
  return configured;
}
