/**
 * The egress broker — Shadow's single network chokepoint (P2-01 / FABLE-04 Phase 1).
 *
 * Every outbound HTTP request Shadow makes is supposed to flow through `shadowFetch()`:
 *
 *   1. OFFLINE WALL  — in offline mode, non-local hosts are denied HERE (readable error)…
 *   2. SSRF POLICY   — model-authored URLs get the full netguard; user-configured endpoints
 *                      are only checked against cloud-metadata addresses (a local/LAN serve
 *                      is a deliberate operator choice and must stay reachable);
 *   3. DNS PIN       — the name is resolved ONCE and the socket is pinned to the validated
 *                      IP SET (not just ips[0], so provider failover across A records survives);
 *   4. QUARANTINE    — (P3-08) tool-initiated fetches are checked against the egress allowlist
 *                      (derived defaults + global-only `egress.allow`): observe flags misses,
 *                      enforce denies them;
 *   5. RECEIPT       — host + purpose + verdict are recorded to the in-memory aggregate and
 *                      appended to `~/.shadow/egress.log` (0600) — the runtime proof behind
 *                      `/connections` and `shadow egress`.
 *
 * …and the same offline wall runs AGAIN below `shadowFetch()`, per runtime: under Node an
 * `EgressAgent` is installed as the global undici dispatcher (Node's built-in fetch is undici),
 * and in the Bun-compiled release binary — whose native global fetch never consults undici's
 * dispatcher — `globalThis.fetch` itself is wrapped with the same wall. Either way a raw
 * `fetch()` that bypasses `shadowFetch()` is refused while `--offline` is active, and the
 * bypass is journaled. Scope of this backstop, stated plainly: it covers global-fetch traffic on
 * both runtimes. It does not stop a third-party lib that opens sockets by some other means
 * (node:http, Bun-native APIs) on EITHER runtime — nothing in-process can; the lint guard,
 * the host-snapshot test, and the OS sandbox (`sandboxNetwork: false`) are that layer.
 *
 * `shadowFetch()` deliberately calls the GLOBAL `fetch` binding (Node's fetch is undici under
 * the hood and honors the `dispatcher` init option) so test seams that stub `globalThis.fetch`
 * keep working unchanged, while production traffic still flows through the pinned/enforcing
 * dispatcher passed per-request.
 */
import { Agent, fetch as undiciFetch, setGlobalDispatcher, type Dispatcher } from 'undici';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isLocalHost, isCloudMetadataAddress } from './offline.js';
import { assertUrlAllowed } from './netguard.js';

/** Why a request is leaving the machine — shown in /connections + `shadow egress`. */
export type EgressPurpose =
  | 'provider' // model completion stream / non-stream rescue
  | 'provider-count' // anthropic count_tokens
  | 'mcp' // MCP Streamable-HTTP connector
  | 'oauth' // opt-in `shadow login codex`
  | 'vision' // describe_media endpoint
  | 'local-probe' // gguf/mlx/vllm serve health + metadata probes (loopback/LAN)
  | 'update-check' // opt-in daily version check
  | 'update-binary' // `shadow update` binary/manifest download
  | 'web' // web_fetch tool
  | 'search' // web_search tool
  | 'image' // remote image attachment fetch
  | 'plugin-index' // user-configured plugin registry lookup (P3-07; off unless pluginIndexUrl is set)
  | 'plugin-clone' // `shadow plugin add <git-url>` — git child process (broker-bypass), journaled here
  | 'dispatch'; // caught at the dispatcher layer without a broker purpose

export type EgressVerdict = 'allowed' | 'denied';

export interface EgressHostStat {
  host: string;
  allowed: number;
  denied: number;
  lastSeen: number; // epoch ms
  purposes: Set<string>;
  /** P3-08 Phase 2: tool fetches made OUTSIDE the egress allowlist (quarantine flags). */
  flagged: number;
}

// ── In-memory aggregate + append-only log ─────────────────────────────────────

const hosts = new Map<string, EgressHostStat>();
let offlineModeOn = false;
let logPathOverride: string | null = null;

