import type { ProviderName } from '../provider/index.js';
import type { ModelEntry } from '../config.js';
import type { PresetEntryExtras } from './catalog.js';
import { loadGlobalConfig, saveGlobalConfig } from '../state/globalStore.js';
import { isLocalBaseUrl } from '../safety/offline.js';
import { SELF_HOSTED_DEFAULT_IDLE_MS } from '../provider/stream.js';

/** T2 onboarding resilience: self-hosted/local entries default to a loose idle budget (long
 *  prefill keeps SSE silent well past the 120s public-API default), a generous first-byte
 *  budget (vLLM/SGLang flush headers before prefill completes), and a high retry ceiling
 *  (busy serves 5xx during queue storms). A catalog preset's own declared knob wins verbatim. */
export const ONBOARD_SELF_HOSTED_DEFAULTS = {
  idleTimeoutMs: SELF_HOSTED_DEFAULT_IDLE_MS,
  firstByteTimeoutMs: 600_000,
  streamRetries: 8,
} as const;

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
  /** Models explicitly selected from discovery/recommendations. When present, onboarding owns
   * exactly this allowlist for the endpoint and exposes each one in Shadow's model picker. */
  selectedModels?: string[];
  /** Picker group for selected models (normally the catalog provider label). */
  entryGroup?: string;
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

/** True when the onboarding target is a self-hosted-class endpoint: the user said yes, or the
 *  URL is local/LAN. These get the T2 resilience knobs stamped onto their carrier entry. */
export function isSelfHostedTarget(
  input: Pick<OnboardTargetInput, 'selfHosted' | 'baseUrl'>,
): boolean {
  return input.selfHosted === true || isLocalBaseUrl(input.baseUrl);
}

/** Upsert (by case-insensitive label) the ModelEntry that carries a preset's contract extras. */
export function presetEntryUpsert(
  models: ModelEntry[],
  input: {
    provider: ProviderName;
    model: string;
    baseUrl?: string;
    entryExtras: PresetEntryExtras & { label: string };
  },
): ModelEntry[] {
  const { label, selfHosted, idleTimeoutMs, capabilities } = input.entryExtras;
  const selfHostedEntry = selfHosted === true || isLocalBaseUrl(input.baseUrl);
  const entry: ModelEntry = {
    label,
    provider: input.provider as ModelEntry['provider'],
    model: input.model,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    // Explicit undefined clears a stale trust marker when an existing entry is refreshed as hosted.
    selfHosted: selfHosted === true ? true : undefined,
    ...(capabilities ? { capabilities } : {}),
    // T2 resilience knobs: the preset's declared idle budget wins verbatim; otherwise a
    // self-hosted-class entry gets the loose default set. undefined fields are dropped by
    // JSON serialization, so public presets keep the strict built-in budgets unchanged.
    ...(selfHostedEntry
      ? {
          idleTimeoutMs: idleTimeoutMs ?? ONBOARD_SELF_HOSTED_DEFAULTS.idleTimeoutMs,
          firstByteTimeoutMs: ONBOARD_SELF_HOSTED_DEFAULTS.firstByteTimeoutMs,
          streamRetries: ONBOARD_SELF_HOSTED_DEFAULTS.streamRetries,
        }
      : idleTimeoutMs != null
        ? { idleTimeoutMs }
        : {}),
  };
  const idx = models.findIndex((m) => m.label.trim().toLowerCase() === label.trim().toLowerCase());
  // Re-onboarding refreshes the contract fields but keeps anything the user added to the entry
  // (credRef, group, ...) — replacing wholesale would strip their key pointer.
  return idx >= 0 ? models.map((m, i) => (i === idx ? { ...m, ...entry } : m)) : [...models, entry];
}

