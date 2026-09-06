import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import { loadGlobalConfig, saveGlobalConfig, vaultUnlocked } from '../../state/globalStore.js';
import { shadowFetch } from '../../safety/egress.js';
import { vaultExists } from '../../auth/vault.js';
import {
  normalizeBaseUrl,
  resolveBaseUrl,
  resolveEntryCredential,
  type ModelEntry,
} from '../../config.js';
import { findModelPreset } from '../../config/modelPresets.js';
import { contextValue } from '../../gguf.js';

/**
 * Endpoint harness for `shadow web`. The browser runs under CSP `connect-src 'self'`
 * (src/web/security.ts), so it can NEVER fetch a LAN/external URL directly — every probe here runs
 * server-side in Node and returns only non-secret facts (reachable? latency? served models? backend
 * kind?). This turns the Models surface from blind CRUD into a real harness: point it at a
 * self-hosted box and see whether it's alive before committing.
 *
 * Three discovery modes, all opt-in:
 *   • ad-hoc probe   — POST /api/endpoints/probe {baseUrl}
 *   • pinned hosts   — a PERMANENT "known endpoint" (config.json → endpoints.known[]) whose PORT may
 *                      change; POST /api/endpoints/resolve is the "doctor" that probes the host
 *                      across candidate ports and reports whatever is running right now.
 *   • LAN scan       — POST /api/endpoints/scan enumerates private /24s on known inference ports.
 *
 * Hardening (the server is loopback-only + token-gated, so probing your own LAN/WG is the intended
 * use, not an SSRF hole — but we still guard): scheme allowlist http/https (normalizeBaseUrl rejects
 * everything else), redirect:'manual' (never followed), AbortSignal timeouts on every fetch, and a
 * 1 MB streaming body cap. Secrets are resolved server-side and NEVER serialized into a response.
 */

// ── result shapes ──────────────────────────────────────────────────────────────

export type ProbeErrorKind =
  | 'invalid-url'
  | 'timeout'
  | 'refused'
  | 'dns'
  | 'unreachable'
  | 'tls'
  | 'redirect'
  | 'auth-required'
  | 'http-status'
  | 'bad-json'
  | 'not-found'
  /** The egress broker refused the probe (offline wall, cloud-metadata address, quarantine). */
  | 'blocked';

export interface ServedModel {
  id: string;
  ownedBy?: string;
  contextWindow?: number;
}

export interface ProbeResult {
  ok: boolean;
  /** Which probe path answered, e.g. '/v1/models' — a diagnostic, not a secret. */
  reached?: string;
  status?: number;
  latencyMs?: number;
  /** Served model ids (empty on failure / health-only success). */
  servedModels: string[];
  /** Full served-model objects with per-model context window when the server reports one. */
  models?: ServedModel[];
  /** Backend kind sniffed from `owned_by` (authoritative) — e.g. 'vllm', 'ollama'. */
  server?: string;
  /** Raw HTTP `server` header (diagnostic only; often generic like 'uvicorn'). */
  serverHeader?: string;
  /** Server-wide context window if the response carried one. */
  contextWindow?: number;
  error?: string;
  errorKind?: ProbeErrorKind;
  /** Non-fatal advisory, e.g. 'credential-unavailable' when the vault is locked. */
  note?: string;
}

export interface KnownEndpoint {
  host: string;
  label?: string;
  ports?: number[];
}

export interface ResolveHit extends ProbeResult {
  port: number;
  baseUrl: string;
}

export interface ResolveResult {
  host: string;
  tried: number[];
  alive: ResolveHit[];
  elapsedMs: number;
}

export interface LanSubnet {
  cidr: string;
  base: string; // first three octets, e.g. '192.168.1'
  ownIp: string; // this host's address on that interface
}

export interface ScanHit extends ProbeResult {
  host: string;
  via: string; // 'host:port' that answered
  baseUrl: string;
  port: number;
}

export interface ScanResult {
  subnets: LanSubnet[];
  results: ScanHit[];
  truncated: boolean;
  cap: number;
  elapsedMs: number;
}