/** The persistent receipt file (0600). Tests may redirect it. */
export function egressLogPath(): string {
  return logPathOverride ?? join(homedir(), '.shadow', 'egress.log');
}
export function setEgressLogPathForTests(path: string | null): void {
  logPathOverride = path;
  bytesWritten = -1; // size cache is per-path — re-stat on the next write
}

/**
 * Test seam: resolve once every pending receipt write has hit disk. Chases the chain: if a
 * wedged filesystem forced the writer to DETACH (see appendLogLine's deadline), the flush
 * resolves with the fresh chain instead of hanging behind the wedged head forever.
 */
export async function flushEgressLogForTests(): Promise<void> {
  for (let hops = 0; hops < 8; hops++) {
    const current = writeChain;
    await Promise.race([
      current,
      new Promise<void>((r) => {
        const t = setTimeout(r, WRITE_DEADLINE_MS + 500);
        t.unref?.();
      }),
    ]).catch(() => undefined);
    if (writeChain === current) return;
  }
}

export function setOfflineMode(on: boolean): void {
  offlineModeOn = on;
}
export function isOfflineMode(): boolean {
  return offlineModeOn;
}

function hostKey(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
}

/** Rotate the log once it grows past this — the receipt must not become a liability. */
const ROTATE_AT_BYTES = 256 * 1024;
let bytesWritten = -1; // unknown until first stat

/**
 * Record one egress decision. Updates the session aggregate and appends one JSON line to the
 * receipt file. BEST-EFFORT by design: a logging failure must never break the request itself.
 * `flag` (P3-08) marks a decision made OUTSIDE the egress allowlist — currently the single
 * value 'quarantine'; additive on the receipt line, so older readers ignore it.
 */
export function recordEgress(host: string, purpose: string, verdict: EgressVerdict, flag?: string): void {
  const key = hostKey(host);
  let s = hosts.get(key);
  if (!s) {
    s = { host: key, allowed: 0, denied: 0, lastSeen: 0, purposes: new Set(), flagged: 0 };
    hosts.set(key, s);
  }
  if (verdict === 'allowed') s.allowed++;
  else s.denied++;
  s.lastSeen = Date.now();
  s.purposes.add(purpose);
  if (flag) s.flagged++;
  const row: Record<string, string> = { ts: new Date().toISOString(), host: key, purpose, verdict };
  if (flag) row.flag = flag;
  void appendLogLine(JSON.stringify(row) + '\n');
}

/**
 * Serialized writer — keeps the file append-only with no interleaved lines. BOUNDED by design:
 * the receipt is observability and must never become a liability, so (1) a wedged head write is
 * detached from the chain after WRITE_DEADLINE_MS (new lines start a fresh chain instead of
 * queueing behind a stalled filesystem forever — the stall itself is unfixable from here, but
 * it must not wedge flush/exit or grow memory without bound), and (2) the pending queue is
 * capped — over the cap, lines are dropped, counted, and the request proceeds.
 */
const WRITE_DEADLINE_MS = 5_000;
const MAX_PENDING_WRITES = 256;
let pendingWrites = 0;
let droppedReceiptLines = 0;
/** Test/observability seam: how many receipt lines were dropped by a wedged writer. */
export function droppedReceiptLineCount(): number {
  return droppedReceiptLines;
}

let writeChain: Promise<void> = Promise.resolve();
function appendLogLine(line: string): Promise<void> {
  if (pendingWrites >= MAX_PENDING_WRITES) {
    droppedReceiptLines++;
    return writeChain;
  }
  pendingWrites++;
  let settled = false;
  const task = writeChain
    .then(async () => {
      try {
        const p = egressLogPath();
        if (bytesWritten < 0) bytesWritten = await stat(p).then((st) => st.size).catch(() => 0);
        if (bytesWritten > ROTATE_AT_BYTES) {
          await rename(p, p + '.1').catch(() => undefined);
          bytesWritten = 0;
        }
        await mkdir(dirname(p), { recursive: true });
        await appendFile(p, line, { mode: 0o600 });
        bytesWritten += Buffer.byteLength(line);
      } catch {
        /* the receipt is observability, never a failure path for the request */
      }
    })
    .finally(() => {
      settled = true;
      pendingWrites--;
    });
  writeChain = task.catch(() => undefined);
  const deadline = setTimeout(() => {
    // A stalled head write must not hold every later line (and every flush) hostage.
    if (!settled) writeChain = Promise.resolve();
  }, WRITE_DEADLINE_MS);
  deadline.unref?.();
  return task;
}

