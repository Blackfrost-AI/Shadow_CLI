/**
 * Enricher pool (plan §8) — bounded in-process async queue (concurrency 2, per-(asset,enricher)
 * cooldown 15 min). Results pass the §5 gate → fact nodes anchored to the asset; failures write
 * hint nodes (negative evidence), never throw into the worker loop. Local-first Phase 2:
 * file-hash + git-provenance. Network enrichers land in Phase 5 behind literal allow-network.
 *
 * Enrichers run IN-PROCESS here (hash/git are local reads); any future subprocess uses scrubEnv
 * (PATH/HOME/LANG/TMPDIR only) — no credential inheritance, ever.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { shadowFetch } from '../../safety/egress.js';
import { dirname, basename } from 'node:path';
import { resolveWithin } from '../../safety/workspaceJail.js';
import { isElf, ELF_MAGIC } from '../elf.js';
import { FAT_MAGIC_32, FAT_MAGIC_64, MH_MAGIC_32, MH_MAGIC_64 } from '../macho.js';
import { gatePayload, scrubEnv } from './redact.js';
import type { OpsGraph } from './graph.js';

export const ENRICH_CONCURRENCY = 2;
export const ENRICH_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_HASH_BYTES = 512 * 1024 * 1024; // refuse to hash absurd inputs; hint instead
const GIT_TIMEOUT_MS = 10_000;

export interface EnrichRequest {
  runId: string;
  assetNodeId: number;
  enricher: string;
}

export interface EnrichStatus {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cooldownSkips: number;
}

export type EnrichResult = { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string };

/** An enricher is a pure local computation over an asset path → gated fact payload or a reason. */
/** Per-call enricher context (§4/§8): the run's engagement id and the operator-approved
 *  network permission, resolved from DURABLE engagement scope at drain time. Workers can
 *  never self-authorize egress — `networkAllowed` defaults to false (fail closed). */
export interface EnricherCtx {
  engagementId: string;
  networkAllowed: boolean;
}

/** Pool construction options (Phase 5). `allowNetwork` resolves the operator's literal
 *  `allow-network` engagement scope token per drain call; absent means deny everything. */
export interface EnricherPoolOpts {
  enrichers?: Record<string, EnricherFn>;
  cooldownMs?: number;
  allowNetwork?: (engagementId: string) => boolean;
}

export type EnricherFn = (path: string, ctx: EnricherCtx) => EnrichResult | Promise<EnrichResult>;

function detectFormat(head: Buffer): string {
  if (isElf(head)) return 'elf';
  if (head.length >= 4) {
    const be = head.readUInt32BE(0);
    const le = head.readUInt32LE(0);
    if (be === FAT_MAGIC_32 || be === FAT_MAGIC_64) return 'macho-fat';
    if (le === MH_MAGIC_64 || le === MH_MAGIC_32 || be === MH_MAGIC_64 || be === MH_MAGIC_32) return 'macho';
    if (head[0] === 0x4d && head[1] === 0x5a) return 'pe-candidate';
  }
  if (head.subarray(0, 4).equals(ELF_MAGIC)) return 'elf';
  return 'unknown';
}

/** sha256 + size + coarse format magic. Reads the file once (≤512 MiB); never executes it. */
export const fileHashEnricher: EnricherFn = (path) => {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    if (st.size > MAX_HASH_BYTES) return { ok: false, reason: `file exceeds ${MAX_HASH_BYTES} byte hash cap` };
    const buf = readFileSync(path);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const fd = openSync(path, 'r');
    const head = Buffer.alloc(64);
    let n = 0;
    try {
      n = readSync(fd, head, 0, 64, 0);
    } finally {
      closeSync(fd);
    }
    return { ok: true, payload: { sha256, sizeBytes: st.size, format: detectFormat(head.subarray(0, n)), mtimeMs: Math.round(st.mtimeMs) } };
  } catch (e) {
    return { ok: false, reason: `file-hash failed: ${(e as Error).message}` };
  }
};

