// Local Model Garage — register, test, switch, and remove local .gguf models with no
// external runtime (no Ollama / LM Studio). Shadow already auto-serves a .gguf via an
// embedded llama.cpp server (src/gguf.ts); this module is the reusable core behind both
// the `shadow local` CLI subcommand and the `/local` TUI command. Keep it pure where it
// can be (name derivation, arg parsing, building/adding/removing presets) so the same
// code drives both surfaces and is unit-testable without spawning llama-server.
import { existsSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelEntry } from '../config.js';
import { addModelPreset, removeModelPreset, type PresetResult } from '../config/modelPresets.js';
import { ensureGgufServer } from '../gguf.js';
import { createProvider } from '../provider/index.js';
import type { Message } from '../provider/provider.js';

/** Context window (-c) applied when `--ctx` is omitted. Must stay >= the gguf compaction
 *  budget (index.ts clamps local gguf to 30k, compacting at ~22.5k) — a smaller server
 *  window would 400 before compaction ever fires. 32768 matches the historical gguf default. */
export const DEFAULT_LOCAL_CTX = 32768;
/** GPU offload layers (-ngl) applied when `--gpu-layers` is omitted (999 = all; llama clamps). */
export const DEFAULT_LOCAL_GPU_LAYERS = 999;

/** The llama-server install hint now lives in gguf.ts (single source of truth for setup-time AND
 *  runtime-failure messaging); re-exported here for existing importers. */
export { LLAMA_INSTALL_HINT } from '../gguf.js';

/** Sanitize a raw string into a safe, readable preset label (alnum . _ -). */
export function sanitizeLocalName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-') // collapse runs of unsafe chars to one dash
    .replace(/-{2,}/g, '-') // squeeze repeats
    .replace(/^[-.]+|[-.]+$/g, ''); // trim leading/trailing dashes/dots
  return cleaned || 'local-model';
}

/** Derive a clean preset name from a .gguf filename: drop dir + extension, sanitize. */
export function deriveLocalName(path: string): string {
  return sanitizeLocalName(basename(path).replace(/\.gguf$/i, ''));
}

export interface LocalAddOptions {
  path: string;
  name?: string;
  ctx?: number;
  gpuLayers?: number;
}

/**
 * Parse `add` tokens (everything after `add`) into LocalAddOptions.
 * Shared by the CLI subcommand and the `/local add` TUI command.
 */
export function parseLocalAddArgs(tokens: string[]): PresetResult<LocalAddOptions> {
  let path: string | undefined;
  let name: string | undefined;
  let ctx: number | undefined;
  let gpuLayers: number | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--name') {
      name = tokens[++i];
      if (name === undefined) return { ok: false, message: 'Missing value after --name.' };
      continue;
    }
    if (t === '--ctx') {
      const v = tokens[++i];
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n <= 0)
        return { ok: false, message: '--ctx must be a positive integer.' };
      ctx = n;
      continue;
    }
    if (t === '--gpu-layers' || t === '--ngl') {
      const v = tokens[++i];
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n < 0)
        return { ok: false, message: '--gpu-layers must be a non-negative integer.' };
      gpuLayers = n;
      continue;
    }
    if (t.startsWith('--')) return { ok: false, message: `Unknown flag: ${t}` };
    if (path === undefined) {
      path = t;
      continue;
    }
    return { ok: false, message: `Unexpected argument: ${t}` };
  }
  if (!path)
    return {
      ok: false,
      message: 'Usage: local add <path-to.gguf> [--name <name>] [--ctx <n>] [--gpu-layers <n>]',
    };
  return { ok: true, value: { path, name, ctx, gpuLayers } };
}

/**
 * Validate inputs and build a gguf ModelEntry. Pure — touches the filesystem only to
 * confirm the .gguf exists; does NOT persist anything. The ok arm may carry a `note`
 * (non-fatal heads-up the caller should surface, e.g. a small --ctx).
 */
export function buildLocalEntry(opts: LocalAddOptions): PresetResult<ModelEntry> & { note?: string } {
  const raw = opts.path?.trim();
  if (!raw)
    return {
      ok: false,
      message: 'Usage: local add <path-to.gguf> [--name <name>] [--ctx <n>] [--gpu-layers <n>]',
    };
  if (!/\.gguf$/i.test(raw)) return { ok: false, message: `Not a .gguf file: ${raw}` };
  // Expand a leading ~ — the interactive onboarding prompt is the first surface where the raw
  // string reaches us without a shell to expand it, and "~/models/x.gguf" is how humans type it.
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  const abs = resolve(expanded);
  if (!existsSync(abs)) return { ok: false, message: `File not found: ${abs}` };

  const name = opts.name ? sanitizeLocalName(opts.name) : deriveLocalName(abs);
  if (!name) return { ok: false, message: 'Could not derive a model name; pass --name <name>.' };

  const ctx = opts.ctx ?? DEFAULT_LOCAL_CTX;
  if (!Number.isInteger(ctx) || ctx <= 0)
    return { ok: false, message: `ctx must be a positive integer (got ${opts.ctx}).` };
  // Hard floor: below 8k the system prompt + one tool round-trip can't fit alongside the 2k
  // compaction headroom the session reserves — it 400s on an early request, which reads as
  // "local models are broken" to a fresh user.
  if (ctx < 8192)
    return {
      ok: false,
      message: `--ctx ${ctx} is too small to run an agent turn (minimum 8192; ${DEFAULT_LOCAL_CTX} recommended) — the server window must hold the system prompt, a full tool round-trip, and compaction headroom.`,
    };
  const gpuLayers = opts.gpuLayers ?? DEFAULT_LOCAL_GPU_LAYERS;
  if (!Number.isInteger(gpuLayers) || gpuLayers < 0)
    return { ok: false, message: `gpu-layers must be a non-negative integer (got ${opts.gpuLayers}).` };

  const entry: ModelEntry = {
    label: name,
    provider: 'openai', // local llama.cpp serves an OpenAI-compatible endpoint
    model: name,
    gguf: abs,
    ctx,
    gpuLayers,
    group: 'Local',
  };
  // Below the default the session still works (Shadow keeps its context budget under the server
  // window — see the startup clamp in index.ts), but it compacts sooner. Say so instead of
  // surprising the user mid-session.
  if (ctx < DEFAULT_LOCAL_CTX) {
    return {
      ok: true,
      value: entry,
      note: `--ctx ${ctx} is below the ${DEFAULT_LOCAL_CTX} default — sessions will auto-compact sooner to stay under the server window.`,
    };
  }
  return { ok: true, value: entry };
}