/** Session aggregate (what /connections shows), most-recent host first. */
export function egressSummary(): EgressHostStat[] {
  return [...hosts.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export interface EgressLogRow {
  ts: string;
  host: string;
  purpose: string;
  verdict: EgressVerdict;
  /** P3-08: 'quarantine' when the request was outside the egress allowlist. Absent on older lines. */
  flag?: string;
}

/**
 * Read + aggregate the persistent receipt (current file + the one rotation kept). This is what
 * `shadow egress` prints — it works from a FRESH process because the log is on disk.
 */
export async function readEgressLogAggregate(): Promise<EgressHostStat[]> {
  const { readFile } = await import('node:fs/promises');
  const p = egressLogPath();
  const agg = new Map<string, EgressHostStat>();
  for (const file of [p + '.1', p]) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row: EgressLogRow;
      try {
        row = JSON.parse(line) as EgressLogRow;
      } catch {
        continue; // a torn line at crash time must not sink the whole report
      }
      if (!row || typeof row.host !== 'string') continue;
      let s = agg.get(row.host);
      if (!s) {
        s = { host: row.host, allowed: 0, denied: 0, lastSeen: 0, purposes: new Set(), flagged: 0 };
        agg.set(row.host, s);
      }
      if (row.verdict === 'denied') s.denied++;
      else s.allowed++;
      const t = Date.parse(row.ts);
      if (Number.isFinite(t) && t > s.lastSeen) s.lastSeen = t;
      if (row.purpose) s.purposes.add(row.purpose);
      if (row.flag) s.flagged++;
    }
  }
  return [...agg.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Render the receipt as a plain-text report — what `shadow egress` prints from a FRESH
 * process. Deliberately dependency-free (no chalk): this must work before any UI is up.
 */
export function formatEgressReport(rows: EgressHostStat[], logPath: string): string {
  const lines: string[] = ['shadow egress — recorded outbound connections', ''];
  if (rows.length === 0) {
    lines.push('  (nothing recorded yet — no outbound request has passed the broker)');
  } else {
    const hostW = Math.min(46, Math.max(4, ...rows.map((r) => r.host.length)));
    lines.push(
      `  ${'host'.padEnd(hostW)}  ${'allowed'.padStart(7)}  ${'denied'.padStart(6)}  purposes (last seen)`,
    );
    for (const r of rows) {
      const host = r.host.length > hostW ? r.host.slice(0, hostW - 1) + '…' : r.host.padEnd(hostW);
      const seen = r.lastSeen > 0 ? new Date(r.lastSeen).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z') : 'never';
      const flagNote = r.flagged > 0 ? `  ⚑ ${r.flagged} outside allowlist` : '';
      lines.push(`  ${host}  ${String(r.allowed).padStart(7)}  ${String(r.denied).padStart(6)}  ${[...r.purposes].sort().join(', ')} (${seen})${flagNote}`);
    }
  }
  lines.push('', `Receipt: ${logPath}  (append-only, 0600, rotated at 256 KiB — one rotation kept as .1)`);
  lines.push('Every outbound HTTP request Shadow makes flows through the egress broker (shadowFetch);');
  lines.push('the same wall denies ALL non-local egress while --offline is active.');
  if (rows.some((r) => r.flagged > 0)) {
    lines.push('⚑ = a tool-initiated fetch (web_fetch/web_search/remote image) OUTSIDE the egress allowlist —');
    if (egressPolicy.mode === 'enforce') {
      // Don't advise switching to the mode that's already active — in enforce these rows were DENIED.
      lines.push('    mode=enforce: these fetches were DENIED — widen "egress": {"allow": [...]} in ~/.shadow/config.json');
      lines.push('    to admit them (quarantine, P3-08).');
    } else {
      lines.push('    widen it with "egress": {"allow": [...]} in ~/.shadow/config.json, or switch egress.mode');
      lines.push('    to "enforce" to deny such fetches instead of flagging them (quarantine, P3-08).');
    }
  }
  return lines.join('\n');
}

// ── DNS resolution: budgeted, cached, mockable ────────────────────────────────

type Resolver = (host: string) => Promise<string[]>;
let resolver: Resolver = defaultResolver;
/** Test seam: inject a mock resolver (the pin/failover tests use multi-A mocks). */
export function setEgressResolverForTests(r: Resolver | null): void {
  resolver = r ?? defaultResolver;
  resolveCache.clear();
}

const RESOLVE_TTL_MS = 30_000;
const RESOLVE_BUDGET_MS = 1_500;
const resolveCache = new Map<string, { ips: string[]; at: number }>();

async function defaultResolver(host: string): Promise<string[]> {
  const bare = hostKey(host);
  if (isIP(bare)) return [bare]; // IP literal — pin trivially, no DNS
  // 'localhost' is resolved by the OS on purpose: pinning it to 127.0.0.1 alone made
  // ::1-only local servers (uvicorn --host localhost, ::1-first getaddrinfo) unreachable.
  const cached = resolveCache.get(bare);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.ips;
  try {
    const ips = await withBudget(
      lookup(bare, { all: true }).then((rs) => rs.map((r) => r.address)),
      RESOLVE_BUDGET_MS,
    );
    resolveCache.set(bare, { ips, at: Date.now() });
    return ips;
  } catch {
    // NO negative cache: a resolution failure must not open a 30s window in which every
    // request skips validation (the metadata tier fails closed on an empty answer).
    return [];
  }
}

function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('dns budget exceeded')), ms);
    t.unref?.(); // a DNS wait must never hold the process open
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