// ── constants ──────────────────────────────────────────────────────────────────

/** Known inference-server ports. A SCAN is restricted to this allowlist (never a port-range sweep);
 *  a pinned host the user explicitly configures may name any port. 30000 (SGLang) is included — the
 *  founder's WireGuard vLLM box lives there. */
const PORT_ALLOWLIST = [8000, 8080, 11434, 1234, 30000, 5000, 8001] as const;
const DEFAULT_PORTS: number[] = [...PORT_ALLOWLIST];

/** Curated quick-picks for the UI. Server-side so the list can grow without a client change. */
const QUICKPICKS = [
  { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
  { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { name: 'SGLang', baseUrl: 'http://127.0.0.1:30000/v1' },
];

class ProbeError extends Error {
  kind: ProbeErrorKind;
  constructor(kind: ProbeErrorKind, message: string) {
    super(message);
    this.name = 'ProbeError';
    this.kind = kind;
  }
}

// ── small pure helpers ───────────────────────────────────────────────────────────

function dedupe(a: number[]): number[] {
  return [...new Set(a)];
}

function clampTimeout(ms: unknown, dflt = 2500, lo = 500, hi = 10000): number {
  const n = Number(ms);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function clampMaxHosts(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 256;
  return Math.min(512, Math.max(1, Math.round(n)));
}

/** Ports for a broad SCAN: intersect the request with the fixed allowlist (no arbitrary sweeps). */
function sanitizeScanPorts(req: unknown): number[] {
  if (!Array.isArray(req) || req.length === 0) return DEFAULT_PORTS;
  const allow = new Set<number>(PORT_ALLOWLIST);
  const out = req.map(Number).filter((p) => Number.isFinite(p) && allow.has(p));
  return dedupe(out.length ? out : DEFAULT_PORTS);
}

/** Ports for a TARGETED resolve of a pinned host: honour explicit ports (1..65535), else defaults. */
function resolvePorts(req: unknown): number[] {
  if (Array.isArray(req) && req.length) {
    const out = req
      .map(Number)
      .filter((p) => Number.isFinite(p) && p >= 1 && p <= 65535)
      .map((p) => Math.round(p));
    if (out.length) return dedupe(out).slice(0, 16); // ≤16 ports per host
  }
  return DEFAULT_PORTS;
}

/** Validate + normalize a probe target. normalizeBaseUrl already enforces the http/https allowlist
 *  (returns undefined for any other scheme or an unparseable URL) — that IS SSRF guard #1. */
export function assertProbeableUrl(raw: unknown): URL {
  const clean = normalizeBaseUrl(typeof raw === 'string' ? raw : undefined);
  if (!clean) throw new ProbeError('invalid-url', 'Enter a valid http(s) URL (e.g. http://127.0.0.1:8000/v1).');
  let u: URL;
  try {
    u = new URL(clean);
  } catch {
    throw new ProbeError('invalid-url', 'Enter a valid http(s) URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ProbeError('invalid-url', 'Only http and https endpoints can be probed.');
  }
  return u;
}

/** Normalize a pinned host: accept a bare IP/host or a full URL, return just the host token. */
export function normalizeHost(raw: unknown): string {
  let s = String(raw ?? '').trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      /* fall through and validate the raw token below */
    }
  }
  s = s.replace(/^\[|\]$/g, '').split('/')[0].trim();
  if (!s) throw new ProbeError('invalid-url', 'Enter a host or IP (e.g. 192.168.1.20 or mybox.local).');
  if (!/^[A-Za-z0-9.\-:]+$/.test(s)) throw new ProbeError('invalid-url', `"${s}" is not a valid host or IP.`);
  return s;
}

function isPrivateIpv4(ip: string): boolean {
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || /^127\./.test(h) || isPrivateIpv4(h);
}

/** Map a thrown fetch error to a typed ProbeErrorKind (ground-truthed against Node's undici:
 *  TimeoutError.name for AbortSignal timeouts, e.cause.code for ECONNREFUSED/ENOTFOUND/etc.). */
export function classifyFetchError(e: unknown): { kind: ProbeErrorKind; message: string } {
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  const name = err?.name;
  const code = err?.cause?.code ?? err?.code;
  const cmsg = String(err?.cause?.message ?? err?.message ?? '');
  if (name === 'TimeoutError' || code === 'ETIMEDOUT') return { kind: 'timeout', message: cmsg };
  if (code === 'ECONNREFUSED') return { kind: 'refused', message: cmsg };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'dns', message: cmsg };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') return { kind: 'unreachable', message: cmsg };
  if (typeof code === 'string' && (code.startsWith('ERR_TLS') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'EPROTO')) {
    return { kind: 'tls', message: cmsg };
  }
  if (/tls|ssl|certificate/i.test(cmsg)) return { kind: 'tls', message: cmsg };
  if (/redirect/i.test(cmsg)) return { kind: 'redirect', message: cmsg };
  // Egress-broker refusals (shadowFetch throws plain Errors, no code): offline wall, the
  // cloud-metadata block, fail-closed DNS, and quarantine all land here.
  if (/offline mode:|egress blocked:|egress quarantine:/i.test(cmsg)) return { kind: 'blocked', message: cmsg };
  return { kind: 'unreachable', message: cmsg };
}

function humanNet(kind: ProbeErrorKind, u: URL): string {
  const host = u.hostname;
  const hint = isPrivateHost(host)
    ? ' If this is a WireGuard/VPN or LAN box, check the IP octets — a transposed octet routes out the wrong interface and silently times out — and confirm the tunnel is up.'
    : '';
  switch (kind) {
    case 'timeout':
      return `Timed out reaching ${host}; it did not answer in time.${hint}`;
    case 'refused':
      return `Connection refused by ${host}; nothing is listening on that port.${hint}`;
    case 'dns':
      return `Could not resolve host "${host}".`;
    case 'tls':
      return `TLS error contacting ${host}.`;
    case 'unreachable':
      return `Could not reach ${host}.${hint}`;
    case 'blocked':
      return `Shadow's egress policy blocked the probe to ${host} (offline mode, a cloud-metadata address, or the egress allowlist).`;
    default:
      return `Could not reach ${host}.`;
  }
}

/** Strip a trailing /v1 and slashes so we can build canonical probe paths from any base. */
function baseOrigin(u: URL): string {
  let path = u.pathname.replace(/\/+$/, '');
  path = path.replace(/\/v1$/, '').replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

function probeCandidates(base: string): { path: string; url: string }[] {
  return [
    { path: '/v1/models', url: `${base}/v1/models` },
    { path: '/models', url: `${base}/models` },
    { path: '/health', url: `${base}/health` },
  ];
}

// ── capped fetch ───────────────────────────────────────────────────────────────

interface CappedResult {
  res?: Response;
  bodyText?: string;
  truncated?: boolean;
  error?: unknown;
}

/** shadowFetch (the one egress chokepoint — offline wall, cloud-metadata block, DNS pinning,
 *  receipt) with redirect:'manual' (never follows), an AbortSignal timeout, and a streaming byte
 *  cap. purpose 'local-probe' + origin 'user': operator-directed loopback/LAN probing, so the
 *  metadata tier applies (no netguard, no quarantine gate). Never throws — failures come back
 *  as {error} for classification. */
async function cappedFetch(url: string, init: RequestInit, maxBytes = 1 << 20): Promise<CappedResult> {
  try {
    const res = await shadowFetch(url, { ...init, redirect: 'manual' }, { purpose: 'local-probe', origin: 'user' });
    const reader = res.body?.getReader();
    if (!reader) return { res, bodyText: '' };
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        size += value.byteLength;
        if (size > maxBytes) {
          truncated = true;
          try {
            await reader.cancel();
          } catch {
            /* already closing */
          }
          break;
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { res, bodyText: Buffer.concat(chunks).toString('utf8'), truncated };
  } catch (e) {
    return { error: e };
  }
}

// ── models JSON parsing ────────────────────────────────────────────────────────

/** `owned_by` from the served-model list is authoritative; the HTTP `server` header is only a
 *  fallback for non-generic servers (vLLM sits behind 'uvicorn', which tells us nothing). */
export function sniffServerKind(json: unknown, serverHeader?: string | null): string | undefined {
  const data = (json as { data?: unknown })?.data;
  if (Array.isArray(data)) {
    for (const m of data) {
      const ob = (m as { owned_by?: unknown })?.owned_by;
      if (typeof ob === 'string' && ob.trim()) return ob.trim().toLowerCase();
    }
  }
  if (serverHeader) {
    const h = serverHeader.toLowerCase();
    if (h.includes('ollama')) return 'ollama';
    if (h.includes('vllm')) return 'vllm';
    if (h.includes('sglang')) return 'sglang';
    if (h.includes('llama')) return 'llama.cpp';
    // uvicorn/gunicorn/nginx/fastapi are generic proxies/servers — not a backend id.
  }
  return undefined;
}

function parseModelsJson(text: string): { models: ServedModel[]; ids: string[]; contextWindow?: number; json: unknown } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    // A health/props object, or something else — no model list, but maybe a server-wide ctx.
    return { models: [], ids: [], contextWindow: contextValue(json), json };
  }
  const models: ServedModel[] = [];
  for (const m of data) {
    if (typeof m === 'string') {
      models.push({ id: m });
      continue;
    }
    if (m && typeof m === 'object') {
      const rec = m as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id : typeof rec.model === 'string' ? rec.model : undefined;
      if (!id) continue;
      const cw = contextValue(m); // per-model context window (max_model_len / context_length / …)
      const ob = typeof rec.owned_by === 'string' ? rec.owned_by : undefined;
      models.push({ id, ...(ob ? { ownedBy: ob } : {}), ...(cw ? { contextWindow: cw } : {}) });
    }
  }
  return { models, ids: models.map((m) => m.id), contextWindow: contextValue(json), json };
}

// ── the core probe ───────────────────────────────────────────────────────────────

export interface ProbeOpts {
  provider?: string;
  timeoutMs?: number;
  apiKey?: string;
  authToken?: string;
}

/**
 * Probe one endpoint for reachability. Tries `${base}/v1/models` → `${base}/models` → `${base}/health`
 * (mirroring gguf.ts's serverReady/servedModelIds/isUp), attaching an Authorization header ONLY if a
 * credential was resolved server-side. Returns a ProbeResult — NEVER throws, NEVER echoes a secret.
 *
 * // TODO(endpoints): deep capability check. Today this is quick reachability only. The natural
 * // extension point is src/doctor/modelCheck.ts's runModelCheck (agentic/limited/chat-only verdict);
 * // the result shape leaves room for a future `capabilities?` field. Do NOT wire it in now.
 */
export async function probeEndpoint(baseUrlRaw: unknown, opts: ProbeOpts = {}): Promise<ProbeResult> {
  let u: URL;
  try {
    u = assertProbeableUrl(baseUrlRaw);
  } catch (e) {
    const kind: ProbeErrorKind = e instanceof ProbeError ? e.kind : 'invalid-url';
    const message = e instanceof Error ? e.message : 'Invalid endpoint URL.';
    return { ok: false, servedModels: [], error: message, errorKind: kind };
  }

  const base = baseOrigin(u);
  const timeout = clampTimeout(opts.timeoutMs);
  const headers: Record<string, string> = { accept: 'application/json' };
  const secret = opts.apiKey || opts.authToken;
  if (secret) headers.authorization = `Bearer ${secret}`; // sent, never returned

  let lastNet: { kind: ProbeErrorKind; message: string } | undefined;
  let sawRedirect: { status: number; loc: string | null } | undefined;
  let lastHttp: { status: number } | undefined;

  for (const c of probeCandidates(base)) {
    const t0 = performance.now();
    const r = await cappedFetch(c.url, { method: 'GET', headers, signal: AbortSignal.timeout(timeout) });
    if (r.error) {
      lastNet = classifyFetchError(r.error);
      // The cascade discovers PATHS on a server that ANSWERS. A timeout/refusal/DNS/TLS/egress
      // failure proves the origin itself is silent — the remaining candidates would each burn
      // the full timeout for the same verdict. Early-out: a dead host costs one timeout, not
      // three (this is what keeps the LAN scan inside its deadline: 0.7s per dead host instead
      // of 2.1s, so the pool covers 3x more of the interleaved target list before the 8s stop).
      if (lastNet.kind !== 'redirect') break;
      continue;
    }
    const res = r.res as Response;
    const latencyMs = Math.round(performance.now() - t0);

    if (res.status >= 300 && res.status < 400) {
      sawRedirect = { status: res.status, loc: res.headers.get('location') };
      continue; // don't follow; a later candidate may still hit the real path
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reached: c.path,
        status: res.status,
        latencyMs,
        servedModels: [],
        error: `Server is up but requires authentication (${res.status}). Add an API key for this endpoint.`,
        errorKind: 'auth-required',
      };
    }
    if (res.ok) {
      const serverHeader = res.headers.get('server') ?? undefined;
      const parsed = parseModelsJson(r.bodyText ?? '');
      const kind = sniffServerKind(parsed?.json, serverHeader);
      if (parsed) {
        return {
          ok: true,
          reached: c.path,
          status: res.status,
          latencyMs,
          servedModels: parsed.ids,
          models: parsed.models,
          ...(kind ? { server: kind } : {}),
          ...(serverHeader ? { serverHeader } : {}),
          ...(parsed.contextWindow ? { contextWindow: parsed.contextWindow } : {}),
        };
      }
      // 2xx with a non-JSON body (e.g. a plain-text /health) — reachable, but no model list.
      return { ok: true, reached: c.path, status: res.status, latencyMs, servedModels: [], ...(serverHeader ? { serverHeader } : {}) };
    }
    lastHttp = { status: res.status };
  }

  // All candidates failed. Report the most informative cause: network > redirect > http status.
  if (lastNet) return { ok: false, servedModels: [], error: humanNet(lastNet.kind, u), errorKind: lastNet.kind };
  if (sawRedirect) {
    return {
      ok: false,
      servedModels: [],
      status: sawRedirect.status,
      error: `Server redirected (${sawRedirect.status}${sawRedirect.loc ? ` → ${sawRedirect.loc}` : ''}); redirects are not followed. Enter the exact path it points to.`,
      errorKind: 'redirect',
    };
  }
  if (lastHttp) {
    const kind: ProbeErrorKind = lastHttp.status === 404 ? 'not-found' : 'http-status';
    return {
      ok: false,
      servedModels: [],
      status: lastHttp.status,
      error:
        kind === 'not-found'
          ? `Server answered 404 on every probe path (/v1/models, /models, /health). It's reachable but doesn't expose a model list there.`
          : `Server answered HTTP ${lastHttp.status} on every probe path.`,
      errorKind: kind,
    };
  }
  return { ok: false, servedModels: [], error: humanNet('unreachable', u), errorKind: 'unreachable' };
}

