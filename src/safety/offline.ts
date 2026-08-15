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
import { parseV6 } from './netguard.js';

/**
 * Cloud instance-metadata addresses in EVERY spelling. 169.254.169.254 is
 * AWS/GCP/Azure/Oracle IMDSv4; fd00:ec2::254 is AWS IMDSv6 — and it lives
 * inside fc00::/7 ULA, so the "local" classification below would otherwise
 * admit it under --offline. These are never a legitimate local serve.
 */
export function isCloudMetadataAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (h === '169.254.169.254') return true;
  if (isIP(h) !== 6) return false;
  const b = parseV6(h);
  if (!b) return false;
  const imdsv6 = parseV6('fd00:ec2::254')!;
  if (b.every((x, i) => x === imdsv6[i]!)) return true;
  // IPv4-embedded spellings of 169.254.169.254 (mapped/compat/NAT64) and the
  // v4-carrying transition tunnels (6to4, Teredo) — same unwrap netguard uses.
  const v4 = ((): string | null => {
    const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
    const compat = b.slice(0, 12).every((x) => x === 0) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] === 0);
    const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b;
    if (mapped || compat || nat64) return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    if (b[0] === 0x20 && b[1] === 0x02) return `${b[2]}.${b[3]}.${b[4]}.${b[5]}`; // 6to4
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
      return `${(~b[12]!) & 0xff}.${(~b[13]!) & 0xff}.${(~b[14]!) & 0xff}.${(~b[15]!) & 0xff}`; // Teredo
    }
    return null;
  })();
  return v4 === '169.254.169.254';
}

/** The startup banner printed once when offline mode is active. */
export const OFFLINE_BANNER =
  'Offline Shadow Mode — no provider network beyond your local model, no web tools.';

/**
 * Whether offline's "run_shell egress is denied" promise is actually enforced.
 * The denial rides on the OS sandbox, so it needs confinement ON (not --yolo /
 * --no-sandbox / full autonomy) AND the platform tool present — wrapCommand
 * fails open when bwrap/seatbelt are missing (src/safety/sandbox.ts). Every
 * surface that advertises the offline boundary (env block, startup banner)
 * must go through this one predicate so they can never disagree.
 */
export function offlineEgressEnforced(
  guard: { yolo?: boolean; noSandbox?: boolean; unrestricted?: boolean },
  sandboxToolPresent: boolean,
): boolean {
  return !guard.yolo && !guard.noSandbox && !guard.unrestricted && sandboxToolPresent;
}

/** The run_shell egress clause of the offline env line — truthful per enforcement (F07-04). */
export function offlineEgressClaim(enforced: boolean): string {
  return enforced
    ? 'run_shell network egress is denied.'
    : 'run_shell egress CANNOT be enforced on this host (no bwrap/seatbelt confinement active) — the OS will not block shell network access, so the no-network contract is yours to honor in every command.';
}

/** Startup warning printed beside OFFLINE_BANNER when the egress half of the promise is unenforceable. */
export const OFFLINE_UNENFORCED_WARNING =
  'Offline requested, but run_shell egress cannot be enforced on this host (no bwrap/seatbelt confinement) — ' +
  'shell commands run unconfined. Web tools and MCP stay disabled; the model is instructed to stay off the ' +
  'network, but the OS will not stop it.';

/**
 * Hostnames that count as "local": loopback, mDNS (`*.local`), and RFC-1918
 * private LAN ranges (10/8, 192.168/16, 172.16–31/12). Single source of truth
 * for local-endpoint detection (the context-budget heuristic in index.ts reuses
 * it via isLocalBaseUrl).
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().trim();
  if (!h) return false;
  // Metadata addresses are NEVER local, whatever the spelling — fd00:ec2::254
  // would otherwise match the ULA branch below and walk past the offline wall.
  if (isCloudMetadataAddress(h)) return false;
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
  // Bracketed IPv6 FIRST: `http://[::1]:8000` is a real local-serve shape, and the plain
  // `[^/:]+` capture below stops at the first colon INSIDE the brackets — yielding "[" and
  // reporting loopback as remote. isLocalHost wants the bare address, so strip the brackets.
  const v6 = baseUrl.match(/^[a-z]+:\/\/\[([^\]]+)\]/i)?.[1];
  if (v6) return isLocalHost(v6.toLowerCase());
  const host = (baseUrl.match(/^[a-z]+:\/\/([^/:]+)/i)?.[1] ?? '').toLowerCase();
  return isLocalHost(host);
}

/**
 * A model target is local when it auto-serves a local `.gguf` (llama.cpp) OR its
 * baseUrl host is local (Ollama / LM Studio / any LAN OpenAI-compatible server).
 */
export function isLocalModelTarget(target: { gguf?: string; mlx?: string; vllm?: string; baseUrl?: string }): boolean {
  if (target.gguf) return true;
  // MLX and vLLM auto-serve are loopback too. (A repo-id's one-time HF download is documented — after
  // that first fetch the weights are cached and serving is fully local.)
  if (target.mlx) return true;
  if (target.vllm) return true;
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