/** Build + add a local gguf preset to a models array (no disk I/O). Propagates buildLocalEntry's
 *  non-fatal `note` (e.g. small --ctx heads-up) for the caller to surface. */
export function addLocalModel(
  models: ModelEntry[],
  opts: LocalAddOptions,
): PresetResult<{ models: ModelEntry[]; entry: ModelEntry }> & { note?: string } {
  const built = buildLocalEntry(opts);
  if (!built.ok) return built;
  const next = addModelPreset(models, built.value);
  if (!next.ok) return next;
  return { ok: true, value: { models: next.value, entry: built.value }, ...(built.note ? { note: built.note } : {}) };
}

/** Every registered local (gguf) preset, in config order. */
export function listLocalModels(models: ModelEntry[]): ModelEntry[] {
  return models.filter((m) => typeof m.gguf === 'string' && m.gguf.length > 0);
}

/** Remove a local preset by name (rejects unknown / non-local names). */
export function removeLocalModel(models: ModelEntry[], name: string): PresetResult<ModelEntry[]> {
  if (!name) return { ok: false, message: 'Usage: local remove <name>' };
  const target = models.find((m) => m.label.trim().toLowerCase() === name.trim().toLowerCase());
  if (!target) return { ok: false, message: `No local model named "${name}".` };
  if (!target.gguf)
    return { ok: false, message: `"${name}" is not a local (.gguf) model; use /model remove.` };
  return removeModelPreset(models, name);
}

/** Render the local-model list as plain lines (CLI writes them; TUI pushes them). */
export function formatLocalList(models: ModelEntry[]): string[] {
  const locals = listLocalModels(models);
  if (locals.length === 0)
    return ['No local models registered. Add one with: local add <path-to.gguf>'];
  return locals.map((m) => {
    const file = m.gguf ? basename(m.gguf) : '(unknown)';
    const ctx = m.ctx ?? DEFAULT_LOCAL_CTX;
    const ngl = m.gpuLayers ?? DEFAULT_LOCAL_GPU_LAYERS;
    const state = m.disabled ? 'disabled' : 'enabled';
    return `${m.label}  ·  ${file}  ·  ctx ${ctx}  ·  gpu-layers ${ngl}  ·  ${state}`;
  });
}

export interface LocalTestResult {
  ok: boolean;
  endpoint?: string;
  reply?: string;
  outputTokens?: number;
  tokensPerSec?: number;
  error?: string;
}

/**
 * Start (or reuse) the llama.cpp server for an entry and run one tiny chat completion
 * against the local OpenAI-compatible endpoint. Returns PASS/FAIL + endpoint + rough
 * tok/s. Side-effecting (spawns a server, hits the network) — not unit-tested.
 */
export async function testLocalModel(
  entry: ModelEntry,
  log?: (msg: string) => void,
): Promise<LocalTestResult> {
  if (!entry.gguf) return { ok: false, error: `"${entry.label}" is not a local (.gguf) model.` };
  let baseUrl: string;
  try {
    ({ baseUrl } = await ensureGgufServer(entry, log));
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  let provider;
  try {
    provider = createProvider({
      provider: 'openai',
      model: entry.model,
      apiKey: entry.apiKey ?? 'sk-local',
      baseUrl,
    });
  } catch (e) {
    return { ok: false, endpoint: baseUrl, error: (e as Error).message };
  }

  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Reply with: OK' }] }];
  const start = Date.now();
  let outputTokens = 0;
  let reply = '';
  try {
    for await (const ev of provider.send({
      model: entry.model,
      system: '',
      messages,
      tools: [],
      maxOutputTokens: 16,
    })) {
      if (ev.type === 'error') return { ok: false, endpoint: baseUrl, error: `${ev.code}: ${ev.message}` };
      if (ev.type === 'text') reply += ev.delta;
      if (ev.type === 'usage') outputTokens = ev.outputTokens;
      if (ev.type === 'done') break;
    }
  } catch (e) {
    return { ok: false, endpoint: baseUrl, error: (e as Error).message };
  }

  const elapsedSec = (Date.now() - start) / 1000;
  const tokensPerSec = outputTokens > 0 && elapsedSec > 0 ? outputTokens / elapsedSec : undefined;
  return { ok: true, endpoint: baseUrl, reply: reply.trim(), outputTokens, tokensPerSec };
}