function sameEndpoint(a: string | undefined, b: string | undefined): boolean {
  const normalize = (value: string | undefined): string =>
    (value ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

function selectedEntryLabel(
  models: ModelEntry[],
  input: { provider: ProviderName; model: string; baseUrl?: string },
): string {
  const managed = models.find(
    (entry) =>
      entry.onboarded === true &&
      entry.provider === input.provider &&
      entry.model === input.model &&
      sameEndpoint(entry.baseUrl, input.baseUrl),
  );
  if (managed) return managed.label;
  const direct = models.find(
    (entry) => entry.label.trim().toLowerCase() === input.model.trim().toLowerCase(),
  );
  if (
    !direct ||
    (direct.provider === input.provider &&
      direct.model === input.model &&
      sameEndpoint(direct.baseUrl, input.baseUrl))
  ) {
    return input.model;
  }
  let host: string = input.provider;
  try {
    host = input.baseUrl ? new URL(input.baseUrl).host : input.provider;
  } catch {
    /* use the adapter name */
  }
  const stem = `${input.model} (${host})`;
  let label = stem;
  let suffix = 2;
  while (models.some((entry) => entry.label.trim().toLowerCase() === label.toLowerCase())) {
    label = `${stem} ${suffix++}`;
  }
  return label;
}

/** Reconcile only entries created by onboarding for this exact endpoint; manual presets survive. */
export function onboardModelSelectionUpsert(
  models: ModelEntry[],
  input: OnboardTargetInput,
): ModelEntry[] {
  const selected = [
    ...new Set((input.selectedModels ?? []).map((model) => model.trim()).filter(Boolean)),
  ];
  if (selected.length === 0) return models;
  let next = models.filter(
    (entry) =>
      !(
        entry.onboarded === true &&
        entry.provider === input.provider &&
        sameEndpoint(entry.baseUrl, input.baseUrl) &&
        !selected.includes(entry.model)
      ),
  );
  for (const model of selected) {
    // A matching hand-written preset already exposes this selection. Use it as-is instead of
    // taking ownership; otherwise a later onboarding run could delete a user's manual entry.
    const manual = next.find(
      (entry) =>
        entry.onboarded !== true &&
        entry.provider === input.provider &&
        entry.model === model &&
        sameEndpoint(entry.baseUrl, input.baseUrl),
    );
    if (manual) continue;
    const label = selectedEntryLabel(next, {
      provider: input.provider,
      model,
      baseUrl: input.baseUrl,
    });
    const extras: PresetEntryExtras & { label: string } = {
      // A preset's special model contract belongs to its selected default only. Other models on
      // the same endpoint still receive generic self-hosted resilience through the URL/marker.
      ...(model === input.model && input.entryExtras ? input.entryExtras : {}),
      ...(input.selfHosted === true ? { selfHosted: true } : {}),
      label,
    };
    next = presetEntryUpsert(next, {
      provider: input.provider,
      model,
      baseUrl: input.baseUrl,
      entryExtras: extras,
    });
    next = next.map((entry) =>
      entry.label === label
        ? {
            ...entry,
            onboarded: true,
            ...(input.entryGroup ? { group: input.entryGroup } : {}),
          }
        : entry,
    );
  }
  return next;
}

export function persistOnboardTarget(input: OnboardTargetInput): void {
  const patch = onboardTargetPatch(input);
  const models = (loadGlobalConfig().models as ModelEntry[] | undefined) ?? [];
  if (input.selectedModels?.length) {
    const selectedEntries = onboardModelSelectionUpsert(models, input);
    patch.models = selectedEntries;
    // Pin the explicitly chosen default by label. Matching only provider+model is ambiguous when
    // two custom endpoints expose the same id; lastModel carries the selected endpoint atomically.
    patch.lastModel = selectedEntries.find(
      (entry) =>
        entry.provider === input.provider &&
        entry.model === input.model &&
        sameEndpoint(entry.baseUrl, input.baseUrl),
    )?.label;
  } else if (input.entryExtras && input.model) {
    patch.models = presetEntryUpsert(models, {
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      entryExtras: input.entryExtras,
    });
  } else if (input.model && isSelfHostedTarget(input)) {
    // T2: a custom/local self-hosted target onboarded WITHOUT catalog contract extras still
    // gets a carrier entry — the top-level patch cannot hold per-entry fields, and without a
    // carrier the resilience knobs never reach the wire (the blank-config 120s timeouts).
    patch.models = presetEntryUpsert(models, {
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      entryExtras: {
        label: input.model,
        ...(input.selfHosted === true ? { selfHosted: true } : {}),
      },
    });
  }
  saveGlobalConfig(patch);
}
