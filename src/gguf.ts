// Local model auto-serve — point shadow at a local model and it launches a server for it
// (ollama-style), then talks to it over the OpenAI-compatible endpoint. Two backends:
//   • `gguf: "/path/to/model.gguf"`      → llama.cpp (`llama-server`) — any platform
//   • `mlx:  "<dir or mlx-community/…>"` → Apple MLX (`mlx_lm.server`) — Apple Silicon only
// Activation (startup or /model) ensures the server is up and routes to http://127.0.0.1:<port>/v1.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync, accessSync, constants } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { ModelEntry } from './config.js';

/**
 * Resolve a server binary NAME (e.g. "llama-server") to a runnable path.
 *
 * When the name is bare (no path separator), a plain `spawn("llama-server")` relies entirely on the
 * PATH the Shadow process inherited — and Shadow is often launched from a context (GUI, IDE, minimal
 * login shell) whose PATH omits `~/.local/bin`, so the lookup ENOENTs even though the binary is right
 * there. Shadow INSTALLS ITSELF to `~/.local/bin`, so a sibling `llama-server` is the common case; we
 * check the Shadow executable's own directory first, then the usual local-bin locations, and only then
 * fall back to the bare name (PATH lookup + the actionable install hint if that also fails).
 *
 * An explicit path (ggufServer / $SHADOW_LLAMA_SERVER) is returned untouched.
 */
export function resolveServerBin(
  name: string,
  // Candidate dirs, in order. Default = Shadow's own install dir + the usual local-bins. Injectable
  // so the resolution + executability gate are unit-testable without planting files in real dirs.
  dirs: string[] = [
    dirname(process.execPath), // where the Shadow binary itself lives (the key case: ~/.local/bin)
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ],
): string {
  if (name.includes('/') || name.includes('\\') || isAbsolute(name)) return name; // already a path
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of dirs) {
    const p = join(dir, exe);
    try {
      if (!existsSync(p) || !statSync(p).isFile()) continue;
      if (process.platform !== 'win32') accessSync(p, constants.X_OK); // must be executable
      return p;
    } catch {
      /* not executable / unreadable — keep looking */
    }
  }
  return name; // fall back to PATH resolution (and the install hint if that fails too)
}

/** Actionable install guidance shown whenever llama-server can't be found OR fails to launch.
 *  Lives here (the lowest-level GGUF module) so both the setup-time check and the runtime spawn
 *  failure surface the SAME help; re-exported from local/garage.ts for its existing importers. */
export const LLAMA_INSTALL_HINT =
  'llama-server (llama.cpp) is required to run local GGUF models, and was not found.\n' +
  '  Install it:\n' +
  '    macOS:        brew install llama.cpp\n' +
  '    Linux:        brew install llama.cpp   (or build from source)\n' +
  '    Windows:      download a release from https://github.com/ggml-org/llama.cpp/releases\n' +
  '                  and put llama-server.exe on your PATH\n' +
  '    from source:  https://github.com/ggml-org/llama.cpp\n' +
  "  Or point Shadow at an existing binary: set $SHADOW_LLAMA_SERVER, or the model preset's\n" +
  '  "ggufServer": "/path/to/llama-server" in ~/.shadow/config.json.';

interface Running {
  proc?: ChildProcess; // undefined when we reuse a server we didn't start
  baseUrl: string;
  /** The model this session-tracked server serves — hash ports can collide across entries. */
  target?: string;
}
const servers = new Map<string, Running>();
let exitHookInstalled = false;

/** Install guidance for the MLX backend (Apple Silicon). Mirrors LLAMA_INSTALL_HINT. */
export const MLX_INSTALL_HINT =
  'mlx_lm.server (mlx-lm) is required to run MLX models, and was not found.\n' +
  '  Install it (Apple Silicon Macs only):\n' +
  '    uv tool install mlx-lm      (or: pipx install mlx-lm · pip3 install mlx-lm)\n' +
  '  Or point Shadow at an existing install: set $SHADOW_MLX_SERVER to the mlx_lm.server path.';