// ── Cloud-metadata block (the only SSRF check applied to user-configured hosts) ─

/**
 * Cloud instance-metadata addresses. A user legitimately configures loopback/LAN serves
 * (that is the whole self-hosted story), so user-origin egress does NOT get the netguard's
 * private-range block — but NO legitimate config points at the metadata service, so that one
 * is denied for every origin. (169.254.169.254 = AWS/GCP/Azure/Oracle IMDS; fd00:ec2::254 =
 * AWS IMDSv6.) Matches EVERY spelling — v4-mapped/compat/NAT64/6to4/Teredo/expanded IPv6
 * encodings included (an exact-string compare was a verified bypass).
 */
export function isCloudMetadataIp(ip: string): boolean {
  return isCloudMetadataAddress(ip);
}

// ── Pinned, enforcing agents ──────────────────────────────────────────────────

function makePinnedLookup(ips: string[], validatedHost: string): (hostname: string, options: unknown, callback: unknown) => void {
  return (hostname, options, callback): void => {
    const hn = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
    const all = Boolean(options && (options as { all?: boolean }).all);
    if (hn !== validatedHost) {
      // A CROSS-HOST redirect: the pin set was validated for the ORIGINAL host only. Resolve
      // the new host for real (pre-broker behavior) — pinning it to the original host's IPs
      // dialed the wrong server (TLS SNI/cert mismatch). Netguard-tier callers are forced to
      // redirect:'manual' below, so this path only ever runs for operator-tier traffic.
      lookup(hn, { all: true }).then(
        (rs) => {
          if (rs.length === 0) {
            (callback as (e: Error) => void)(new Error(`getaddrinfo ENOTFOUND ${hn}`));
          } else if (all) {
            (callback as (e: null, a: { address: string; family: number }[]) => void)(
              null,
              rs.map((r) => ({ address: r.address, family: r.family })),
            );
          } else {
            (callback as (e: null, a: string, f: number) => void)(null, rs[0]!.address, rs[0]!.family);
          }
        },
        (e) => (callback as (err: Error) => void)(e as Error),
      );
      return;
    }
    // Same host: return the WHOLE validated set — pinning to ips[0] alone killed provider
    // failover across multi-A records. undici/net try the addresses in order.
    if (all) {
      (callback as (e: Error | null, a: { address: string; family: number }[]) => void)(
        null,
        ips.map((ip) => ({ address: ip, family: ip.includes(':') ? 6 : 4 })),
      );
    } else {
      const ip = ips[0]!;
      (callback as (e: Error | null, a: string, f: number) => void)(null, ip, ip.includes(':') ? 6 : 4);
    }
  };
}

