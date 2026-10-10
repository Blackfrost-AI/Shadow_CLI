import {
  normalizeBaseUrl,
  resolveBaseUrl,
  type AccountConnection,
  type ModelEntry,
  type ShadowConfig,
} from '../config.js';

const PROVIDERS = ['anthropic', 'openai', 'mock'] as const;

type ModelProvider = (typeof PROVIDERS)[number];

export type PresetResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isModelProvider(value: string): value is ModelProvider {
  return (PROVIDERS as readonly string[]).includes(value);
}

function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function ensureUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function splitPresetArgs(raw: string): PresetResult<string[]> {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (escaped) return { ok: false, message: 'Trailing escape in command.' };
  if (quote) return { ok: false, message: `Unclosed ${quote} quote.` };
  if (cur) out.push(cur);
  return { ok: true, value: out };
}

export function parseModelAddArgs(tokens: string[]): PresetResult<ModelEntry> {
  const label = tokens[1] ?? '';
  const provider = tokens[2] ?? '';
  const model = tokens[3] ?? '';
  if (!label || !provider || !model) {
    return {
      ok: false,
      message:
        'Usage: /model add <label> <provider> <model> [baseUrl] [--group <name>] [--self-hosted]',
    };
  }
  if (!isModelProvider(provider)) {
    return { ok: false, message: `Provider must be one of: ${PROVIDERS.join(', ')}` };
  }
  let baseUrl: string | undefined;
  let group: string | undefined;
  let selfHosted = false;
  for (let i = 4; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--base-url' || token === '--baseUrl') {
      baseUrl = tokens[++i];
      if (!baseUrl) return { ok: false, message: 'Missing value after --base-url.' };
      continue;
    }
    if (token === '--group') {
      group = tokens[++i];
      if (!group) return { ok: false, message: 'Missing value after --group.' };
      continue;
    }
    if (token === '--self-hosted' || token === '--selfHosted') {
      selfHosted = true;
      continue;
    }
    if (!baseUrl) {
      baseUrl = token;
      continue;
    }
    return { ok: false, message: `Unknown /model add argument: ${token}` };
  }
  if (baseUrl && !ensureUrl(baseUrl)) return { ok: false, message: 'baseUrl must be an http(s) URL.' };
  if (selfHosted && provider !== 'openai') {
    return { ok: false, message: '--self-hosted is only valid for OpenAI-compatible presets.' };
  }
  return {
    ok: true,
    value: {
      label,
      provider,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(group ? { group } : {}),
      ...(selfHosted ? { selfHosted: true } : {}),
    },
  };
}

export function addModelPreset(models: ModelEntry[], entry: ModelEntry): PresetResult<ModelEntry[]> {
  if (models.some((m) => sameLabel(m.label, entry.label))) {
    return { ok: false, message: `Model "${entry.label}" already exists.` };
  }
  return { ok: true, value: [...models, entry] };
}

export function findModelPreset(models: ModelEntry[], label: string): ModelEntry | undefined {
  return models.find((m) => sameLabel(m.label, label));
}

/**
 * Presets eligible for implicit startup recall. loadConfig records the validated global list
 * before a project-local models[] array can replace it. Missing provenance fails closed: direct
 * callers may still use cfg.models for explicit/picker resolution, but never for automatic recall.
 */
export function trustedModelPresets(
  cfg: Pick<ShadowConfig, 'models' | 'trustedGlobalModelPresets'>,
): ModelEntry[] {
  return cfg.trustedGlobalModelPresets ?? [];
}

/** A remembered picker label is automatic state, so only a trusted global preset may satisfy it. */
export function findRememberedModelPreset(
  cfg: Pick<ShadowConfig, 'models' | 'trustedGlobalModelPresets' | 'lastModel'>,
): ModelEntry | undefined {
  return cfg.lastModel ? findModelPreset(trustedModelPresets(cfg), cfg.lastModel) : undefined;
}

function sameConnection(a: AccountConnection | undefined, b: AccountConnection | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && (a.kind !== 'chatgpt' || (b.kind === 'chatgpt' && a.profileId === b.profileId));
}

const PROVIDER_DEFAULT_ENDPOINT: Partial<Record<ModelProvider, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

/** Canonical endpoint identity. An omitted API base means the provider's official endpoint. */
function endpointIdentity(provider: ModelProvider, value: string | undefined): string | undefined {
  const normalized = normalizeBaseUrl(value) ?? PROVIDER_DEFAULT_ENDPOINT[provider];
  if (!normalized) return undefined;
  // A trailing slash does not name a different API root. URL canonicalization also makes host
  // casing/default ports compare consistently without weakening path identity (/v1 != /v2).
  return `${provider}:${new URL(normalized).toString().replace(/\/+$/, '')}`;
}