/** Last commit touching the asset, via git with a scrubbed env. No repo → honest negative hint. */
export const gitProvenanceEnricher: EnricherFn = (path) => {
  try {
    const dir = dirname(path);
    const file = basename(path);
    const out = execFileSync('git', ['log', '-1', '--format=%H%x00%aI%x00%s', '--', file], {
      cwd: dir,
      env: scrubEnv(),
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!out) return { ok: false, reason: 'no git history for this path' };
    const [commit, date, subject] = out.split('\0');
    return { ok: true, payload: { commit, committedAt: date, subject: (subject ?? '').slice(0, 200) } };
  } catch (e) {
    return { ok: false, reason: `git-provenance failed: ${(e as Error).message.split('\n')[0]}` };
  }
};


const OSV_URL = 'https://api.osv.dev/v1/query';
const OSV_TIMEOUT_MS = 15_000;
const OSV_MAX_BODY_BYTES = 1 << 20; // 1 MiB backstop — advisory payloads are small

/** npm package.json identity — the ONLY thing an osv-lookup ever sends (§8). No file
 *  contents, no paths: package identity leaves the machine, nothing else. */
function npmIdentityFor(path: string): { name: string; version?: string } | undefined {
  if (!path.endsWith('package.json')) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const name = typeof pkg['name'] === 'string' ? pkg['name'] : undefined;
    if (!name) return undefined;
    const version = typeof pkg['version'] === 'string' ? pkg['version'] : undefined;
    return version ? { name, version } : { name };
  } catch {
    return undefined; // malformed manifest — the miss is recorded as a hint below
  }
}

/**
 * osv-lookup (§8, Phase 5): package identity → OSV advisory ids, through the egress
 * broker with a DEDICATED purpose ('ops-enrich') so enricher receipts are separable from
 * operator tool lookups. Gated on the literal `allow-network` scope token resolved from
 * the durable engagement at drain time — never on worker self-assertion.
 *
 * tls-probe was CUT (plan directive satisfied): the broker transport is WHATWG fetch;
 * the peer certificate lives on the TLS socket (res.socket), unreachable from a Response.
 */
export function makeOsvEnricher(fetchImpl: typeof shadowFetch = shadowFetch): EnricherFn {
  return async (path: string, ctx: EnricherCtx): Promise<EnrichResult> => {
    if (!ctx.networkAllowed) {
      return { ok: false, reason: 'osv-lookup skipped: engagement has no allow-network scope token.' };
    }
    const identity = npmIdentityFor(path);
    if (!identity) {
      return { ok: false, reason: 'osv-lookup skipped: asset is not a package.json with a name.' };
    }
    try {
      const resp = await fetchImpl(
        OSV_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(
            identity.version
              ? { package: { ecosystem: 'npm', name: identity.name }, version: identity.version }
              : { package: { ecosystem: 'npm', name: identity.name } },
          ),
          signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
        },
        { purpose: 'ops-enrich', origin: 'user' },
      );
      if (!resp.ok) return { ok: false, reason: `osv-lookup: OSV responded HTTP ${resp.status}.` };
      const text = await resp.text();
      if (text.length > OSV_MAX_BODY_BYTES) return { ok: false, reason: 'osv-lookup: response exceeded the 1 MiB cap.' };
      let ids: string[] = [];
      try {
        const parsed = JSON.parse(text) as { vulns?: Array<{ id?: unknown }> };
        ids = (parsed.vulns ?? []).map((v) => (typeof v.id === 'string' ? v.id : '')).filter(Boolean).slice(0, 25);
      } catch {
        return { ok: false, reason: 'osv-lookup: non-JSON advisory response.' };
      }
      const at = identity.version ? `${identity.name}@${identity.version}` : identity.name;
      return ids.length === 0
        ? { ok: true, payload: { source: 'osv.dev', text: `No known OSV advisories for npm ${at}.` } }
        : { ok: true, payload: { source: 'osv.dev', text: `OSV advisories for npm ${at}: ${ids.join(', ')}.` } };
    } catch (e) {
      // Offline wall, egress denial, or timeout — negative evidence, never an exception.
      return { ok: false, reason: `osv-lookup unavailable (${(e as Error).message.slice(0, 160)}).` };
    }
  };
}

/** Network enrichers: explicit-run only (NEVER auto-enqueued on register_asset — §8 keeps
 *  network behind operator approval + the allow-network scope token, so silence is the
 *  default). The pool merges them into the runnable set; localEnricherNames() stays local. */
export const NETWORK_ENRICHERS: Record<string, EnricherFn> = {
  'osv-lookup': makeOsvEnricher(),
};

export const LOCAL_ENRICHERS: Record<string, EnricherFn> = {
  'file-hash': fileHashEnricher,
  'git-provenance': gitProvenanceEnricher,
};