export interface EgressAgentOptions {
  /** Pin every connection to this validated IP set. */
  pinTo?: string[];
  /** The host the pin set was validated for — a redirect to any OTHER host falls back to real DNS. */
  validatedHost?: string;
  /** The global-dispatcher instance: records allow-verdicts for traffic that bypassed shadowFetch. */
  primary?: boolean;
}

/**
 * The enforcing dispatcher. At dispatch time (socket layer) it re-checks the offline wall for
 * EVERY request — including ones that never went through `shadowFetch()` — so `--offline` is a
 * hard invariant, not a per-caller convention.
 */
export class EgressAgent extends Agent {
  constructor(private readonly egressOpts: EgressAgentOptions = {}) {
    super(
      egressOpts.pinTo && egressOpts.pinTo.length
        ? { connect: { lookup: makePinnedLookup(egressOpts.pinTo, egressOpts.validatedHost ?? '') as never } }
        : {},
    );
  }

  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const host = hostFromOrigin(opts.origin ? String(opts.origin) : undefined);
    if (offlineModeOn && host && !isLocalHost(host)) {
      recordEgress(host, 'dispatch', 'denied');
      const err = new Error(`offline mode: egress to ${host} is blocked at the dispatcher`);
      // Fail the request through whichever handler protocol is live. The error callback's name
      // and arity differ across undici generations (core protocol: `onError(err)`; undici 8 /
      // Node's built-in fetch adapter: `onResponseError(controller, err)`), and neither is in
      // the public DispatchHandler type surface — reach for both structurally.
      const h = handler as unknown as {
        onError?: (e: Error) => void;
        onResponseError?: (controller: unknown, e: Error) => void;
      };
      queueMicrotask(() => {
        if (typeof h.onError === 'function') h.onError(err);
        else h.onResponseError?.(undefined, err);
      });
      return true;
    }
    // Only the PRIMARY (global) agent records allows here: requests routed through shadowFetch
    // travel on a pinned/non-primary agent and were already recorded with their real purpose —
    // recording again would double-count every request in /connections.
    if (this.egressOpts.primary && host) {
      recordEgress(host, 'dispatch', 'allowed');
    }
    return super.dispatch(opts, handler);
  }
}

