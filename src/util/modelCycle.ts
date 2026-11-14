/**
 * Ctrl+P quick model cycling (11.7.0, OMP --models parity). Pure helpers so the cycling
 * logic unit-tests without a terminal. The allowlist is a list of model labels; when it is
 * empty the cycle falls back to every enabled configured model.
 */
import type { ModelEntry, ShadowConfig } from '../config.js';
import { modelEntries } from './modelGroups.js';

/**
 * The ordered cycle list: enabled configured models filtered to the allowlist labels
 * (case-insensitive). An empty/undefined allowlist means "all enabled models". Labels in
 * the allowlist that match no configured model are ignored (they can't be switched to).
 */
export function cycleEntries(cfg: ShadowConfig, allowlist?: string[]): ModelEntry[] {
  const enabled = modelEntries(cfg);
  if (!allowlist || allowlist.length === 0) return enabled;
  const wanted = new Set(allowlist.map((s) => s.toLowerCase()));
  return enabled.filter((e) => wanted.has(e.label.toLowerCase()));
}

/**
 * The next entry after `currentLabel` in `entries`, wrapping at the end. When the current
 * label is not in the list (or empty), returns the first entry. Returns undefined for an
 * empty list. Single-entry lists return that entry (a no-op cycle).
 */
export function nextCycleEntry(entries: ModelEntry[], currentLabel: string): ModelEntry | undefined {
  if (entries.length === 0) return undefined;
  const idx = entries.findIndex((e) => e.label === currentLabel);
  if (idx < 0) return entries[0];
  return entries[(idx + 1) % entries.length];
}