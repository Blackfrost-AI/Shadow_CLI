// Local .gguf auto-serve — point shadow at a local model file and it launches a
// llama.cpp server for it (ollama-style), then talks to it over the OpenAI-compatible
// endpoint. A model entry opts in with `gguf: "/path/to/model.gguf"`; activation
// (startup or /model) ensures the server is up and routes to http://127.0.0.1:<port>/v1.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ModelEntry } from './config.js';

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
}
const servers = new Map<string, Running>();
let exitHookInstalled = false;

/** Deterministic per-path port (8100–8999) so the same model reuses one server. */
function portFor(entry: ModelEntry): number {
  if (entry.ggufPort) return entry.ggufPort;
  const h = createHash('sha1').update(entry.gguf ?? '').digest();
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
  if (!entry.gguf && !entry.ggufPort) return false;
  return isUp(`http://127.0.0.1:${portFor(entry)}/v1`);
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
  if (servers.has(baseUrl)) return { baseUrl, started: false };
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
    servers.set(baseUrl, { baseUrl }); // reuse; don't track a proc we didn't spawn
    return { baseUrl, started: false };
  }

  const bin = entry.ggufServer || process.env.SHADOW_LLAMA_SERVER || 'llama-server';
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
  servers.set(baseUrl, { proc, baseUrl });

  const deadline = Date.now() + 180_000;
  let lastNote = 0;
  while (Date.now() < deadline) {
    if (spawnErr) {
      servers.delete(baseUrl);
      throw new Error(`"${bin}" failed to start: ${spawnErr}.\n${LLAMA_INSTALL_HINT}`);
    }
    if (proc.exitCode !== null) {
      servers.delete(baseUrl);
      // A bind conflict is the classic silent killer here — name it when stderr shows it.
      const bindHint = /bind|address already in use|EADDRINUSE/i.test(errTail.join('\n'))
        ? `\n  Port ${port} looks taken — stop the other process, or set "ggufPort" on this model entry in ~/.shadow/config.json.`
        : '';
      throw new Error(`"${bin}" exited (code ${proc.exitCode}) before it began serving.${bindHint}${tail(12)}`);
    }
    if (await isUp(baseUrl)) {
      log?.(`Local model ready on ${baseUrl}`);
      return { baseUrl, started: true };
    }
    if (Date.now() - lastNote > 15_000) {
      lastNote = Date.now();
      log?.('…still loading the model into memory');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  servers.delete(baseUrl);
  try {
    proc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  throw new Error(
    `"${bin}" did not become ready within 180s.\n` +
      '  Likely causes: the model is larger than available RAM/VRAM, or the context (-c) is too big\n' +
      `  for this machine. Try a smaller quant, or lower the context: shadow local add <path> --ctx 16384.${tail(12)}`,
  );
}
