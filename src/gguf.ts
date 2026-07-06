// Local .gguf auto-serve — point shadow at a local model file and it launches a
// llama.cpp server for it (ollama-style), then talks to it over the OpenAI-compatible
// endpoint. A model entry opts in with `gguf: "/path/to/model.gguf"`; activation
// (startup or /model) ensures the server is up and routes to http://127.0.0.1:<port>/v1.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ModelEntry } from './config.js';

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
export async function ensureGgufServer(
  entry: ModelEntry,
  log?: (msg: string) => void,
): Promise<GgufStartResult> {
  if (!entry.gguf) throw new Error('ensureGgufServer called on a non-gguf model entry');
  if (!existsSync(entry.gguf)) throw new Error(`gguf file not found: ${entry.gguf}`);

  const port = portFor(entry);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  if (servers.has(baseUrl)) return { baseUrl, started: false };
  if (await isUp(baseUrl)) {
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
    proc = spawn(bin, args, { stdio: 'ignore', detached: false });
  } catch (e) {
    throw new Error(
      `could not launch "${bin}": ${(e as Error).message}. Install llama.cpp (llama-server) ` +
        `or set the model entry's "ggufServer" / $SHADOW_LLAMA_SERVER to its path.`,
    );
  }
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
      throw new Error(
        `"${bin}" failed to start: ${spawnErr}. Install llama.cpp or set "ggufServer".`,
      );
    }
    if (proc.exitCode !== null) {
      servers.delete(baseUrl);
      throw new Error(`"${bin}" exited (code ${proc.exitCode}) before it began serving`);
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
  throw new Error(`"${bin}" did not become ready within 180s — check the model path and resources`);
}