/**
 * API-preset metadata and credentials are valid only for the endpoint that declared them.
 *
 * The target side is the endpoint a real request would use: explicit config first, then the
 * provider-specific environment variable, then the credential store. The preset side deliberately
 * does not inherit those fallbacks: an entry with no base URL describes the provider's canonical
 * endpoint, so a process-level custom endpoint cannot borrow that entry's key/capabilities.
 */
function sameEffectiveEndpoint(
  entry: ModelEntry,
  cfg: Pick<ShadowConfig, 'provider' | 'baseUrl' | 'connection'>,
): boolean {
  const selected = entry.connection
    ? resolveBaseUrl(entry.provider, entry.baseUrl, entry.connection)
    : entry.baseUrl;
  const effective = resolveBaseUrl(cfg.provider, cfg.baseUrl, cfg.connection);
  return endpointIdentity(entry.provider, selected) === endpointIdentity(cfg.provider, effective);
}

/** Account presets own their transport and intentionally ignore provider-specific API endpoint
 * fallbacks such as OPENAI_BASE_URL. Only the generic configured target (`--base-url` /
 * SHADOW_BASE_URL, already folded into cfg.baseUrl) can detach an otherwise matching account. */
function accountEndpointCompatible(
  entry: ModelEntry,
  cfg: Pick<ShadowConfig, 'provider' | 'baseUrl'>,
): boolean {
  const explicit = normalizeBaseUrl(cfg.baseUrl);
  if (!explicit) return true;
  const selected = resolveBaseUrl(entry.provider, entry.baseUrl, entry.connection);
  return endpointIdentity(entry.provider, selected) === endpointIdentity(cfg.provider, explicit);
}

/** Run before probes, local launchers or credential imports can act on a mixed preset. */
export function assertAccountPresetCompatible(entry: ModelEntry): void {
  const connection = entry.connection;
  if (connection && entry.provider !== (connection.kind === 'chatgpt' ? 'openai' : 'anthropic')) {
    throw new Error('The selected subscription connection does not match this provider. Choose an API or subscription preset with /model or --profile instead of overriding its provider.');
  }
  if (connection && (entry.autoModel || entry.gguf || entry.mlx || entry.vllm)) {
    throw new Error('Subscription presets cannot use local model launchers or automatic endpoint discovery. Choose a separate API or local model preset.');
  }
}