// ── pinned "known endpoints" store (config.json → endpoints.known[]) ──────────────

function readKnownFrom(cfg: Record<string, unknown>): KnownEndpoint[] {
  const ep = (cfg as { endpoints?: unknown }).endpoints;
  const known = ep && typeof ep === 'object' ? (ep as { known?: unknown }).known : undefined;
  if (!Array.isArray(known)) return [];
  const out: KnownEndpoint[] = [];
  for (const k of known) {
    if (k && typeof k === 'object' && typeof (k as { host?: unknown }).host === 'string') {
      const host = (k as { host: string }).host.trim();
      if (!host) continue;
      const item: KnownEndpoint = { host };
      const label = (k as { label?: unknown }).label;
      if (typeof label === 'string' && label.trim()) item.label = label.trim().slice(0, 64);
      const ports = (k as { ports?: unknown }).ports;
      if (Array.isArray(ports)) {
        const p = dedupe(ports.map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 65535).map((n) => Math.round(n)));
        if (p.length) item.ports = p.slice(0, 16);
      }
      out.push(item);
    }
  }
  return out;
}

export function readKnown(): KnownEndpoint[] {
  return readKnownFrom(loadGlobalConfig());
}

/** Persist the pinned list, preserving any sibling keys under `endpoints`. */
export function writeKnown(list: KnownEndpoint[]): void {
  const cfg = loadGlobalConfig();
  const prev = (cfg as { endpoints?: unknown }).endpoints;
  const ep: Record<string, unknown> = prev && typeof prev === 'object' ? { ...(prev as Record<string, unknown>) } : {};
  ep.known = list;
  saveGlobalConfig({ endpoints: ep });
}