function hostFromOrigin(origin: string | undefined): string {
  if (!origin) return '';
  try {
    return new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/**
 * Test seam: close every agent so keep-alive pools don't hold a test process open.
 * Production agents live for the lifetime of the process by design.
 */
export async function closeAgentsForTests(): Promise<void> {
  await Promise.all([...agentCache.values()].map((a) => a.close()));
  agentCache.clear();
  await unpinnedAgent.close();
  await primaryAgent.close();
}

/**
 * Shared, cached agents per (pin-set, validated-host) — keeps keep-alive pools warm across
 * turns. LRU-capped: a long session's model-driven browsing can observe unboundedly many
 * distinct IP sets, and each cached agent retains its pool graph — so the least-recently-used
 * entry is evicted and (gracefully) closed past the cap.
 */
const AGENT_CACHE_MAX = 64;
const agentCache = new Map<string, EgressAgent>();
export function pinnedAgent(ips: string[], validatedHost: string): EgressAgent {
  const key = [...ips].sort().join(',') + '|' + validatedHost.toLowerCase();
  let agent = agentCache.get(key);
  if (agent) {
    agentCache.delete(key);
    agentCache.set(key, agent); // refresh recency
    return agent;
  }
  agent = new EgressAgent({ pinTo: ips, validatedHost });
  agentCache.set(key, agent);
  while (agentCache.size > AGENT_CACHE_MAX) {
    const oldest = agentCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const evicted = agentCache.get(oldest);
    agentCache.delete(oldest);
    void evicted?.close().catch(() => undefined); // graceful: pending requests finish first
  }
  return agent;
}
/** Test seam: how many pinned agents are cached right now. */
export function pinnedAgentCacheSizeForTests(): number {
  return agentCache.size;
}

/** The global backstop: catches any fetch that bypasses shadowFetch (third-party libs, future code). */
const primaryAgent = new EgressAgent({ primary: true });
setGlobalDispatcher(primaryAgent);

/** Non-pinning enforcing agent for requests whose host could not be resolved ahead of time. */
const unpinnedAgent = new EgressAgent({});

/**
 * Transport selection. On Node, `globalThis.fetch` IS undici and honors the `dispatcher` init
 * option — using the global binding also keeps every test seam that stubs `globalThis.fetch`
 * working. In the Bun-compiled release binary the global fetch is Bun's own (it ignores
 * `dispatcher`), so there we use the undici package's fetch directly — pure JS, runs on Bun,
 * and honors the dispatcher (this is how web_fetch survived the binary historically).
 */
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const transport: (input: string, init?: RequestInit) => Promise<Response> = isBunRuntime
  ? (u, i) => undiciFetch(u, i as never) as unknown as Promise<Response>
  : (u, i) => fetch(u, i);

/**
 * The offline wall as a fetch wrapper — the Bun-binary edition of the dispatcher backstop.
 * In the compiled release binary the global fetch is Bun's own and never consults undici's
 * global dispatcher, so the wall is installed around `globalThis.fetch` itself there. Under
 * Node the dispatcher already provides this; wrapping would only interfere with test seams
 * that stub `globalThis.fetch`, so it stays Bun-only.
 */
export function offlineFetchWall<F extends (url: never, init?: never) => Promise<Response>>(origFetch: F): F {
  return ((url: unknown, init?: unknown) => {
    if (offlineModeOn) {
      let host = '';
      try {
        host = hostKey(new URL(String(url)).hostname);
      } catch {
        /* unparseable → let the real fetch produce its own error */
      }
      if (host && !isLocalHost(host)) {
        recordEgress(host, 'dispatch', 'denied');
        return Promise.reject(new Error(`offline mode: egress to ${host} is blocked at the fetch wall`));
      }
    }
    return origFetch(url as never, init as never);
  }) as unknown as F;
}

if (isBunRuntime) {
  globalThis.fetch = offlineFetchWall(globalThis.fetch);
}

// ── P3-08 Phase 2 · egress quarantine for tool-initiated fetches ──────────────
//
// The allowlist semantics of the filesystem jail applied to the network dimension (the
// workspaceJail × netguard composition). Tool-initiated fetches — the ones whose URL the MODEL
// authored (web_fetch, web_search, remote-image attachment fetches) — are checked against an
// effective allowlist: derived defaults plus the operator's `egress.allow` (global-only config;
// a cloned repo cannot widen its own quarantine). Everything else (provider, MCP, oauth,
// updates, local probes) is operator-chosen traffic and is NOT quarantined.
//
//   observe (default) — off-allowlist fetches proceed but are FLAGGED on the receipt;
//   enforce           — off-allowlist fetches are DENIED with a readable error.

export interface EgressPolicy {
  mode: 'observe' | 'enforce';
  allow: string[];
}

let egressPolicy: EgressPolicy = { mode: 'observe', allow: [] };

/** App wiring: install the resolved (global) egress policy once at startup. */
export function setEgressPolicy(p: EgressPolicy): void {
  egressPolicy = { mode: p.mode === 'enforce' ? 'enforce' : 'observe', allow: [...(p.allow ?? [])] };
}

/** Test seam: reset to the shipping default (observe, empty allow). */
export function resetEgressPolicyForTests(): void {
  egressPolicy = { mode: 'observe', allow: [] };
}

/**
 * Hosts the tool tier may always reach without configuration. web_search speaks to DuckDuckGo's
 * HTML endpoint; its result links bounce through duckduckgo.com/l/. (Provider hosts are NOT
 * here: provider traffic is operator-tier, never quarantined.)
 */
export const EGRESS_DERIVED_ALLOW: readonly string[] = ['duckduckgo.com', '*.duckduckgo.com'];

/**
 * The purposes whose URL was authored by the MODEL — the quarantine applies to exactly these.
 * (Provider/MCP/oauth/update/local-probe traffic is operator-chosen and stays ungated here;
 * the SSRF tiers above still apply to all of it.)
 */
// 'image' deliberately errs toward flagging: it covers BOTH markdown-image fetches from model
// output AND the operator's `/image <url>` attach flow. Over-flagging an operator-typed URL in
// enforce mode is a documented convenience trade — allowlisting it is one line.
const TOOL_PURPOSES: ReadonlySet<string> = new Set(['web', 'search', 'image']);

/** Host-entry match: exact ("example.com") or wildcard ("*.example.com" = any subdomain, NOT the apex). */
export function hostMatchesEntry(host: string, entry: string): boolean {
  // Normalize BOTH sides. URL.hostname keeps the trailing dot of "example.com." (a legal form the
  // model can author, same apex), and entries may arrive as "host:443" (a dead shape — the receipt
  // host key is port-free). Strip both so operator intent is never silently lost to encoding noise.
  const norm = (s: string) => s.replace(/\.$/, '');
  const h = norm(hostKey(host));
  let e = entry.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const port = e.match(/^([^:]+):(\d+)$/); // [^:]+ keeps bare IPv6 ('::1') intact
  if (port) e = port[1]!;
  e = norm(e);
  if (!e) return false;
  // A bare wildcard admits NOTHING — a "*." typo must not degrade into a near-universal grant.
  if (e === '*' || e === '*.') return false;
  if (e.startsWith('*.')) return h.endsWith(e.slice(1)); // "*.x.com" matches "a.x.com" and "a.b.x.com", not "x.com"
  return h === e;
}

/**
 * The quarantine decision for one tool-initiated fetch. Pure — no I/O, so the matching rules are
 * unit-testable without sockets. 'ok' = on the effective allowlist; 'flag' = observe-mode miss
 * (proceed, marked); 'deny' = enforce-mode miss (refuse). Non-tool purposes are always 'ok'.
 */
export function quarantineVerdict(host: string, purpose: string): 'ok' | 'flag' | 'deny' {
  if (!TOOL_PURPOSES.has(purpose)) return 'ok';
  for (const entry of [...EGRESS_DERIVED_ALLOW, ...egressPolicy.allow]) {
    if (hostMatchesEntry(host, entry)) return 'ok';
  }
  return egressPolicy.mode === 'enforce' ? 'deny' : 'flag';
}

// ── The chokepoint ────────────────────────────────────────────────────────────

export interface ShadowFetchOptions {
  purpose: EgressPurpose;
  /**
   * Who decided this host. `model` = a URL the model produced (web tools) → full netguard
   * SSRF. `user` (default) = operator-configured endpoint → cloud-metadata block only.
   */
  origin?: 'user' | 'model';
  /** Override the origin-derived SSRF tier. */
  ssrf?: 'netguard' | 'metadata' | 'none';
  /** Caller already validated + resolved this URL (web tools' per-hop re-validation). */
  pinnedIps?: string[];
}

/**
 * The one approved way out of the machine. Drop-in for `fetch(url, init)` — returns the same
 * Response — plus offline enforcement, SSRF policy, DNS pinning, and the egress receipt.
 */
export async function shadowFetch(url: string, init?: RequestInit, opts?: ShadowFetchOptions): Promise<Response> {
  const purpose: EgressPurpose = opts?.purpose ?? 'dispatch';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`egress: invalid URL: ${url}`);
  }
  const host = hostKey(parsed.hostname);

  // 1. Offline wall — readable error now; the dispatcher / fetch-wall re-checks below
  //    shadowFetch for code that bypasses it.
  let offlineLocalIps: string[] | undefined;
  if (offlineModeOn) {
    // Metadata addresses are never local, in any spelling — check IP literals up front.
    if (isCloudMetadataIp(host)) {
      recordEgress(host, purpose, 'denied');
      throw new Error(`offline mode: egress to ${host} is blocked (cloud-metadata address)`);
    }
    if (!isLocalHost(host)) {
      recordEgress(host, purpose, 'denied');
      throw new Error(`offline mode: egress to ${host} is blocked`);
    }
    if (!isIP(host) && host !== 'localhost') {
      // A hostname being "local" BY NAME (*.local, mDNS) is not proof its address is local —
      // an attacker answering mDNS could otherwise carry offline traffic to a public IP.
      // Verify after resolution; fail closed. (IP literals need no resolution.)
      const resolved = await resolver(host);
      if (resolved.length === 0 || !resolved.every((ip) => isLocalHost(ip) && !isCloudMetadataIp(ip))) {
        recordEgress(host, purpose, 'denied');
        throw new Error(
          `offline mode: egress to ${host} is blocked (does not resolve to a verifiably-local address)`,
        );
      }
      offlineLocalIps = resolved;
    }
  }

  // 2+3. SSRF policy + pin set.
  let ips: string[] | undefined = opts?.pinnedIps ?? offlineLocalIps;
  let ssrf: 'netguard' | 'metadata' | 'none' | undefined;
  if (!ips) {
    ssrf = opts?.ssrf ?? (opts?.origin === 'model' ? 'netguard' : 'metadata');
    if (ssrf === 'netguard') {
      try {
        ips = (await assertUrlAllowed(url)).ips;
      } catch (e) {
        recordEgress(host, purpose, 'denied');
        throw e;
      }
    } else if (ssrf === 'metadata') {
      const resolved = await resolver(host);
      if (resolved.length === 0) {
        // FAIL CLOSED (netguard parity): proceeding unpinned on an unvalidated name left the
        // socket-layer lookup — unbudgeted and unchecked — as the sole resolver, and the
        // negative cache stretched that hole to 30s.
        recordEgress(host, purpose, 'denied');
        throw new Error(`egress blocked: ${host} could not be resolved (the metadata check fails closed)`);
      }
      const bad = resolved.find(isCloudMetadataIp);
      if (bad) {
        recordEgress(host, purpose, 'denied');
        throw new Error(`egress blocked: ${host} resolves to a cloud-metadata address (${bad})`);
      }
      ips = resolved;
    }
  }

  // Netguard tier: every hop must RE-ENTER the broker (per-hop re-validation + quarantine), so
  // auto-follow is forced off even when a caller asks for 'follow' — the invariant belongs to
  // the chokepoint, not to each caller's convention. (pinnedIps = the caller already validated.)
  const effectiveInit: RequestInit =
    ssrf === 'netguard' && !opts?.pinnedIps && init?.redirect !== 'manual' ? { ...init, redirect: 'manual' } : (init ?? {});

  // 4. QUARANTINE (P3-08 Phase 2) — the egress allowlist over TOOL-INITIATED fetches (the URLs
  //    the model authored), checked AFTER the SSRF tiers above. A redirect chain is covered
  //    hop-by-hop because the web tools re-enter shadowFetch per hop. observe → proceed flagged;
  //    enforce → deny with a readable error. Operator-tier purposes pass ungated.
  const q = quarantineVerdict(host, purpose);
  if (q === 'deny') {
    recordEgress(host, purpose, 'denied', 'quarantine');
    throw new Error(
      `egress quarantine: ${host} is not on the egress allowlist (egress.mode='enforce') — ` +
        `add "${host}" to "egress": {"allow": [...]} in ~/.shadow/config.json to permit it`,
    );
  }

  recordEgress(host, purpose, 'allowed', q === 'flag' ? 'quarantine' : undefined);
  const dispatcher: Agent = ips && ips.length > 0 ? pinnedAgent(ips, host) : unpinnedAgent;
  // `dispatcher` is undici's init option; the DOM-flavored RequestInit type doesn't know it.
  return transport(url, { ...effectiveInit, dispatcher } as unknown as RequestInit);
}
