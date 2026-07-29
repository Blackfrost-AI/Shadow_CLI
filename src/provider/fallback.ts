/** Classify provider/API errors that should trigger a session model fallback (the reference client parity). */
export function isFallbackEligible(code: string, message: string, httpStatus?: number): boolean {
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
