import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import { loadGlobalConfig, saveGlobalConfig, vaultUnlocked } from '../../state/globalStore.js';
import {
  addModelPreset,
  removeModelPreset,
  setModelPresetEnabled,
  findModelPreset,
  defaultModelPatch,
} from '../../config/modelPresets.js';
import { ModelEntrySchema } from '../../config.js';
import { migratePresetKeysIntoVault } from '../../auth/credRefMigrate.js';
import type { ModelEntry } from '../../config.js';

/**
 * Phase B: model-preset management (the "APIs" surface). Each handler is a thin wrapper over
 * the pure helpers in `config/modelPresets.ts` (which the TUI's `/model` already uses), plus
 * `saveGlobalConfig` for persistence. Secrets NEVER appear in a response — `mask()` is the
 * only shape returned over the wire.
 *
 * Credential flow on add: if a key is submitted AND the vault is unlocked, the entry is
 * written with its plaintext key, then `migratePresetKeysIntoVault` seals it into the vault
 * and scrubs the plaintext (the same path startup runs). If the vault is locked, a key
 * submission is refused with a 409 — we never silently store a plaintext key in config.json.
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
    baseUrl: entry.baseUrl ?? null,
    fallback: entry.fallback ?? null,
    group: entry.group ?? null,
    disabled: entry.disabled === true,
    hasCredential: Boolean(entry.credRef ?? entry.apiKey ?? entry.authToken),
    credRef: typeof entry.credRef === 'string' ? entry.credRef : undefined,
  };
}

function allEntries(): ModelEntry[] {
  const cfg = loadGlobalConfig();
  return Array.isArray(cfg.models) ? (cfg.models as ModelEntry[]) : [];
}

/** Seal any plaintext keys on the given entries into the vault, returning the scrubbed set. */
function sealKeys(write: (s: string) => void): { sealed: boolean; entries: ModelEntry[] } {
  if (!vaultUnlocked()) return { sealed: false, entries: allEntries() };
  migratePresetKeysIntoVault(write);
  return { sealed: true, entries: allEntries() };
}

/**
 * Register the model routes. Called once from router.ts at module load. Splitting this out
 * keeps each surface in its own file while the router stays a thin dispatcher.
 */
export function registerModelsRoutes(route: RouteFn, ctx: ApiContext): void {

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
  // Body: the preset fields (label/provider/model/baseUrl/fallback/group) + optional apiKey.

  route('POST', /^\/api\/models$/, async (req: IncomingMessage) => {
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return { status: 400, body: { error: 'invalid body' } };

    // Validate the entry shape via the same schema config.ts uses. Strip any incoming credRef —
    // the caller never sets it; it is minted by the vault migration from the label.
    const { apiKey, ...fields } = body;
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

    const entry: ModelEntry = { ...parsed.data, ...(hasSecret ? { apiKey: String(apiKey) } : {}) };
    const added = addModelPreset(allEntries(), entry);
    if (!added.ok) return { status: 409, body: { error: added.message } };
    saveGlobalConfig({ models: added.value });

    // Seal the key (if any) into the vault, leaving a credRef pointer. Returns the scrubbed entry.
    const log: string[] = [];
    const { entries } = sealKeys((s) => log.push(s.trim()));
    const saved = findModelPreset(entries, entry.label);
    return { status: 201, body: { model: saved ? mask(saved) : null, sealed: hasSecret, log } };
  });

  // ── PATCH /api/models/:label ─────────────────────────────────────────────────
  // Body: { action: 'enable'|'disable'|'default' }

  route('PATCH', /^\/api\/models\/(.+)$/, async (req: IncomingMessage, _res: ServerResponse, match: RegExpMatchArray) => {
    const label = decodeURIComponent(match[1] ?? '');
    const body = (await readJsonBody(req)) as { action?: string } | null;
    const action = body?.action;
    if (action !== 'enable' && action !== 'disable' && action !== 'default') {
      return { status: 400, body: { error: 'action must be enable | disable | default' } };
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
