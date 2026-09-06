import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import { loadGlobalConfig, saveGlobalConfig, vaultUnlocked, setUnlockedVault, type CredentialEntry } from '../../state/globalStore.js';
import { randomUUID } from 'node:crypto';
import {
  addModelPreset,
  removeModelPreset,
  setModelPresetEnabled,
  findModelPreset,
  defaultModelPatch,
} from '../../config/modelPresets.js';
import { ModelEntrySchema, resolveEntryCredential, resolveBaseUrl } from '../../config.js';
import { getSessionKey } from '../../auth/unlock.js';
import { saveSecrets, unlockWithKey, vaultExists } from '../../auth/vault.js';
import { credentialStatus, endpointLabel, probeModel } from '../modelProbe.js';
import type { ModelEntry } from '../../config.js';

/**
 * Phase B: model-preset management (the "APIs" surface). Each handler is a thin wrapper over
 * the pure helpers in `config/modelPresets.ts` (which the TUI's `/model` already uses), plus
 * `saveGlobalConfig` for persistence. Secrets NEVER appear in a response — `mask()` is the
 * only shape returned over the wire.
 *
 * Submitted keys are sealed and verified before config is saved with a credential reference.
 * Locked-vault submissions are refused; keys never pass through plaintext config files.
 */

/**
 * Mask a model entry for wire transport. Secrets never appear — only whether one is present
 * and the opaque vault pointer. Exported so the /api/state snapshot reuses the exact same
 * shape as the dedicated /api/models response (no drift between views).
 */
export function mask(entry: ModelEntry): Record<string, unknown> {
  return {
    label: entry.label,
    provider: entry.provider,
    model: entry.model,
    baseUrl: endpointLabel(entry.baseUrl),
    selfHosted: entry.provider === 'openai' && entry.selfHosted === true,
    fallback: entry.fallback ?? null,
    group: entry.group ?? null,
    disabled: entry.disabled === true,
    hasCredential: Boolean(entry.credRef ?? entry.apiKey ?? entry.authToken),
    credRef: typeof entry.credRef === 'string' ? entry.credRef : undefined,
    credentialStatus: credentialStatus(entry),
  };
}

function allEntries(): ModelEntry[] {
  const cfg = loadGlobalConfig();
  return Array.isArray(cfg.models) ? (cfg.models as ModelEntry[]) : [];
}

/** Seal before saving config; never stage a submitted key in plaintext on disk. A fresh slot
 * also avoids rotating another model's shared credential when editing this preset. */
function withSealedKey(entry: ModelEntry, apiKey: string): ModelEntry {
  const key = getSessionKey();
  if (!vaultUnlocked() || !key) throw new Error('vault-locked: unlock the credential vault in your terminal first');
  const data = unlockWithKey(key);
  const slot = `model.${randomUUID()}`;
  data[slot] = { apiKey, ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}) };
  saveSecrets(data, key);
  setUnlockedVault(unlockWithKey(key) as Record<string, CredentialEntry>);
  const { apiKey: _apiKey, authToken: _token, ...safe } = entry;
  return { ...safe, credRef: slot };
}

function validEndpoint(value: unknown): boolean {
  if (value == null || value === '') return true;
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
  } catch { return false; }
}

/**
 * Register the model routes. Called once from router.ts at module load. Splitting this out
 * keeps each surface in its own file while the router stays a thin dispatcher.
 */
