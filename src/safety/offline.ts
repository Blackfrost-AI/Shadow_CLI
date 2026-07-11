/**
 * Offline Shadow Mode — the hard no-cloud, no-web privacy mode.
 *
 * When `--offline` is set, nothing may leave the machine except traffic to the
 * user's LOCAL model server: the web tools (web_fetch / web_search) and MCP
 * connectors are not registered, run_shell network egress is denied (when the OS
 * sandbox is active), and startup aborts unless the active model's endpoint is
 * local. The predicates below are pure so the decision is unit-testable without
 * spinning up a process.
 */
import { isIP } from 'node:net';

/** The startup banner printed once when offline mode is active. */
export const OFFLINE_BANNER =
  'Offline Shadow Mode — no provider network beyond your local model, no web tools.';

/**
 * Hostnames that count as "local": loopback, mDNS (`*.local`), and RFC-1918
 * private LAN ranges (10/8, 192.168/16, 172.16–31/12). Single source of truth
 * for local-endpoint detection (the context-budget heuristic in index.ts reuses
 * it via isLocalBaseUrl).
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().trim();
  if (!h) return false;
  if (h === 'localhost') return true;
  if (h.endsWith('.local')) return true; // mDNS
  // IP literals: validate as a REAL IP in a local range. A plain prefix test (`/^127\./`) is unsafe —
  // `127.0.0.1.evil.com` is a public hostname that starts with "127." and would leak the whole
  // conversation offline. isIP() returns 0 for such a hostname, so it correctly fails here.
  const v = isIP(h);
  if (v === 4) {
    const o = h.split('.').map((n) => parseInt(n, 10));
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    const [a, b] = o as [number, number, number, number];
    if (a === 127 || a === 0 || a === 10) return true; // loopback / unspecified / private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    return false;
  }
  if (v === 6) {
    return h === '::1' || h === '::' || h.startsWith('fe80') || (h[0] === 'f' && (h[1] === 'c' || h[1] === 'd'));
  }
  return false; // any other hostname is NOT local
}

/** Extract the host from a baseUrl and classify it. Empty/undefined → not local. */
export function isLocalBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  const host = (baseUrl.match(/^[a-z]+:\/\/([^/:]+)/i)?.[1] ?? '').toLowerCase();
  return isLocalHost(host);
}

/**
 * A model target is local when it auto-serves a local `.gguf` (llama.cpp) OR its
 * baseUrl host is local (Ollama / LM Studio / any LAN OpenAI-compatible server).
 */
export function isLocalModelTarget(target: { gguf?: string; mlx?: string; baseUrl?: string }): boolean {
  if (target.gguf) return true;
  // MLX auto-serve is loopback too. (A repo-id's one-time HF download is documented — after
  // that first fetch the weights are cached and serving is fully local.)
  if (target.mlx) return true;
  return isLocalBaseUrl(target.baseUrl);
}

export interface OfflineDecision {
  ok: boolean;
  /** Friendly error explaining how to get a local model (set only when !ok). */
  error?: string;
}

/**
 * Decide whether an offline run may proceed for the given active model. Pure +
 * synchronous so the guard is unit-testable without a live process. On rejection
 * the error tells the user exactly how to switch to a local model.
 */
export function evaluateOffline(active: {
  label?: string;
  gguf?: string;
  mlx?: string;
  baseUrl?: string;
}): OfflineDecision {
  if (isLocalModelTarget(active)) return { ok: true };
  const label = active.label ?? 'active';
  const endpoint = active.baseUrl ? `endpoint ${active.baseUrl}` : 'a cloud provider';
  return {
    ok: false,
    error:
      `Offline Shadow Mode needs a LOCAL model — nothing may leave the machine except traffic to your own model server.\n` +
      `The active model "${label}" uses ${endpoint}, which is not local.\n` +
      `Fix it by switching to a local model:\n` +
      `  • shadow local list                     list installed .gguf models\n` +
      `  • shadow local use <name>               activate one\n` +
      `  • shadow local add <path-to.gguf>       add a new one (optional --name <name>)\n` +
      `or point --base-url / a model preset at a localhost / LAN / Ollama / LM Studio endpoint.`,
  };
}