// ── the "doctor": resolve a pinned host across ports ────────────────────────────

/** Bounded worker pool — `limit` concurrent `fn` invocations over `items`, preserving order. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) break;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Probe one host across candidate ports and return every port that's alive right now. This is the
 * "doctor" for a pinned endpoint whose port may change — the host is permanent, the port is
 * discovered. Ports are probed in parallel (bounded), hits sorted fastest-first.
 */
export async function resolveHost(
  host: string,
  opts: { ports?: number[]; timeoutMs?: number; provider?: string; apiKey?: string; authToken?: string } = {},
): Promise<ResolveResult> {
  const h = normalizeHost(host);
  const ports = resolvePorts(opts.ports);
  const timeout = clampTimeout(opts.timeoutMs);
  const t0 = performance.now();
  const hits = await runPool(ports, 8, async (port) => {
    const baseUrl = `http://${h}:${port}/v1`;
    const r = await probeEndpoint(baseUrl, { provider: opts.provider, apiKey: opts.apiKey, authToken: opts.authToken, timeoutMs: timeout });
    return { port, baseUrl, ...r } as ResolveHit;
  });
  const alive = hits.filter((x) => x && x.ok);
  alive.sort((a, b) => (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9));
  return { host: h, tried: ports, alive, elapsedMs: Math.round(performance.now() - t0) };
}

