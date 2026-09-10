// Local Model Garage — register, test, switch, and remove local .gguf models with no
// external runtime (no Ollama / LM Studio). Shadow already auto-serves a .gguf via an
// embedded llama.cpp server (src/gguf.ts); this module is the reusable core behind both
// the `shadow local` CLI subcommand and the `/local` TUI command. Keep it pure where it
// can be (name derivation, arg parsing, building/adding/removing presets) so the same
// code drives both surfaces and is unit-testable without spawning llama-server.
import { existsSync, statSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelEntry } from '../config.js';
import { addModelPreset, removeModelPreset, type PresetResult } from '../config/modelPresets.js';
import { ensureLocalServer } from '../gguf.js';
import { createProvider } from '../provider/index.js';
import { scrubControlTokens } from '../util/scrub.js';
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
/** A readable default label for an endpoint entry: the host, plus the port when it is not the default. */
function endpointLabel(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
    return `${u.hostname}${port}`;
  } catch {
    return endpoint;
  }
}

export function sanitizeLocalName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-') // collapse runs of unsafe chars to one dash
    .replace(/-{2,}/g, '-') // squeeze repeats
    .replace(/^[-.]+|[-.]+$/g, ''); // trim leading/trailing dashes/dots
  return cleaned || 'local-model';
}

/** A bare content hash — a HuggingFace snapshot dir name, useless as a model label. */
const HASH_ONLY = /^[0-9a-f]{16,}$/i;
/** HuggingFace cache directory naming: `models--<org>--<name>` (org/name may contain `--`). */
const HF_CACHE_DIR = /^(?:models|datasets)--(.+)$/;

/**
 * Derive a human preset name from ANY local model reference: a `.gguf` file, an MLX/HF model
 * FOLDER, or a `org/model` repo id.
 *
 * The folder case is why this exists. A HuggingFace cache path ends in the snapshot's content
 * hash — `…/models--EZCon--Some-Model-mlx/snapshots/404364e7467a87a9e31777b71408e96caabd9d5b` —
 * so a plain `basename()` named the preset `404364e7467a…`, and the `/model` picker listed a
 * 40-char hash you could neither recognize nor type. Walk up to the `models--org--name` segment
 * and use the model name from it; fall back to the nearest parent that isn't itself a hash.
 */
export function deriveLocalName(path: string): string {
  const clean = path.trim().replace(/[/\\]+$/, '');
  if (/\.gguf$/i.test(clean)) return sanitizeLocalName(basename(clean).replace(/\.gguf$/i, ''));

  // Walk from the deepest segment outward for the first name that actually identifies the model.
  const segments = clean.split(/[/\\]+/).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    const hf = HF_CACHE_DIR.exec(seg);
    if (hf) {
      // `models--org--name` → prefer the model name; `--` separates org from name.
      const parts = hf[1]!.split('--');
      return sanitizeLocalName(parts.length > 1 ? parts.slice(1).join('--') : parts[0]!);
    }
    // Skip the structural/opaque segments of an HF cache path.
    if (HASH_ONLY.test(seg) || seg === 'snapshots' || seg === 'blobs' || seg === 'refs') continue;
    return sanitizeLocalName(seg);
  }
  return sanitizeLocalName(basename(clean));
}

/**
 * Re-label local presets whose name is a bare snapshot hash (see deriveLocalName). Pure: returns
 * the repaired list and whether anything changed, so the caller decides about persisting.
 *
 * Only MLX and vLLM presets are touched, and only when the label carries no information. For MLX
 * the label is purely cosmetic (`model` holds the real target the server hot-loads), and for vLLM
 * Shadow launches the server itself with `--served-model-name`, so renaming both stays consistent.
 * `.gguf` presets are left alone — their names come from the filename and can't be hashes.
 */
