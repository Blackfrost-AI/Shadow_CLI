import type { ProviderName } from '../provider/index.js';
import type { ModelEntry } from '../config.js';
import type { PresetEntryExtras } from './catalog.js';
import { loadGlobalConfig, saveGlobalConfig } from '../state/globalStore.js';

export interface OnboardTargetInput {
  provider: ProviderName;
  model?: string;
  baseUrl?: string;
  /** Whether the selected catalog entry is the user-supplied custom endpoint. */
  customEndpoint: boolean;
  /** The user's explicit answer; URL shape is not enough for a public remote server. */
  selfHosted?: boolean;
  /** P1A-06 step 4: contract extras the chosen catalog preset ships (capability block / stream
   *  knobs). When present the target is ALSO persisted as a named ModelEntry — the top-level
   *  patch cannot carry per-entry fields, and bootstrap resolves the active entry by
   *  provider+model match, so the entry is what makes the declared contract real at runtime. */
  entryExtras?: PresetEntryExtras & { label: string };
}

/** Build the common terminal/browser onboarding patch.
 *
 * `selfHosted: undefined` is intentional. The global store merges patches, then JSON
 * serialization removes undefined properties, clearing a marker left by an older target.
 */
export function onboardTargetPatch(input: OnboardTargetInput): Record<string, unknown> {
  return {
    provider: input.provider,
    lastModel: undefined,
    ...(input.model ? { model: input.model } : {}),
    // Include undefined deliberately: saveGlobalConfig is a merge, so omission would retain the
    // previous endpoint and could send the newly selected provider's key to the wrong host.
    baseUrl: input.baseUrl || undefined,
    selfHosted:
      input.provider === 'openai' && input.customEndpoint && input.selfHosted === true
        ? true
        : undefined,
  };
}

/** Upsert (by case-insensitive label) the ModelEntry that carries a preset's contract extras. */
export function presetEntryUpsert(
  models: ModelEntry[],
  input: { provider: ProviderName; model: string; baseUrl?: string; entryExtras: PresetEntryExtras & { label: string } },
): ModelEntry[] {
  const { label, selfHosted, idleTimeoutMs, capabilities } = input.entryExtras;
  const entry: ModelEntry = {
    label,
    provider: input.provider as ModelEntry['provider'],
    model: input.model,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(selfHosted === true ? { selfHosted: true } : {}),
    ...(idleTimeoutMs != null ? { idleTimeoutMs } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
  const idx = models.findIndex((m) => m.label.trim().toLowerCase() === label.trim().toLowerCase());
  // Re-onboarding refreshes the contract fields but keeps anything the user added to the entry
  // (credRef, group, ...) — replacing wholesale would strip their key pointer.
  return idx >= 0 ? models.map((m, i) => (i === idx ? { ...m, ...entry } : m)) : [...models, entry];
}

export function persistOnboardTarget(input: OnboardTargetInput): void {
  const patch = onboardTargetPatch(input);
  if (input.entryExtras && input.model) {
    const models = (loadGlobalConfig().models as ModelEntry[] | undefined) ?? [];
    patch.models = presetEntryUpsert(models, {
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      entryExtras: input.entryExtras,
    });
  }
  saveGlobalConfig(patch);
}