// ── LAN scan (opt-in, runaway-proof) ─────────────────────────────────────────────

type IfaceMap = Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>;

/**
 * Derive candidate private /24s from this machine's interfaces. `ifaces` is injectable so tests run
 * hermetically (no sockets). We iterate EVERY interface (no name allowlist, so WireGuard utun, wg,
 * and tailscale interfaces are included) and derive the /24 from the address's first three octets REGARDLESS of netmask — a
 * WireGuard tunnel address is a point-to-point /32, and trusting the netmask would enumerate nothing.
 * A wide /16 collapses to the host's own /24 slice. Loopback, link-local (169.254/16), IPv6 and
 * public addresses are skipped.
 */
export function lanSubnets(ifaces: IfaceMap = os.networkInterfaces() as unknown as IfaceMap): LanSubnet[] {
  const out: LanSubnet[] = [];
  const seen = new Set<string>();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = a.address;
      if (!ip || !isPrivateIpv4(ip)) continue;
      if (ip.startsWith('169.254.')) continue; // link-local / APIPA
      const oct = ip.split('.');
      if (oct.length !== 4) continue;
      const base = `${oct[0]}.${oct[1]}.${oct[2]}`; // /24 from octets, ignoring netmask (WG /32 fix)
      const cidr = `${base}.0/24`;
      if (seen.has(cidr)) continue;
      seen.add(cidr);
      out.push({ cidr, base, ownIp: ip });
    }
  }
  return out;
}