export function repairLocalLabels(models: ModelEntry[]): { models: ModelEntry[]; renamed: { from: string; to: string }[] } {
  const renamed: { from: string; to: string }[] = [];
  const taken = new Set(models.map((m) => m.label.trim().toLowerCase()));
  const next = models.map((m) => {
    const target = m.mlx ?? m.vllm;
    if (!target || !HASH_ONLY.test(m.label.trim())) return m;
    const derived = deriveLocalName(target);
    if (!derived || HASH_ONLY.test(derived) || taken.has(derived.toLowerCase())) return m;
    taken.delete(m.label.trim().toLowerCase());
    taken.add(derived.toLowerCase());
    renamed.push({ from: m.label, to: derived });
    // vLLM serves under the label, so its wire `model` tracks the rename; MLX's `model` is the
    // real path/repo id the server loads and must NOT be touched.
    return m.vllm && m.model === m.label ? { ...m, label: derived, model: derived } : { ...m, label: derived };
  });
  return { models: next, renamed };
}

export interface LocalAddOptions {
  path: string;
  name?: string;
  ctx?: number;
  gpuLayers?: number;
  /**
   * `--endpoint <url>`: register an ALREADY-RUNNING OpenAI-compatible server (a DGX Spark, a
   * workstation, a lab box) instead of a local file to launch. Such an entry runs nothing locally
   * and is marked `autoModel`, so it tracks whatever that server is serving without a config edit
   * each time the model changes.
   */
  endpoint?: string;
  /** `--model <id>`: pin a specific id for the endpoint. Omit for auto-detection. */
  model?: string;
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
  let endpoint: string | undefined;
  let model: string | undefined;
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
    // `--endpoint <url>` is the LAN-box form: register a server that is already running rather than
    // a local file to launch. Accepted as a flag so it can appear anywhere in the argument list.
    if (t === '--endpoint' || t === '--url') {
      const v = tokens[++i];
      if (v === undefined) return { ok: false, message: `Missing value after ${t}.` };
      endpoint = v;
      continue;
    }
    if (t === '--model') {
      const v = tokens[++i];
      if (v === undefined) return { ok: false, message: 'Missing value after --model.' };
      model = v;
      continue;
    }
    if (t.startsWith('--')) return { ok: false, message: `Unknown flag: ${t}` };
    // A bare http(s) URL in the path slot is the same request spelled the obvious way:
    // `local add http://10.0.0.31:30000/v1`.
    if (path === undefined && /^https?:\/\//i.test(t)) {
      endpoint = t;
      continue;
    }
    if (path === undefined) {
      path = t;
      continue;
    }
    return { ok: false, message: `Unexpected argument: ${t}` };
  }
  if (endpoint !== undefined) {
    const url = endpoint.trim().replace(/\/+$/, '');
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    } catch {
      return { ok: false, message: `--endpoint must be an http(s) base URL, got "${endpoint}".` };
    }
    return { ok: true, value: defined({ path: '', name, ctx, gpuLayers, endpoint: url, model }) };
  }
  if (!path)
    return {
      ok: false,
      message:
        'Usage: local add <path-to.gguf> [--name <n>] [--ctx <n>] [--gpu-layers <n>]\n' +
        '       local add --endpoint <http://<host>:<port>/v1> [--name <n>] [--model <id>]',
    };
  return { ok: true, value: defined({ path, name, ctx, gpuLayers, model }) };
}

