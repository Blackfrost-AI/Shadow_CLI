import { isLocalBaseUrl } from '../safety/offline.js';

/**
 * Error codes that mean "we reached the provider and it was merely slow or dropped the connection
 * mid-read" — the opposite of "this model/provider is unavailable". A fallback re-sends the ENTIRE
 * conversation to a different entry, so it should be reserved for real unavailability. A stall is
 * ridden out (the P1A-04 watchdog/retry knobs), not escaped.
 *
 * F01-02: the P1A-04 idle message literally includes the word "overloaded"
 * ("no response within Ns — the model may be overloaded or the connection stalled"), and the old
 * `m.includes('overloaded')` substring match treated that as a genuine overload — silently swapping
 * the user onto a different model mid-task and, privacy-first, shipping the whole history elsewhere.
 * These codes are checked BEFORE any message sniffing so a stall never falls through to that trap.
 */
const STALL_CLASS_CODES = new Set(['idle_timeout', 'network_error', 'empty_body', 'stream_error']);

/** Classify provider/API errors that should trigger a session model fallback (the reference client parity). */
export function isFallbackEligible(code: string, message: string, httpStatus?: number): boolean {
  if (STALL_CLASS_CODES.has(code.toLowerCase())) return false;
  const m = message.toLowerCase();
  if (httpStatus === 529 || httpStatus === 503 || httpStatus === 502) return true;
  if (code === 'overloaded' || code === 'server_error') return true;
  if (m.includes('model_not_found') || m.includes('not found')) return true;
  if (m.includes('permission_denied') || m.includes('permission denied')) return true;
  if (m.includes('overloaded')) return true;
  return false;
}

export interface ModelEntryLike {
  label: string;
  provider: string;
  model: string;
  baseUrl?: string;
  /** Explicit marker for a self-hosted/local endpoint (P1A-05: gates automatic fallback opt-in). */
  selfHosted?: boolean;
  fallback?: string;
  disabled?: boolean;
}

/** Resolve the fallback model id for the active entry, then global default. */
export function resolveFallbackModel(
  currentModel: string,
  entries: ModelEntryLike[],
  globalFallback?: string,
): string | null {
  const entry = entries.find((e) => e.model === currentModel);
  if (entry?.fallback) return entry.fallback;
  if (globalFallback && globalFallback !== currentModel) return globalFallback;
  const alt = entries.find((e) => e.model !== currentModel && !e.disabled);
  return alt?.model ?? null;
}

/** Resolve the complete destination entry; provider/base URL/credentials are part of a fallback. */
export function resolveFallbackEntry<T extends ModelEntryLike>(
  currentModel: string,
  entries: T[],
  globalFallback?: string,
): T | null {
  const current = entries.find((entry) => entry.model === currentModel);
  /** A local / explicitly self-hosted source must declare fallback ON ITS OWN ENTRY before we
   * ever switch providers. Privacy: a one-off stall on a local serve must not silently hand the
   * whole history to an arbitrary other entry (e.g. a cloud API) the user happens to keep
   * configured. Opt-in only — neither the global fallback nor the any-other-entry path may fire. */
  const sourceIsSelfHosted =
    current !== undefined && (current.selfHosted === true || isLocalBaseUrl(current.baseUrl));
  if (sourceIsSelfHosted && !current.fallback) return null;
  const requested = current?.fallback ?? globalFallback;
  if (requested) {
    const exact = entries.find(
      (entry) => !entry.disabled && entry.model !== currentModel && (entry.model === requested || entry.label === requested),
    );
    if (exact) return exact;
  }
  return entries.find((entry) => !entry.disabled && entry.model !== currentModel) ?? null;
}

export function isModelDisabled(model: string, entries: ModelEntryLike[]): boolean {
  const entry = entries.find((e) => e.model === model);
  return entry?.disabled === true;
}