/**
 * Enumerate .1–.254 of each subnet (minus the interface's own IP), then round-robin interleave
 * across subnets BEFORE applying the host cap. Sequential concatenation lets the first subnet
 * consume the entire cap — observed live: the first /24 ate all 256 slots and the WireGuard box on
 * the second subnet was never probed. Interleaved, a truncated scan keeps the low range of
 * EVERY subnet, which is where self-hosted boxes usually sit. Pure — exported for tests.
 */
export function interleavedHosts(subnets: LanSubnet[], cap: number): { targets: string[]; truncated: boolean } {
  const perSubnet: string[][] = subnets.map((s) => {
    const list: string[] = [];
    for (let i = 1; i <= 254; i++) {
      const ip = `${s.base}.${i}`;
      if (ip === s.ownIp) continue; // never scan ourselves
      list.push(ip);
    }
    return list;
  });
  const hosts: string[] = [];
  const longest = Math.max(0, ...perSubnet.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of perSubnet) {
      if (i < list.length) hosts.push(list[i]!);
    }
  }
  return { targets: hosts.slice(0, cap), truncated: hosts.length > cap };
}

/**
 * Opt-in LAN scan: enumerate private /24 hosts on the fixed inference-port allowlist. Bounded every
 * which way — host cap (default 256 / ceiling 512, pre-truncated with per-subnet coverage kept by
 * interleavedHosts), concurrency 16, per-host timeout 700ms, and an overall 8s deadline after which
 * we stop dispatching and return partial results. Only live hosts (ok:true) are returned; 254 dead
 * rows would be noise.
 */