export function registerModelsRoutes(route: RouteFn, _ctx: ApiContext): void {
  let probing = false;

  route('POST', /^\/api\/models\/([^/]+)\/probe$/, async (req, res, match) => {
    const body = await readJsonBody(req) as { kind?: string } | null;
    if (body?.kind !== 'endpoint' && body?.kind !== 'response') return { status: 400, body: { error: 'kind must be endpoint | response' } };
    const entry = findModelPreset(allEntries(), decodeURIComponent(match[1]!));
    if (!entry) return { status: 404, body: { error: 'Model preset not found' } };
    if (probing) return { status: 409, body: { error: 'A model test is already running. Wait for it to finish.' } };
    probing = true;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    try { return { status: 200, body: await probeModel(entry, body.kind, controller.signal) }; }
    finally { probing = false; res.off('close', cancel); }
  });

// ── GET /api/models ──────────────────────────────────────────────────────────

  route('GET', /^\/api\/models$/, async () => {
    const cfg = loadGlobalConfig();
    const entries = allEntries();
    return {
      status: 200,
      body: {
        active: {
          provider: cfg.provider ?? null,
          model: cfg.model ?? null,
          fallbackModel: cfg.fallbackModel ?? null,
          lastModel: cfg.lastModel ?? null,
        },
        vaultUnlocked: vaultUnlocked(),
        models: entries.map(mask),
      },
    };
  });

  // ── POST /api/models ─────────────────────────────────────────────────────────
  // Body: the preset fields (label/provider/model/baseUrl/selfHosted/fallback/group) + optional apiKey.

  route('POST', /^\/api\/models$/, async (req: IncomingMessage) => {
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return { status: 400, body: { error: 'invalid body' } };
    if (body.selfHosted === true && body.provider !== 'openai') {
      return { status: 400, body: { error: 'selfHosted is only valid for OpenAI-compatible presets' } };
    }

    // Validate the entry shape via the same schema config.ts uses. Strip any incoming credRef —
    // the caller never sets it; it is minted by the vault migration from the label.
    const { apiKey, credRef: _ref, authToken: _token, ...fields } = body;
    if (!validEndpoint(fields.baseUrl)) return { status: 400, body: { error: 'Use an HTTP(S) base URL without credentials, a query or a fragment.' } };
    if (apiKey != null && typeof apiKey !== 'string') return { status: 400, body: { error: 'API key must be text' } };
    const parsed = ModelEntrySchema.safeParse({ ...fields });
    if (!parsed.success) {
      return { status: 400, body: { error: parsed.error.issues[0]?.message ?? 'invalid model' } };
    }
    const hasSecret = typeof apiKey === 'string' && apiKey.length > 0;
    if (hasSecret && !vaultUnlocked()) {
      return {
        status: 409,
        body: {
          error: 'vault-locked',
          message:
            'The credential vault is locked. Set SHADOW_VAULT_PASSWORD or run `shadow web` from a terminal to unlock, then retry. Models without a key can still be added.',
        },
      };
    }

    let entry: ModelEntry = parsed.data;
    const added = addModelPreset(allEntries(), entry);
    if (!added.ok) return { status: 409, body: { error: added.message } };
    if (hasSecret) entry = withSealedKey(entry, String(apiKey).trim());
    saveGlobalConfig({ models: added.value.map((m) => m.label === entry.label ? entry : m) });
    return { status: 201, body: { model: mask(entry), sealed: hasSecret } };
  });

  // ── PATCH /api/models/:label ─────────────────────────────────────────────────
  // Body: { action: 'enable'|'disable'|'default' }

  route('PATCH', /^\/api\/models\/(.+)$/, async (req: IncomingMessage, _res: ServerResponse, match: RegExpMatchArray) => {
    const label = decodeURIComponent(match[1] ?? '');
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const action = body?.action;
    if (action === 'update' && body) {
      const entries = allEntries();
      const old = findModelPreset(entries, label);
      if (!old) return { status: 404, body: { error: 'Model preset not found' } };
      if (!validEndpoint(body.baseUrl)) return { status: 400, body: { error: 'Use an HTTP(S) base URL without credentials, a query or a fragment.' } };
      if (body.apiKey != null && typeof body.apiKey !== 'string') return { status: 400, body: { error: 'API key must be text' } };
      const parsed = ModelEntrySchema.safeParse({
        ...old,
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl || undefined } : {}),
        ...(body.selfHosted !== undefined ? { selfHosted: body.selfHosted } : {}),
      });
      if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? 'Invalid model' } };
      let next = parsed.data;
      if (next.selfHosted && next.provider !== 'openai') return { status: 400, body: { error: 'selfHosted is only valid for OpenAI-compatible presets' } };
      const newKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      const credential = resolveEntryCredential(old);
      const hasCredential = Boolean(old.credRef || old.apiKey || old.authToken || (credential.ok && (credential.apiKey || credential.authToken)) || (vaultExists() && !vaultUnlocked()));
      if (next.baseUrl !== old.baseUrl && hasCredential && !newKey && body.reuseCredential !== true) {
        return { status: 409, body: { error: 'Confirm reusing the saved credential with the changed endpoint, or provide a new API key.' } };
      }
      if (newKey) next = withSealedKey(next, newKey);
      const cfg = loadGlobalConfig();
      // Update the saved default's endpoint too, without changing the active sessions.
      const defaultMatches = cfg.provider === old.provider && cfg.model === old.model
        && resolveBaseUrl(old.provider, cfg.baseUrl as string | undefined) === resolveBaseUrl(old.provider, old.baseUrl);
      saveGlobalConfig({
        models: entries.map((m) => m.label === old.label ? next : m),
        ...(defaultMatches ? { model: next.model, baseUrl: next.baseUrl, selfHosted: next.selfHosted ?? false } : {}),
      });
      return { status: 200, body: { model: mask(next) } };
    }
    if (action !== 'enable' && action !== 'disable' && action !== 'default') {
      return { status: 400, body: { error: 'action must be enable | disable | default | update' } };
    }

    const entries = allEntries();
    if (action === 'default') {
      const entry = findModelPreset(entries, label);
      if (!entry) return { status: 404, body: { error: `No model preset named "${label}".` } };
      const patch = defaultModelPatch(entry);
      saveGlobalConfig(patch);
      return { status: 200, body: { active: patch } };
    }

    const next = setModelPresetEnabled(entries, label, action === 'enable');
    if (!next.ok) return { status: 404, body: { error: next.message } };
    saveGlobalConfig({ models: next.value });
    return { status: 200, body: { models: next.value.map(mask) } };
  });

  // ── DELETE /api/models/:label ────────────────────────────────────────────────

  route('DELETE', /^\/api\/models\/(.+)$/, async (_req: IncomingMessage, _res: ServerResponse, match: RegExpMatchArray) => {
    const label = decodeURIComponent(match[1] ?? '');
    const next = removeModelPreset(allEntries(), label);
    if (!next.ok) return { status: 404, body: { error: next.message } };
    saveGlobalConfig({ models: next.value });
    // The vault slot is left in place — it is keyed by value, so another preset may share it,
    // and a stray orphan slot is harmless (encrypted bytes, no reference). Clearing it correctly
    // would require value-dedup tracking the migration already owns.
    return { status: 200, body: { models: next.value.map(mask) } };
  });
}
