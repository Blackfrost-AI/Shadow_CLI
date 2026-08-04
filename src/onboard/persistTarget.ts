import type { ProviderName } from '../provider/index.js';
import { saveGlobalConfig } from '../state/globalStore.js';

export interface OnboardTargetInput {
  provider: ProviderName;
  model?: string;
  baseUrl?: string;
  /** Whether the selected catalog entry is the user-supplied custom endpoint. */
  customEndpoint: boolean;
  /** The user's explicit answer; URL shape is not enough for a public remote server. */
  selfHosted?: boolean;
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

export function persistOnboardTarget(input: OnboardTargetInput): void {
  saveGlobalConfig(onboardTargetPatch(input));
}