export async function scanLan(
  opts: { ports?: number[]; maxHosts?: number; timeoutMs?: number; ifaces?: IfaceMap } = {},
): Promise<ScanResult> {
  const t0 = performance.now();
  const subnets = lanSubnets(opts.ifaces);
  const ports = sanitizeScanPorts(opts.ports);
  const cap = clampMaxHosts(opts.maxHosts);
  const perHostTimeout = clampTimeout(opts.timeoutMs, 700, 200, 3000);
  const deadline = Date.now() + 8000;

  const { targets, truncated } = interleavedHosts(subnets, cap);
  const results: ScanHit[] = [];

  // Outer pool over hosts (concurrency 16); each host probes all ports in parallel, so a host costs
  // at most one per-host timeout and a fast box is found even if its neighbours are dead.
  await runPool(targets, 16, async (host) => {
    if (Date.now() > deadline) return;
    const hits = await Promise.all(
      ports.map(async (port) => {
        const baseUrl = `http://${host}:${port}/v1`;
        const r = await probeEndpoint(baseUrl, { timeoutMs: perHostTimeout });
        return r.ok ? ({ host, via: `${host}:${port}`, baseUrl, port, ...r } as ScanHit) : null;
      }),
    );
    const hit = hits.find(Boolean);
    if (hit) results.push(hit);
  });

  results.sort((a, b) => (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9));
  return { subnets, results, truncated, cap, elapsedMs: Math.round(performance.now() - t0) };
}

// ── routes ─────────────────────────────────────────────────────────────────────

function allEntries(): ModelEntry[] {
  const cfg = loadGlobalConfig();
  return Array.isArray(cfg.models) ? (cfg.models as ModelEntry[]) : [];
}

