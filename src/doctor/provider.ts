import { resolveBaseUrl, resolveEntryCredential, type ShadowConfig } from '../config.js';
import { vaultExists } from '../auth/vault.js';
import { vaultUnlocked } from '../state/globalStore.js';
import { findRememberedModelPreset, resolveActiveModelPreset } from '../config/modelPresets.js';
import type { ModelEntry } from '../config.js';

/** Inspect setup without contacting a model, starting a server, or unlocking credentials. */
export function providerDiagnostic(cfg: ShadowConfig): { ok: boolean; detail: string } {
  const recallLast = !process.env.SHADOW_MODEL && !process.env.SHADOW_PROVIDER &&
    !process.env.SHADOW_BASE_URL && cfg.profile?.model == null;
  const remembered = recallLast ? findRememberedModelPreset(cfg) : undefined;
  // `/model` is an atomic target selection. Diagnostics often receive the intentionally-stale
  // top-level keys from an older config, so apply the remembered tuple before endpoint matching.
  // The resolver can still detach endpoint-bound credentials/capabilities when an environment
  // fallback points that provider at a different URL.
  const target = remembered ? {
    ...cfg,
    provider: remembered.provider,
    model: remembered.model,
    baseUrl: remembered.baseUrl,
    connection: remembered.connection,
  } : cfg;
  let entry: ModelEntry | undefined;
  try {
    entry = resolveActiveModelPreset(target, { lastPicked: remembered });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'The selected model connection is invalid.' };
  }
  const provider = remembered?.provider ?? entry?.provider ?? target.provider;
  const model = remembered?.model ?? entry?.model ?? target.model;
  const name = `${provider} / ${model}`;
  if (provider === 'mock') return { ok: true, detail: `${name} — offline demo provider` };
  const connection = remembered ? remembered.connection : entry ? entry.connection : target.connection;
  if (connection) return { ok: true, detail: `${name} — ${connection.kind === 'chatgpt' ? 'ChatGPT account' : 'official Claude Code subscription'} configured (sign-in and connection not tested)` };

  const locked = vaultExists() && !vaultUnlocked();
  const credential = resolveEntryCredential(entry ?? { provider }, { vaultIsLocked: locked });
  if (!credential.ok) {
    return {
      ok: false,
      detail: `${name} — ${credential.reason === 'locked'
        ? 'credential vault is locked; unlock it when starting Shadow'
        : 'the selected model’s credential is missing; run `shadow onboard --web`'}`,
    };
  }
  const backend = entry?.gguf ? 'llama.cpp' : entry?.mlx ? 'MLX' : entry?.vllm ? 'vLLM' : null;
  if (backend) {
    return { ok: true, detail: `${name} — managed ${backend} model; no API key required (not started)` };
  }
  const baseUrl = resolveBaseUrl(provider, remembered ? remembered.baseUrl : entry?.baseUrl ?? target.baseUrl, connection);
  if (baseUrl) {
    // origin omits userinfo; query and fragment may contain credentials, so omit them too.
    const url = new URL(baseUrl);
    return { ok: true, detail: `${name} — ${url.origin}${url.pathname} (connection not tested)` };
  }
  if (credential.apiKey || credential.authToken) {
    return { ok: true, detail: `${name} — credentials available (connection not tested)` };
  }
  return {
    ok: false,
    detail: locked
      ? `${name} — vault is locked; credentials cannot be checked until you start Shadow`
      : 'No model endpoint or credentials configured — run `shadow onboard`',
  };
}
