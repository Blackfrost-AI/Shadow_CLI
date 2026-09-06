import { resolveBaseUrl, resolveEntryCredential, type ShadowConfig } from '../config.js';
import { vaultExists } from '../auth/vault.js';
import { vaultUnlocked } from '../state/globalStore.js';

/** Inspect setup without contacting a model, starting a server, or unlocking credentials. */
export function providerDiagnostic(cfg: ShadowConfig): { ok: boolean; detail: string } {
  const recalled =
    !process.env.SHADOW_MODEL && !process.env.SHADOW_PROVIDER && cfg.profile?.model == null
      ? cfg.models.find((m) => m.label === cfg.lastModel)
      : undefined;
  const provider = recalled?.provider ?? cfg.provider;
  const model = recalled?.model ?? cfg.model;
  const entry = recalled ?? cfg.models.find((m) => m.provider === provider && m.model === model);
  const name = `${provider} / ${model}`;
  if (provider === 'mock') return { ok: true, detail: `${name} — offline demo provider` };

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
  const baseUrl = resolveBaseUrl(provider, entry?.baseUrl ?? (recalled ? recalled.baseUrl : cfg.baseUrl));
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