export function registerEndpointsRoutes(route: RouteFn, _ctx: ApiContext): void {
  // POST /api/endpoints/probe — ad-hoc, no credential. 200 with ok:false for unreachable (a probe
  // ran = data); 400 only for an invalid URL / bad body.
  route('POST', /^\/api\/endpoints\/probe$/, async (req: IncomingMessage) => {
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return { status: 400, body: { error: 'invalid body' } };
    try {
      assertProbeableUrl(body.baseUrl);
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : 'invalid url', errorKind: 'invalid-url' } };
    }
    const result = await probeEndpoint(body.baseUrl, {
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      timeoutMs: body.timeoutMs as number | undefined,
    });
    return { status: 200, body: result };
  });

  // POST /api/endpoints/probe-preset — probe a saved preset WITH its credential, resolved server-side.
  // The secret is used to authenticate but NEVER serialized into the response.
  route('POST', /^\/api\/endpoints\/probe-preset$/, async (req: IncomingMessage) => {
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    const label = typeof body?.label === 'string' ? body.label : '';
    if (!label) return { status: 400, body: { error: 'label is required' } };
    const entry = findModelPreset(allEntries(), label);
    if (!entry) return { status: 404, body: { error: `No model preset named "${label}".` } };
    const baseUrl = resolveBaseUrl(entry.provider, entry.baseUrl);
    if (!baseUrl) return { status: 400, body: { error: 'That preset has no probeable base URL.' } };
    const cred = resolveEntryCredential(entry, { vaultIsLocked: vaultExists() && !vaultUnlocked() });
    let apiKey: string | undefined;
    let authToken: string | undefined;
    let note: string | undefined;
    if (cred.ok) {
      apiKey = cred.apiKey;
      authToken = cred.authToken;
    } else {
      note = 'credential-unavailable'; // vault locked or slot empty — probe unauth rather than fail
    }
    const result = await probeEndpoint(baseUrl, { provider: entry.provider, apiKey, authToken, timeoutMs: body?.timeoutMs as number | undefined });
    if (note) result.note = note;
    return { status: 200, body: result };
  });

  // POST /api/endpoints/scan — opt-in LAN scan (clamped + allowlisted).
  route('POST', /^\/api\/endpoints\/scan$/, async (req: IncomingMessage) => {
    const body = ((await readJsonBody(req)) as Record<string, unknown> | null) ?? {};
    const result = await scanLan({
      ports: sanitizeScanPorts(body.ports),
      maxHosts: clampMaxHosts(body.maxHosts),
      timeoutMs: body.timeoutMs as number | undefined,
    });
    return { status: 200, body: result };
  });

  // GET /api/endpoints/quickpicks — curated common local servers.
  route('GET', /^\/api\/endpoints\/quickpicks$/, async () => {
    return { status: 200, body: { quickpicks: QUICKPICKS } };
  });

  // GET /api/endpoints/known — the permanent pinned hosts.
  route('GET', /^\/api\/endpoints\/known$/, async () => {
    return { status: 200, body: { known: readKnown() } };
  });

  // POST /api/endpoints/known { host, label?, ports? } — pin a permanent host.
  route('POST', /^\/api\/endpoints\/known$/, async (req: IncomingMessage) => {
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return { status: 400, body: { error: 'invalid body' } };
    let host: string;
    try {
      host = normalizeHost(body.host);
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : 'invalid host', errorKind: 'invalid-url' } };
    }
    const known = readKnown();
    if (known.some((k) => k.host === host)) return { status: 409, body: { error: `${host} is already pinned.` } };
    const item: KnownEndpoint = { host };
    if (typeof body.label === 'string' && body.label.trim()) item.label = body.label.trim().slice(0, 64);
    if (body.ports !== undefined) item.ports = resolvePorts(body.ports);
    known.push(item);
    writeKnown(known);
    return { status: 201, body: { known } };
  });

  // DELETE /api/endpoints/known/:host — unpin.
  route('DELETE', /^\/api\/endpoints\/known\/(.+)$/, async (_req: IncomingMessage, _res: ServerResponse, match: RegExpMatchArray) => {
    let host: string;
    try {
      host = normalizeHost(decodeURIComponent(match[1] ?? ''));
    } catch {
      return { status: 400, body: { error: 'invalid host' } };
    }
    const known = readKnown();
    const next = known.filter((k) => k.host !== host);
    if (next.length === known.length) return { status: 404, body: { error: `${host} is not pinned.` } };
    writeKnown(next);
    return { status: 200, body: { known: next } };
  });

  // POST /api/endpoints/resolve { host, ports?, timeoutMs? } — the "doctor": find what's running.
  route('POST', /^\/api\/endpoints\/resolve$/, async (req: IncomingMessage) => {
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return { status: 400, body: { error: 'invalid body' } };
    let host: string;
    try {
      host = normalizeHost(body.host);
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : 'invalid host', errorKind: 'invalid-url' } };
    }
    const pinned = readKnown().find((k) => k.host === host);
    const ports = resolvePorts(body.ports ?? pinned?.ports);
    const result = await resolveHost(host, { ports, timeoutMs: body.timeoutMs as number | undefined });
    return { status: 200, body: result };
  });
}