/** Deterministic per-target port (8100–8999) so the same model reuses one server. */
function portFor(entry: ModelEntry): number {
  if (entry.ggufPort) return entry.ggufPort;
  const h = createHash('sha1').update(entry.gguf ?? entry.mlx ?? entry.vllm ?? '').digest();
  return 8100 + (h.readUInt16BE(0) % 900);
}

async function isUp(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(baseUrl.replace(/\/v1$/, '') + '/health', {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Readiness that works for BOTH backends: llama-server has /health; mlx_lm.server may not —
 *  an answering /v1/models is just as much proof of life. */
async function serverReady(baseUrl: string): Promise<boolean> {
  if (await isUp(baseUrl)) return true;
  try {
    const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', stopGgufServers);
  process.on('SIGINT', () => {
    stopGgufServers();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stopGgufServers();
    process.exit(143);
  });
}

/** True when a server already answers on this entry's port (ours or the user's own) — used by the
 *  startup pre-flight to skip the install prompt when there is nothing to install FOR. */
export async function ggufServerUp(entry: ModelEntry): Promise<boolean> {
  if (!entry.gguf && !entry.mlx && !entry.vllm && !entry.ggufPort) return false;
  return serverReady(`http://127.0.0.1:${portFor(entry)}/v1`);
}

/** Kill every llama.cpp server shadow started this session (best-effort). */
export function stopGgufServers(): void {
  for (const { proc } of servers.values()) {
    try {
      proc?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  servers.clear();
}

export interface GgufStartResult {
  baseUrl: string; // OpenAI-compatible base, e.g. http://127.0.0.1:8123/v1
  started: boolean; // true if we launched it, false if reused
}

/**
 * Ensure a llama.cpp server is serving `entry.gguf` locally and return its
 * OpenAI-compatible base URL. Reuses an already-listening server on the same port
 * (ours or the user's). First load of a large model is slow, so we wait up to 180s.
 */
/** Ask an already-running server what model it serves (llama-server exposes OpenAI /v1/models with
 *  the gguf path as the id). Returns the ids, or null when the endpoint is absent/unparseable. */
async function servedModelIds(baseUrl: string): Promise<string[] | null> {
  try {
    const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { id?: string }[] };
    if (!Array.isArray(j.data)) return null;
    return j.data.map((m) => m.id ?? '').filter(Boolean);
  } catch {
    return null;
  }
}

export async function ensureGgufServer(
  entry: ModelEntry,
  log?: (msg: string) => void,
): Promise<GgufStartResult> {
  if (!entry.gguf) throw new Error('ensureGgufServer called on a non-gguf model entry');
  if (!existsSync(entry.gguf)) {
    throw new Error(
      `gguf file not found: ${entry.gguf}\n` +
        '  The file may have been moved or deleted since it was registered.\n' +
        '  Check your models with `shadow local list`, then re-add it: `shadow local add <path-to.gguf>`.',
    );
  }

  const port = portFor(entry);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const tracked = servers.get(baseUrl);
  if (tracked) {
    if (tracked.target === entry.gguf) return { baseUrl, started: false };
    // Hash ports live in 900 buckets — two different local models CAN collide in one session.
    throw new Error(
      `port ${port} is already used this session by a different local model (${tracked.target ?? 'unknown'}).\n` +
        `  Give one of them its own port: set "ggufPort" on a model entry in ~/.shadow/config.json.`,
    );
  }
  if (await isUp(baseUrl)) {
    // Something is already serving on this model's port. Verify what we can before adopting it —
    // the port is hash-derived, so a stranger here would route the session to the WRONG model.
    // Evidence rules (reviewed): only PATH-LIKE ids (…/x.gguf) are strong enough to prove a
    // mismatch — llama-server started with `--alias main` reports "main", which proves nothing,
    // so alias ids reuse with a visible note instead of a false hard failure. Case-insensitive.
    const ids = await servedModelIds(baseUrl);
    const stem = (entry.gguf.split('/').pop() ?? entry.gguf).toLowerCase().replace(/\.gguf$/, '');
    if (ids === null || ids.length === 0) {
      // Answers /health but not /v1/models → almost certainly NOT a llama-server. Refuse rather
      // than silently routing the session (and its context) to an unknown local process.
      throw new Error(
        `port ${port} is occupied by a process that answers /health but not /v1/models — probably not a llama-server.\n` +
          `  Stop it, or give this model its own port: set "ggufPort" on the model entry in\n` +
          `  ~/.shadow/config.json (e.g. "ggufPort": ${port + 1}).`,
      );
    }
    const pathLike = ids.filter((id) => /\.gguf$/i.test(id) || id.includes('/'));
    const matches = (id: string): boolean => {
      const t = (id.split('/').pop() ?? id).toLowerCase().replace(/\.gguf$/, '');
      return t === stem || t.includes(stem) || stem.includes(t);
    };
    if (pathLike.length > 0 && !pathLike.some(matches)) {
      throw new Error(
        `port ${port} is already serving a DIFFERENT model (${pathLike[0]}), not ${stem}.\n` +
          `  Either stop that server, or give this model its own port: set "ggufPort" on the\n` +
          `  model entry in ~/.shadow/config.json (e.g. "ggufPort": ${port + 1}).`,
      );
    }
    const aliasNote = pathLike.length === 0 ? ` (reports alias "${ids[0]}" — assuming it serves ${stem})` : ` (${ids[0]})`;
    log?.(`Reusing the llama-server already running on port ${port}${aliasNote}.`);
    servers.set(baseUrl, { baseUrl, target: entry.gguf }); // reuse; don't track a proc we didn't spawn
    return { baseUrl, started: false };
  }

  const bin = entry.ggufServer || process.env.SHADOW_LLAMA_SERVER || resolveServerBin('llama-server');
  // Per-entry ctx (-c) and gpuLayers (-ngl) thread through from the Local Model Garage.
  // An explicit `ggufArgs` overrides everything (advanced/manual entries); otherwise we
  // build the args from ctx/gpuLayers, falling back to the historical defaults.
  const ngl = entry.gpuLayers ?? 999;
  const ctx = entry.ctx ?? 32768;
  const args = [
    '-m',
    entry.gguf,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    ...(entry.ggufArgs ?? ['-ngl', String(ngl), '-c', String(ctx), '--jinja']),
  ];
  log?.(`Starting local model server (${bin}, port ${port}) — first load can take a minute…`);
  installExitHook();

  let proc: ChildProcess;
  try {
    // Capture stderr: llama-server's own diagnostics (port bind conflict, bad gguf magic, OOM,
    // unsupported quant) are the ONLY way to state a cause when it dies — stdio:'ignore' used to
    // discard them, so every failure surfaced as a causeless "exited (code N)".
    proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  } catch (e) {
    throw new Error(`could not launch "${bin}": ${(e as Error).message}.\n${LLAMA_INSTALL_HINT}`);
  }
  await superviseUntilReady(proc, { bin, port, baseUrl, log, target: entry.gguf, installHint: LLAMA_INSTALL_HINT, timeoutHelp: 'Try a smaller quant, or lower the context: shadow local add <path> --ctx 16384.' });
  return { baseUrl, started: true };
}

/**
 * Shared spawn supervisor for BOTH local backends: ring-buffers stderr (the only place bind
 * conflicts / bad weights / OOM state a cause), watches for early exit, polls readiness
 * (/health OR /v1/models), and throws rich errors. Resolves when the server answers.
 */
async function superviseUntilReady(
  proc: ChildProcess,
  o: {
    bin: string;
    port: number;
    baseUrl: string;
    log?: (m: string) => void;
    target?: string;
    installHint: string;
    timeoutHelp: string;
    /** Readiness signal — defaults to /health-or-/v1/models. MLX passes a REAL inference probe
     *  because mlx_lm.server's /health lies (200 even after its loader thread has died). */
    ready?: () => Promise<boolean>;
    deadlineMs?: number;
  },
): Promise<void> {
  // Ring buffer of the last ~30 stderr lines (bounded — a chatty load can emit megabytes).
  const errTail: string[] = [];
  proc.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const l = line.trim();
      if (!l) continue;
      errTail.push(l);
      if (errTail.length > 30) errTail.shift();
    }
  });
  const tail = (n: number): string => {
    const t = errTail.slice(-n).join('\n    ');
    return t ? `\n  Server output (last lines):\n    ${t}` : '';
  };
  let spawnErr = '';
  proc.on('error', (e) => {
    spawnErr = (e as Error).message;
  });
  servers.set(o.baseUrl, { proc, baseUrl: o.baseUrl, target: o.target });

  const deadline = Date.now() + (o.deadlineMs ?? 180_000);
  let lastNote = 0;
  while (Date.now() < deadline) {
    if (spawnErr) {
      servers.delete(o.baseUrl);
      throw new Error(`"${o.bin}" failed to start: ${spawnErr}.\n${o.installHint}`);
    }
    if (proc.exitCode !== null) {
      servers.delete(o.baseUrl);
      // A bind conflict is the classic silent killer here — name it when stderr shows it.
      const bindHint = /bind|address already in use|EADDRINUSE/i.test(errTail.join('\n'))
        ? `\n  Port ${o.port} looks taken — stop the other process, or set "ggufPort" on this model entry in ~/.shadow/config.json.`
        : '';
      throw new Error(`"${o.bin}" exited (code ${proc.exitCode}) before it began serving.${bindHint}${tail(12)}`);
    }
    if (await (o.ready ? o.ready() : serverReady(o.baseUrl))) {
      o.log?.(`Local model ready on ${o.baseUrl}`);
      return;
    }
    if (Date.now() - lastNote > 15_000) {
      lastNote = Date.now();
      o.log?.('…still loading the model into memory');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  servers.delete(o.baseUrl);
  try {
    proc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  throw new Error(
    `"${o.bin}" did not become ready within 180s.\n` +
      `  Likely causes: the model is larger than available RAM/VRAM, or it is still downloading.\n  ${o.timeoutHelp}${tail(12)}`,
  );
}

function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

/** True when this string names a LOCAL directory (vs a HuggingFace repo id like
 *  "mlx-community/Qwen2.5-0.5B-Instruct-4bit"). Paths win when they exist on disk. */
export function isMlxDir(target: string): boolean {
  if (/^([/~.]|[A-Za-z]:\\)/.test(target)) return true;
  const abs = resolve(expandTilde(target));
  return existsSync(abs) && existsSync(join(abs, 'config.json'));
}

/** True when an MLX model DIRECTORY is multimodal (its config.json has a vision_config) — those load
 *  with mlx-vlm's server, not mlx_lm's text-only one. Repo ids can't be inspected pre-download → false. */
export function isMultimodalMlx(dir: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(resolve(expandTilde(dir)), 'config.json'), 'utf8')) as Record<string, unknown>;
    return Boolean(cfg.vision_config) || Boolean(cfg.image_token_id) || Boolean(cfg.image_token_index);
  } catch {
    return false;
  }
}

export const MLX_VLM_INSTALL_HINT =
  'mlx_vlm.server (mlx-vlm) is required to run MULTIMODAL MLX models, and was not found.\n' +
  '  Install it:  uv tool install mlx-vlm   (or: pip install mlx-vlm)\n' +
  '  Or point Shadow at an existing install: set $SHADOW_MLX_VLM_SERVER to the mlx_vlm.server path.';

/**
 * --offline gate: is this MLX target servable with ZERO network? A directory target is (weights
 * on disk); a repo id only once its weights are already in the HuggingFace cache — otherwise the
 * server would download mid-"offline" session, violating the no-egress contract.
 * `hubDir` is injectable for tests.
 */
export function mlxOfflineReady(target: string, hubDir = join(homedir(), '.cache', 'huggingface', 'hub')): boolean {
  if (isMlxDir(target)) return existsSync(resolve(expandTilde(target)));
  return existsSync(join(hubDir, 'models--' + target.replace(/\//g, '--'), 'snapshots'));
}

/** A REAL readiness/identity probe: one max_tokens=1 completion for THIS model. mlx_lm.server
 *  answers /health 200 unconditionally (even after its loader thread has died), and its
 *  /v1/models lists the HF CACHE, not what is loaded — a tiny inference is the only honest
 *  signal. Also doubles as reuse verification: the server hot-loads by the request's model
 *  field, so a probe that answers CAN serve this session, whatever else it has loaded. */
async function mlxProbe(baseUrl: string, model: string, timeoutMs: number): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure an `mlx_lm.server` is serving `entry.mlx` locally and return its OpenAI-compatible
 * base URL. Apple Silicon only. A repo-id target (mlx-community/…) is DOWNLOADED from
 * HuggingFace by mlx-lm on first serve — that one-time fetch is the only network involved
 * (and is refused entirely under --offline via HF_HUB_OFFLINE + the startup cache gate).
 */
export async function ensureMlxServer(
  entry: ModelEntry,
  log?: (msg: string) => void,
  opts: { offline?: boolean } = {},
): Promise<GgufStartResult> {
  if (!entry.mlx) throw new Error('ensureMlxServer called on a non-mlx model entry');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(
      'MLX models run on Apple Silicon Macs only (this machine is ' +
        `${process.platform}/${process.arch}). Use a .gguf model here instead: shadow local add <path-to.gguf>.`,
    );
  }
  // Resolve dir targets to ABSOLUTE up front — a relative "models/foo" must not flip between
  // "local dir" and "HF repo id" depending on the cwd Shadow was launched from.
  const dirTarget = isMlxDir(entry.mlx);
  const target = dirTarget ? resolve(entry.mlx.startsWith('~') ? join(homedir(), entry.mlx.slice(1)) : entry.mlx) : entry.mlx;
  if (dirTarget && (!existsSync(target) || !existsSync(join(target, 'config.json')))) {
    throw new Error(
      `MLX model folder not found (or missing config.json): ${target}\n` +
        '  Check your models with `shadow local list`, then re-add it: `shadow local add <mlx-folder>`.',
    );
  }

  const port = portFor(entry);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const tracked = servers.get(baseUrl);
  if (tracked) {
    if (tracked.target === entry.mlx || tracked.target === target) return { baseUrl, started: false };
    throw new Error(
      `port ${port} is already used this session by a different local model (${tracked.target ?? 'unknown'}).\n` +
        `  Give one of them its own port: set "ggufPort" on a model entry in ~/.shadow/config.json.`,
    );
  }
  if (await serverReady(baseUrl)) {
    // Reuse verification by INFERENCE, not catalog: mlx_lm.server's /v1/models lists the HF
    // cache (not what is loaded), so the only honest check is a max_tokens=1 completion for OUR
    // target — the server hot-loads by the request's model field, so success ⇒ it can serve us.
    log?.(`Found a server on port ${port} — verifying it can serve ${entry.mlx}…`);
    if (await mlxProbe(baseUrl, target, 60_000)) {
      log?.(`Reusing the mlx_lm.server already running on port ${port}.`);
      servers.set(baseUrl, { baseUrl, target: entry.mlx });
      return { baseUrl, started: false };
    }
    throw new Error(
      `port ${port} is occupied by a server that could not answer a completion for ${entry.mlx}.\n` +
        `  Stop it, or give this model its own port: set "ggufPort" on the model entry in\n` +
        `  ~/.shadow/config.json (e.g. "ggufPort": ${port + 1}).`,
    );
  }

  if (opts.offline && !mlxOfflineReady(entry.mlx)) {
    throw new Error(
      `--offline: "${entry.mlx}" is a repo id whose weights are not in the local HuggingFace cache —\n` +
        '  serving it would download from huggingface.co, which offline mode forbids.\n' +
        '  Run it once WITHOUT --offline to cache the weights, or point the entry at a local folder.',
    );
  }

  // Multimodal MLX models (a vision_config in config.json — e.g. a Gemma-4 unified VLM) load with
  // mlx-vlm's server, NOT mlx_lm's text-only one. Auto-detect for dir targets; both take --model/--host/
  // --port so the rest of the launch is identical. No Docker — the Apple-Silicon path for local VLMs.
  const multimodal = dirTarget && isMultimodalMlx(target);
  const bin = multimodal
    ? process.env.SHADOW_MLX_VLM_SERVER || resolveServerBin('mlx_vlm.server')
    : process.env.SHADOW_MLX_SERVER || resolveServerBin('mlx_lm.server');
  const installHint = multimodal ? MLX_VLM_INSTALL_HINT : MLX_INSTALL_HINT;
  const args = ['--model', target, '--host', '127.0.0.1', '--port', String(port)];
  const downloading = !dirTarget && !mlxOfflineReady(entry.mlx) ? ' (first run downloads the weights from HuggingFace)' : '';
  log?.(`Starting local ${multimodal ? 'MLX-VLM (multimodal)' : 'MLX'} server (${bin}, port ${port})${downloading} — first load can take a minute…`);
  installExitHook();

  let proc: ChildProcess;
  try {
    proc = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
      // Belt over the startup gate: under --offline the HF client itself is forbidden to fetch.
      env: opts.offline ? { ...process.env, HF_HUB_OFFLINE: '1' } : process.env,
    });
  } catch (e) {
    throw new Error(`could not launch "${bin}": ${(e as Error).message}.\n${installHint}`);
  }
  await superviseUntilReady(proc, {
    bin,
    port,
    baseUrl,
    log,
    target: entry.mlx,
    installHint,
    // Readiness = a real 1-token completion: /health lies (200 while — or after — the loader
    // thread dies), and this also confirms the WEIGHTS actually load, not just the HTTP server.
    ready: () => mlxProbe(baseUrl, target, 10_000),
    // Downloads can dwarf the 180s gguf budget; a dir target only pays model-load time.
    deadlineMs: downloading ? 900_000 : 300_000,
    timeoutHelp: downloading
      ? 'The download may still be running — re-run once it completes (weights are cached).'
      : 'The model may be larger than available memory — try a smaller quantization.',
  });
  return { baseUrl, started: true };
}

export const VLLM_INSTALL_HINT =
  'vLLM needs Linux + a CUDA GPU. Install it so `vllm serve` is on PATH (pip install vllm), or ensure Docker + ' +
  'the vllm/vllm-openai image are available (override the image with `vllmImage` or $SHADOW_VLLM_IMAGE).';

/** A vLLM target is a local dir when it looks like a path or exists on disk; otherwise a HF repo id. */
function isVllmDir(target: string): boolean {
  return target.startsWith('/') || target.startsWith('~') || target.startsWith('./') || existsSync(target);
}
function hasNativeVllm(): boolean {
  try {
    return spawnSync('which', ['vllm'], { stdio: 'ignore', timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Ensure a vLLM server is serving `entry.vllm` locally and return its OpenAI-compatible base URL.
 * Linux + CUDA only. Prefers native `vllm serve`; falls back to the vllm/vllm-openai Docker image.
 * The engine that covers the common GPU formats (safetensors / FP8 / AWQ / GPTQ / NVFP4 on Blackwell) —
 * exotic hand-tuned deployments keep their own launch scripts and are reached via `baseUrl` instead.
 */
export async function ensureVllmServer(
  entry: ModelEntry,
  log?: (msg: string) => void,
  opts: { offline?: boolean } = {},
): Promise<GgufStartResult> {
  if (!entry.vllm) throw new Error('ensureVllmServer called on a non-vllm model entry');
  if (process.platform !== 'linux') {
    throw new Error(
      `vLLM models run on Linux + CUDA only (this machine is ${process.platform}/${process.arch}). ` +
        'Use a .gguf (portable) or an MLX model (Apple Silicon) here instead.',
    );
  }
  const dirTarget = isVllmDir(entry.vllm);
  const target = dirTarget ? resolve(entry.vllm.startsWith('~') ? join(homedir(), entry.vllm.slice(1)) : entry.vllm) : entry.vllm;
  if (dirTarget && (!existsSync(target) || !existsSync(join(target, 'config.json')))) {
    throw new Error(
      `vLLM model folder not found (or missing config.json): ${target}\n` +
        '  Check your models with `shadow local list`, then re-add it: `shadow local add <model-folder>`.',
    );
  }
  if (opts.offline && !dirTarget) {
    throw new Error(
      `--offline: "${entry.vllm}" is a repo id whose weights would be fetched from huggingface.co.\n` +
        '  Point the entry at a local model folder instead.',
    );
  }

  const port = portFor(entry);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const tracked = servers.get(baseUrl);
  if (tracked) {
    if (tracked.target === entry.vllm || tracked.target === target) return { baseUrl, started: false };
    throw new Error(
      `port ${port} is already used this session by a different local model (${tracked.target ?? 'unknown'}).\n` +
        `  Give one of them its own port: set "ggufPort" on a model entry in ~/.shadow/config.json.`,
    );
  }
  if (await serverReady(baseUrl)) {
    log?.(`Reusing the vLLM server already running on port ${port}.`);
    servers.set(baseUrl, { baseUrl, target: entry.vllm });
    return { baseUrl, started: false };
  }

  const served = entry.model || 'model';
  // Shadow is an agentic harness — every turn sends tools with tool_choice:"auto", which vLLM rejects
  // ("auto tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set") unless
  // tool calling is turned on. Default to the broadly-compatible `hermes` parser; a model that needs a
  // different parser (qwen3_coder, llama3_json, mistral, …) overrides it via vllmArgs.
  const userArgs = entry.vllmArgs ?? [];
  const hasArg = (f: string) => userArgs.some((a) => a === f || a.startsWith(`${f}=`));
  const toolArgs: string[] = [];
  if (!hasArg('--enable-auto-tool-choice')) toolArgs.push('--enable-auto-tool-choice');
  if (!hasArg('--tool-call-parser')) toolArgs.push('--tool-call-parser', 'hermes');
  const serveArgs = [...toolArgs, ...userArgs];

  const native = hasNativeVllm();
  let bin: string;
  let args: string[];
  if (native) {
    bin = 'vllm';
    args = ['serve', target, '--host', '127.0.0.1', '--port', String(port), '--served-model-name', served, ...serveArgs];
  } else {
    const image = entry.vllmImage || process.env.SHADOW_VLLM_IMAGE || 'vllm/vllm-openai:latest';
    bin = 'docker';
    args = [
      'run', '--rm', '--name', `shadow-vllm-${port}`, '--gpus', 'all', '--ipc=host', '--network', 'host',
      '-v', `${homedir()}/.cache/huggingface:/root/.cache/huggingface`,
      ...(dirTarget ? ['-v', `${target}:${target}:ro`] : []),
      image, '--model', target, '--host', '127.0.0.1', '--port', String(port), '--served-model-name', served,
      ...serveArgs,
    ];
  }
  log?.(`Starting local vLLM server (${native ? 'native' : 'docker'}, port ${port}) — first load can take a few minutes…`);
  installExitHook();

  let proc: ChildProcess;
  try {
    proc = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
      env: opts.offline ? { ...process.env, HF_HUB_OFFLINE: '1' } : process.env,
    });
  } catch (e) {
    throw new Error(`could not launch vLLM via "${bin}": ${(e as Error).message}.\n${VLLM_INSTALL_HINT}`);
  }
  await superviseUntilReady(proc, {
    bin,
    port,
    baseUrl,
    log,
    target: entry.vllm,
    installHint: VLLM_INSTALL_HINT,
    ready: () => serverReady(baseUrl),
    // A large model (or a download) can take minutes on cold start; be generous.
    deadlineMs: dirTarget ? 600_000 : 1_200_000,
    timeoutHelp:
      'A large model can take several minutes to load — re-run once it warms up, or lower --max-model-len / ' +
      '--gpu-memory-utilization / --tensor-parallel-size via vllmArgs.',
  });
  return { baseUrl, started: true };
}

/** Route a local entry to its backend. The ONE entry point activation paths should use. */
export async function ensureLocalServer(
  entry: ModelEntry,
  log?: (msg: string) => void,
  opts: { offline?: boolean } = {},
): Promise<GgufStartResult> {
  if (entry.mlx) return ensureMlxServer(entry, log, opts);
  if (entry.vllm) return ensureVllmServer(entry, log, opts);
  return ensureGgufServer(entry, log);
}

/** True when a model entry is a locally-served model (gguf / mlx / vllm). */
export function isLocalServedEntry(entry: { gguf?: string; mlx?: string; vllm?: string } | undefined): boolean {
  return Boolean(entry?.gguf || entry?.mlx || entry?.vllm);
}