/** Resolve a connection before looking up credentials. Model IDs alone are not billing identities. */
export function resolveActiveModelPreset(
  cfg: Pick<
    ShadowConfig,
    | 'models'
    | 'provider'
    | 'model'
    | 'baseUrl'
    | 'connection'
    | 'lastModel'
    | 'profile'
    | 'activeProfile'
    | 'activeProfilePreset'
    | 'activeProfileTrustedPresets'
    | 'trustedGlobalModelPresets'
  >,
  options: { lastPicked?: ModelEntry; recallLast?: boolean; targetPinned?: boolean } = {},
): ModelEntry | undefined {
  const checked = (entry: ModelEntry): ModelEntry => {
    assertAccountPresetCompatible(entry);
    return entry;
  };
  const target = (entry: ModelEntry) => entry.provider === cfg.provider && entry.model === cfg.model;
  const apiTarget = (entry: ModelEntry) =>
    target(entry) && !entry.connection && !cfg.connection && sameEffectiveEndpoint(entry, cfg);
  if (options.lastPicked) {
    const picked = checked(options.lastPicked);
    // Callers apply a labeled API pick atomically (provider/model/baseUrl). Keep the label stable
    // among duplicate wire IDs, but never attach its endpoint-specific capabilities or credential
    // when a one-run endpoint override changed the effective target. Subscription connections own
    // their endpoint and retain the existing compatibility checks below.
    const identityCompatible = picked.connection
      ? cfg.connection == null || sameConnection(picked.connection, cfg.connection)
      : cfg.connection == null;
    if (target(picked) && identityCompatible && sameEffectiveEndpoint(picked, cfg)) {
      return picked;
    }
  }
  // An activated profile carries the exact trusted-global entry selected during loadConfig.
  // Never resolve its label against cfg.models: a project file may replace that array and collide
  // with the trusted label. Explicit provider/model/endpoint overrides still detach the preset.
  if (cfg.profile?.model) {
    const profiled = cfg.activeProfilePreset;
    if (profiled && target(profiled) && sameConnection(profiled.connection, cfg.connection) &&
        sameEffectiveEndpoint(profiled, cfg)) return checked(profiled);
    if (cfg.activeProfile) {
      // CLI/env may legitimately override one profile target key. Resolve that new target only
      // from the trusted global list retained by loadConfig; never fall through to a colliding
      // project model. This preserves CLI > profile precedence without reopening label injection.
      const trusted = cfg.activeProfileTrustedPresets ?? [];
      if (cfg.connection) {
        const account = trusted.find((entry) =>
          target(entry) && sameConnection(entry.connection, cfg.connection) && sameEffectiveEndpoint(entry, cfg));
        if (account) return checked(account);
      } else {
        const api = trusted.find(apiTarget);
        if (api) return checked(api);
      }
      // A trusted profile whose model is a direct id (rather than a trusted preset label) remains
      // a direct target. Do not attach a project preset that happens to collide.
      return undefined;
    }
  } else if (options.recallLast && !options.targetPinned && cfg.lastModel) {
    const recalled = findRememberedModelPreset(cfg);
    if (recalled) {
      // `/model` selects a labeled preset atomically. The top-level provider/model/baseUrl keys
      // may still describe the previously-active target (old configs and read-only diagnostics
      // both exercise that state), so comparing the remembered entry to those stale keys first
      // incorrectly rejects the selection. Apply its trusted transport tuple, then perform the
      // endpoint-bound check. A caller with a one-run provider/model/base-url override sets
      // targetPinned and never reaches this branch.
      const rememberedTarget = {
        provider: recalled.provider,
        model: recalled.model,
        baseUrl: recalled.baseUrl,
        connection: recalled.connection,
      };
      if (sameEffectiveEndpoint(recalled, rememberedTarget)) return checked(recalled);
    }
  }
  if (cfg.connection) {
    checked({ label: cfg.model, provider: cfg.provider, model: cfg.model, connection: cfg.connection });
    // Keep the selected account even when --model names a new model on that same account.
    // Never substitute the first API preset or a different account with the same model ID.
    return checked(cfg.models.find((entry) => target(entry) && sameConnection(entry.connection, cfg.connection)) ??
      { label: cfg.model, provider: cfg.provider, model: cfg.model, connection: cfg.connection });
  }
  const matches = cfg.models.filter(target);
  const apiCandidates = matches.filter((entry) => !entry.connection);
  const api = apiCandidates.find(apiTarget);
  if (api) return api;
  // With no configured/env/stored endpoint there is no competing wire target yet. Preserve the
  // long-standing single-preset behavior: that sole trusted entry supplies its own endpoint (and
  // lets doctor/onboarding report a missing per-model credential precisely). Once any endpoint is
  // resolved, even indirectly from the environment or credential store, exact matching above is
  // mandatory so credentials and capability flags cannot cross endpoints.
  if (apiCandidates.length === 1 && !resolveBaseUrl(cfg.provider, cfg.baseUrl, cfg.connection)) {
    return checked(apiCandidates[0]!);
  }
  // An API preset for this wire model exists, but it belongs to a different endpoint. Returning it
  // would leak its capability flags and possibly its credential; falling through to an account
  // preset would silently change billing identity. A direct provider/model/baseUrl target simply
  // has no active preset in this case.
  if (apiCandidates.length > 0) return undefined;
  // Account presets own their endpoint just as strictly as API presets own theirs. In particular,
  // a one-run SHADOW_BASE_URL/custom direct target must not silently snap back to a same-model
  // ChatGPT or Claude account merely because it is the only account candidate.
  const accounts = matches.filter((entry) => entry.connection && accountEndpointCompatible(entry, cfg));
  if (accounts.length === 1) return checked(accounts[0]!);
  if (accounts.length > 1) throw new Error('This model is available through multiple accounts. Select its preset label with /model or a named --profile.');
  return undefined;
}

export function removeModelPreset(models: ModelEntry[], label: string): PresetResult<ModelEntry[]> {
  if (!label) return { ok: false, message: 'Usage: /model remove <label>' };
  const next = models.filter((m) => !sameLabel(m.label, label));
  if (next.length === models.length) return { ok: false, message: `No model preset named "${label}".` };
  return { ok: true, value: next };
}

export function setModelPresetEnabled(models: ModelEntry[], label: string, enabled: boolean): PresetResult<ModelEntry[]> {
  if (!label) return { ok: false, message: `Usage: /model ${enabled ? 'enable' : 'disable'} <label>` };
  let found = false;
  const next = models.map((m) => {
    if (!sameLabel(m.label, label)) return m;
    found = true;
    return { ...m, disabled: enabled ? undefined : true };
  });
  if (!found) return { ok: false, message: `No model preset named "${label}".` };
  return { ok: true, value: next };
}

export function defaultModelPatch(entry: ModelEntry): Record<string, unknown> {
  return {
    connection: entry.connection,
    provider: entry.provider,
    model: entry.model,
    baseUrl: entry.baseUrl,
    // Include undefined deliberately: choosing a cloud default clears a stale top-level marker.
    selfHosted: entry.selfHosted,
    lastModel: entry.label,
  };
}
