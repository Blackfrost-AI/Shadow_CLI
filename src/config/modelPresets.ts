import type { ModelEntry } from '../config.js';

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
    return { ok: false, message: 'Usage: /model add <label> <provider> <model> [baseUrl] [--group <name>]' };
  }
  if (!isModelProvider(provider)) {
    return { ok: false, message: `Provider must be one of: ${PROVIDERS.join(', ')}` };
  }
  let baseUrl: string | undefined;
  let group: string | undefined;
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
    if (!baseUrl) {
      baseUrl = token;
      continue;
    }
    return { ok: false, message: `Unknown /model add argument: ${token}` };
  }
  if (baseUrl && !ensureUrl(baseUrl)) return { ok: false, message: 'baseUrl must be an http(s) URL.' };
  return { ok: true, value: { label, provider, model, ...(baseUrl ? { baseUrl } : {}), ...(group ? { group } : {}) } };
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
    provider: entry.provider,
    model: entry.model,
    baseUrl: entry.baseUrl,
    lastModel: entry.label,
  };
}