interface QueueItem {
  req: EnrichRequest;
  key: string;
}

/**
 * Bounded pool bound to one graph. enqueue() never throws into the caller; duplicate
 * (asset,enricher) work inside the cooldown window is skipped and counted. drain() awaits
 * quiescence for tests/shutdown.
 */
export class EnricherPool {
  private queue: QueueItem[] = [];
  private running = 0;
  private completed = 0;
  private failed = 0;
  private cooldownSkips = 0;
  private lastRun = new Map<string, number>();
  private waiters: Array<() => void> = [];
  private enrichers: Record<string, EnricherFn>;
  private allowNetwork: (engagementId: string) => boolean = () => false;

  constructor(
    private graph: OpsGraph,
    private workspace: string,
    enrichers: Record<string, EnricherFn> = { ...LOCAL_ENRICHERS, ...NETWORK_ENRICHERS },
    private cooldownMs = ENRICH_COOLDOWN_MS,
    opts: EnricherPoolOpts = {},
  ) {
    if (opts.allowNetwork) this.allowNetwork = opts.allowNetwork;
    this.enrichers = enrichers;
  }
  /** Queue work; returns 'queued' | 'cooldown' | 'unknown-enricher' | 'invalid-asset'. Never throws. */
  enqueue(req: EnrichRequest): 'queued' | 'cooldown' | 'unknown-enricher' | 'invalid-asset' {
    try {
      if (!this.enrichers[req.enricher]) return 'unknown-enricher';
      const asset = this.graph.getNode(req.assetNodeId);
      if (asset.kind !== 'asset' || asset.runId !== req.runId || typeof asset.payload.path !== 'string') return 'invalid-asset';
      const key = `${req.assetNodeId}:${req.enricher}`;
      const last = this.lastRun.get(key);
      if (last !== undefined && Date.now() - last < this.cooldownMs) {
        this.cooldownSkips++;
        return 'cooldown';
      }
      if (this.queue.some((q) => q.key === key)) return 'queued';
      this.lastRun.set(key, Date.now());
      this.queue.push({ req, key });
      this.pump();
      return 'queued';
    } catch {
      return 'invalid-asset';
    }
  }

  status(): EnrichStatus {
    return { queued: this.queue.length, running: this.running, completed: this.completed, failed: this.failed, cooldownSkips: this.cooldownSkips };
  }

  /** Resolves when the queue is empty and nothing is running. */
  drain(): Promise<void> {
    if (this.queue.length === 0 && this.running === 0) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  private pump(): void {
    while (this.running < ENRICH_CONCURRENCY && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.running++;
      void this.run(item).finally(() => {
        this.running--;
        this.pump();
        if (this.queue.length === 0 && this.running === 0) {
          const w = this.waiters;
          this.waiters = [];
          for (const fn of w) fn();
        }
      });
    }
  }

  private async run(item: QueueItem): Promise<void> {
    const { req } = item;
    try {
      const asset = this.graph.getNode(req.assetNodeId);
      const path = resolveWithin(this.workspace, asset.payload.path as string);
      const runRec = this.graph.getRun(req.runId);
      const engagementId = runRec?.engagementId ?? '';
      const ectx: EnricherCtx = { engagementId, networkAllowed: engagementId ? this.allowNetwork(engagementId) : false };
      const result = await this.enrichers[req.enricher]!(path, ectx);
      if (result.ok) {
        const payload = { enricher: req.enricher, ...result.payload };
        gatePayload(payload);
        this.graph.addNode({ runId: req.runId, kind: 'fact', payload, origin: `enricher:${req.enricher}`, anchors: [req.assetNodeId] });
        this.completed++;
        this.graph.pushEnrichDone(req.runId, req.assetNodeId);
      } else {
        this.failed++;
        this.graph.addNode({ runId: req.runId, kind: 'hint', payload: { enricher: req.enricher, negative: result.reason }, origin: `enricher:${req.enricher}`, anchors: [req.assetNodeId] });
      }
    } catch (e) {
      // Failures are negative evidence, never exceptions into the worker loop.
      this.failed++;
      try {
        this.graph.addNode({ runId: req.runId, kind: 'hint', payload: { enricher: req.enricher, negative: `enricher error: ${(e as Error).message.slice(0, 200)}` }, origin: `enricher:${req.enricher}`, anchors: [req.assetNodeId] });
      } catch {
        /* graph unavailable — the failure is still counted in status() */
      }
    }
  }
}