/** Drop unset keys so the success shape stays exact — callers deep-compare these options. */
function defined<T extends object>(o: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * Validate inputs and build a gguf ModelEntry. Pure — touches the filesystem only to
 * confirm the .gguf exists; does NOT persist anything. The ok arm may carry a `note`
 * (non-fatal heads-up the caller should surface, e.g. a small --ctx).
 */
export function buildLocalEntry(opts: LocalAddOptions): PresetResult<ModelEntry> & { note?: string } {
  // An ENDPOINT entry: a server that is already running elsewhere (a DGX, a workstation, a lab
  // box). Nothing is launched and no file is validated — the endpoint IS the model source, and
  // `autoModel` makes the entry follow whatever that server currently serves.
  if (opts.endpoint) {
    const label = opts.name?.trim() || endpointLabel(opts.endpoint);
    return {
      ok: true,
      value: {
        label,
        provider: 'openai',
        // The declared id is the FALLBACK for an unreachable box; auto-detection overrides it.
        model: opts.model?.trim() || 'auto',
        baseUrl: opts.endpoint,
        autoModel: true,
        // A LAN inference box pauses far longer between SSE chunks than a hosted API.
        idleTimeoutMs: 300_000,
        firstByteTimeoutMs: 300_000,
        ...(opts.ctx ? { contextWindow: opts.ctx } : {}),
      },
    };
  }

  const raw = opts.path?.trim();
  if (!raw)
    return {
      ok: false,
      message: 'Usage: local add <path-to.gguf> [--name <name>] [--ctx <n>] [--gpu-layers <n>]',
    };
  // Expand a leading ~ — the interactive onboarding prompt is the first surface where the raw
  // string reaches us without a shell to expand it, and "~/models/x.gguf" is how humans type it.
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;

  // A HuggingFace-format model — a FOLDER (config.json + safetensors) or a repo id — is served by
  // MLX on Apple Silicon and by vLLM on Linux+CUDA. Detected before the .gguf rule so `local add`
  // is one verb for every backend; the platform picks the engine.
  const absMaybe = resolve(expanded);
  const looksModelDir = existsSync(absMaybe) && statSync(absMaybe).isDirectory();
  const looksRepoId = !existsSync(absMaybe) && /^[\w.-]+\/[\w.-]+$/.test(raw) && !/\.gguf$/i.test(raw);
  if (looksModelDir || looksRepoId) {
    if (looksModelDir && !existsSync(join(absMaybe, 'config.json'))) {
      return {
        ok: false,
        message: `Not a model folder (no config.json inside): ${absMaybe}\n  Expected a HuggingFace-format folder (config.json + *.safetensors), or a .gguf file.`,
      };
    }
    // --ctx is a BUDGET HINT for these backends (the server window is set its own way — mlx has no
    // -c flag; vLLM uses --max-model-len via vllmArgs). It bounds Shadow's compaction, not the server.
    if (opts.ctx !== undefined && (!Number.isInteger(opts.ctx) || opts.ctx < 2048)) {
      return { ok: false, message: `--ctx ${opts.ctx} is not usable (minimum 2048) — here it bounds Shadow's context budget, not the server.` };
    }
    const target = looksModelDir ? absMaybe : raw;
    // deriveLocalName, NOT basename: a HuggingFace cache folder ends in the snapshot's content
    // hash, which basename turned into a 40-char hex preset name.
    const name = opts.name ? sanitizeLocalName(opts.name) : deriveLocalName(target);
    if (!name) return { ok: false, message: 'Could not derive a model name; pass --name <name>.' };
    const ctxHint = opts.ctx !== undefined ? { ctx: opts.ctx } : {};

    // Apple Silicon → MLX (mlx_lm.server HONORS the request's model field — it hot-loads repos by
    // id — so the wire model MUST be the real target, not the friendly label, or it 404s).
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      if (opts.gpuLayers !== undefined) {
        return { ok: false, message: '--gpu-layers is a llama.cpp (.gguf) option — mlx_lm.server manages its own memory.' };
      }
      const entry: ModelEntry = { label: name, provider: 'openai', model: target, mlx: target, ...ctxHint, group: 'Local' };
      return looksRepoId
        ? { ok: true, value: entry, note: `repo id — the weights download from HuggingFace on first use (cached after).` }
        : { ok: true, value: entry };
    }
    // Linux → vLLM (served under --served-model-name = the friendly label, so requests use the label;
    // multi-GPU / quantization knobs go in `vllmArgs`, e.g. ["--tensor-parallel-size","8"]).
    if (process.platform === 'linux') {
      if (opts.gpuLayers !== undefined) {
        return { ok: false, message: '--gpu-layers is a llama.cpp (.gguf) option — vLLM manages its own GPU memory; use vllmArgs for --tensor-parallel-size etc.' };
      }
      const entry: ModelEntry = { label: name, provider: 'openai', model: name, vllm: target, ...ctxHint, group: 'Local' };
      return looksRepoId
        ? { ok: true, value: entry, note: `repo id — vLLM downloads the weights from HuggingFace on first use (cached after).` }
        : { ok: true, value: entry };
    }
    return { ok: false, message: `Model folders are served via MLX (Apple Silicon) or vLLM (Linux+CUDA) — this platform (${process.platform}) supports neither. Use a .gguf file.` };
  }

  if (!/\.gguf$/i.test(raw)) {
    return { ok: false, message: `Not a recognizable local model: ${raw}\n  Accepted: a .gguf file, an MLX model folder, or an mlx-community/<model> repo id (Apple Silicon).` };
  }
  const abs = absMaybe;
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

/** True for an entry that is served somewhere else and TRACKED rather than launched here. */
export function isEndpointModel(m: ModelEntry): boolean {
  return Boolean(m.autoModel && m.baseUrl && !m.gguf && !m.mlx && !m.vllm);
}

/** Every registered local preset (gguf / mlx / vllm / LAN endpoint), in config order. */
export function listLocalModels(models: ModelEntry[]): ModelEntry[] {
  return models.filter((m) => Boolean(m.gguf) || Boolean(m.mlx) || Boolean(m.vllm) || isEndpointModel(m));
}

/** Remove a local preset by name (rejects unknown / non-local names). */
export function removeLocalModel(models: ModelEntry[], name: string): PresetResult<ModelEntry[]> {
  if (!name) return { ok: false, message: 'Usage: local remove <name>' };
  const target = models.find((m) => m.label.trim().toLowerCase() === name.trim().toLowerCase());
  if (!target) return { ok: false, message: `No local model named "${name}".` };
  if (!target.gguf && !target.mlx && !target.vllm && !isEndpointModel(target))
    return { ok: false, message: `"${name}" is not a locally-served model; use /model remove.` };
  return removeModelPreset(models, name);
}

/** Render the local-model list as plain lines (CLI writes them; TUI pushes them). */
export function formatLocalList(models: ModelEntry[]): string[] {
  const locals = listLocalModels(models);
  if (locals.length === 0)
    return [
      'No local models registered.',
      'Add one with: local add <path-to.gguf | mlx-folder | mlx-community/model>',
      '    or a LAN endpoint: local add --endpoint http://<host>:<port>/v1 [--name <n>]',
    ];
  return locals.map((m) => {
    const state = m.disabled ? 'disabled' : 'enabled';
    if (isEndpointModel(m)) {
      return `${m.label}  ·  ${m.baseUrl}  ·  lan endpoint  ·  auto-detects the served model  ·  ${state}`;
    }
    if (m.mlx) {
      const target = m.mlx.includes('/') && !m.mlx.startsWith('/') ? m.mlx : basename(m.mlx);
      return `${m.label}  ·  ${target}  ·  mlx  ·  ${state}`;
    }
    if (m.vllm) {
      const target = m.vllm.startsWith('/') ? basename(m.vllm) : m.vllm;
      return `${m.label}  ·  ${target}  ·  vllm  ·  ${state}`;
    }
    const file = m.gguf ? basename(m.gguf) : '(unknown)';
    const ctx = m.ctx ?? DEFAULT_LOCAL_CTX;
    const ngl = m.gpuLayers ?? DEFAULT_LOCAL_GPU_LAYERS;
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
  temperature = 1.0,
): Promise<LocalTestResult> {
  if (!entry.gguf && !entry.mlx && !entry.vllm) return { ok: false, error: `"${entry.label}" is not a locally-served model.` };
  let baseUrl: string;
  try {
    ({ baseUrl } = await ensureLocalServer(entry, log));
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
      temperature,
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
  // Scrub raw control tokens (<|im_end|> etc.) — sessions scrub them; the test display should too.
  return { ok: true, endpoint: baseUrl, reply: scrubControlTokens(reply).trim(), outputTokens, tokensPerSec };
}
