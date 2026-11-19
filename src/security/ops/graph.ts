/**
 * OpsGraph — durable knowledge graph for chained security swarms (plan §3, literal schema).
 * DB `.shadow/security/ops.sqlite`, separate from the findings ledger so graph writes never
 * contend with evidence writes. EvidenceStore conventions: node:sqlite, WAL + synchronous=FULL,
 * busy_timeout=5000, forward-only user_version guard, 0700 dir / 0600 files (incl. -wal/-shm),
 * every mutation in one BEGIN IMMEDIATE transaction (reentrant for nested store calls).
 *
 * Watermark = the durable `consumed` flag on `triggers` — one mechanism, no second cursor
 * store; restart never double-feeds. `run_locks` is advisory (one dispatcher per run across
 * sessions); a stuck row fails CLOSED (denies dispatch, never grants).
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolveWithin } from '../../safety/workspaceJail.js';
import {
  OPS_SCHEMA_VERSION,
  OPS_DB_PATH,
  DEFAULT_CLAIM_TTL_MS,
  MAX_OVERVIEW_BYTES,
  MAX_OVERVIEW_NODES,
  OpsError,
  canTransition,
  REOPENABLE_STATES,
  type CoverageCounters,
  type GraphOverview,
  type IntentNode,
  type IntentState,
  type NodeKind,
  type OpsGraphDeps,
  type OpsNode,
  type Origin,
  type Run,
  type RunStatus,
  type Trigger,
  type TriggerKind,
} from './types.js';
import { gatePayload } from './redact.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL,
  owner_job TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS anchors (
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  anchor_id INTEGER NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (node_id, anchor_id)
);
CREATE TABLE IF NOT EXISTS triggers (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_locks (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_run_kind_state ON nodes(run_id, kind, state);
CREATE INDEX IF NOT EXISTS idx_triggers_run_consumed ON triggers(run_id, consumed, seq);
PRAGMA user_version=${OPS_SCHEMA_VERSION};
`;

const DATA_KINDS: readonly NodeKind[] = ['fact', 'asset', 'finding', 'hint'];
const TERMINAL_INTENT: readonly IntentState[] = ['done', 'blocked', 'exhausted', 'stopped'];

function now(): string {
  return new Date().toISOString();
}

function isLeadOrOperator(origin: string): boolean {
  return origin === 'lead' || origin === 'operator';
}

export interface AddNodeInput {
  runId: string;
  kind: NodeKind;
  payload: Record<string, unknown>;
  priority?: number;
  origin: Origin;
  anchors?: number[];
}

export class OpsGraph {
  private db: DatabaseSync;
  private txDepth = 0;

  constructor(
    readonly workspace: string,
    private deps: OpsGraphDeps,
  ) {
    const dir = resolveWithin(workspace, '.shadow/security');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = resolveWithin(workspace, OPS_DB_PATH);
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > OPS_SCHEMA_VERSION) {
      this.db.close();
      throw new OpsError('Ops-graph database is newer than this Shadow version.', 'schema_future');
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ${SCHEMA}`);
    for (const suffix of ['-wal', '-shm']) {
      try {
        chmodSync(path + suffix, 0o600);
      } catch {
        /* created lazily by SQLite */
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* never mask the original error */
      }
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  // ── runs ────────────────────────────────────────────────────────────────────────────────
  startRun(spec: { engagementId: string; objective: string }): Run {
    const run: Run = {
      id: `run_${randomBytes(8).toString('hex')}`,
      engagementId: spec.engagementId,
      objective: spec.objective,
      status: 'active',
      createdAt: now(),
    };
    return this.tx(() => {
      this.db.prepare('INSERT INTO runs(id,engagement_id,objective,status,created_at) VALUES (?,?,?,?,?)').run(run.id, run.engagementId, run.objective, run.status, run.createdAt);
      return run;
    });
  }

  getRun(id: string): Run {
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!r) throw new OpsError(`Unknown run: ${id}`, 'not_found');
    return this.rowRun(r);
  }

  listRuns(): Run[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at').all() as Record<string, unknown>[]).map((r) => this.rowRun(r));
  }

  activeRun(): Run | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE status='active' ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    return r ? this.rowRun(r) : undefined;
  }

  /** complete requires every goal met|abandoned; origin must be lead/operator (§3). */
  setRunStatus(id: string, status: RunStatus, origin: string): void {
    if (!isLeadOrOperator(origin)) throw new OpsError(`Run status changes require lead/operator origin (got ${origin}).`, 'denied');
    this.tx(() => {
      const run = this.getRun(id);
      if (run.status === 'complete' || run.status === 'aborted') throw new OpsError(`Run ${id} is already ${run.status}.`, 'bad_transition');
      if (status === 'complete') {
        const unresolved = this.listNodes(id, { kind: 'goal' }).filter((g) => g.state === 'open');
        if (unresolved.length > 0) throw new OpsError(`Cannot complete run: ${unresolved.length} goal(s) still open.`, 'denied');
      }
      this.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, id);
    });
  }

  private rowRun(r: Record<string, unknown>): Run {
    return { id: r.id as string, engagementId: r.engagement_id as string, objective: r.objective as string, status: r.status as RunStatus, createdAt: r.created_at as string };
  }

  // ── nodes ───────────────────────────────────────────────────────────────────────────────
  /** Unified insert. Anchors must exist AND belong to the same run; payload passes the §5 gate + 8 KiB cap. */
  addNode(input: AddNodeInput): OpsNode {
    gatePayload(input.payload);
    return this.tx(() => {
      const run = this.getRun(input.runId);
      if (input.kind === 'intent' && run.status !== 'active') throw new OpsError(`Run ${run.id} is ${run.status}; cannot add intents.`, 'bad_transition');
      if (input.kind === 'goal' && typeof input.payload.text !== 'string') throw new OpsError('Goal payload requires text.', 'denied');
      if (input.kind === 'intent' && typeof input.payload.prompt !== 'string') throw new OpsError('Intent payload requires prompt.', 'denied');
      const anchors = input.anchors ?? [];
      for (const a of anchors) {
        const row = this.db.prepare('SELECT run_id FROM nodes WHERE id=?').get(a) as { run_id: string } | undefined;
        if (!row) throw new OpsError(`Anchor node not found: ${a}`, 'anchor_invalid');
        if (row.run_id !== input.runId) throw new OpsError(`Anchor ${a} belongs to a different run.`, 'anchor_invalid');
      }
      const state = input.kind === 'goal' || input.kind === 'intent' ? 'open' : 'active';
      const t = now();
      const res = this.db
        .prepare('INSERT INTO nodes(run_id,kind,payload,state,priority,origin,owner_job,claimed_at,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,NULL,NULL,?,?,NULL)')
        .run(input.runId, input.kind, JSON.stringify(input.payload), state, input.priority ?? 0, input.origin, t, t);
      const id = Number(res.lastInsertRowid);
      for (const a of anchors) this.db.prepare('INSERT OR IGNORE INTO anchors(node_id,anchor_id) VALUES (?,?)').run(id, a);
      // §3 trigger kinds — ONLY these. Facts and hints deliberately emit nothing.
      if (input.kind === 'finding') this.pushTrigger(input.runId, 'finding_new', id);
      if (input.kind === 'asset') this.pushTrigger(input.runId, 'asset_new', id);
      return this.getNode(id);
    });
  }

  getNode(id: number): OpsNode {
    const r = this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!r) throw new OpsError(`Unknown node: ${id}`, 'not_found');
    return this.rowNode(r);
  }

  listNodes(runId: string, opts?: { kind?: NodeKind; state?: string; includeSuperseded?: boolean }): OpsNode[] {
    let sql = 'SELECT * FROM nodes WHERE run_id=?';
    const params: (string | number)[] = [runId];
    if (opts?.kind) {
      sql += ' AND kind=?';
      params.push(opts.kind);
    }
    if (opts?.state) {
      sql += ' AND state=?';
      params.push(opts.state);
    } else if (!opts?.includeSuperseded) {
      sql += " AND state != 'superseded'";
    }
    sql += ' ORDER BY id';
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => this.rowNode(r));
  }

  anchorIds(nodeId: number): number[] {
    return (this.db.prepare('SELECT anchor_id FROM anchors WHERE node_id=? ORDER BY anchor_id').all(nodeId) as { anchor_id: number }[]).map((r) => r.anchor_id);
  }

  private rowNode(r: Record<string, unknown>): OpsNode {
    return {
      id: r.id as number,
      runId: r.run_id as string,
      kind: r.kind as NodeKind,
      payload: JSON.parse(r.payload as string) as Record<string, unknown>,
      state: r.state as string,
      priority: r.priority as number,
      origin: r.origin as Origin,
      ownerJob: (r.owner_job as string | null) ?? null,
      claimedAt: (r.claimed_at as string | null) ?? null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      completedAt: (r.completed_at as string | null) ?? null,
    };
  }

  /** Supersede a data node with an existing replacement (same run, same kind). History kept. */
  supersede(id: number, byNodeId: number): void {
    this.tx(() => {
      const old = this.getNode(id);
      const replacement = this.getNode(byNodeId);
      if (!DATA_KINDS.includes(old.kind)) throw new OpsError(`Only data nodes (fact/asset/finding/hint) can be superseded; ${old.kind} cannot.`, 'bad_transition');
      if (old.runId !== replacement.runId) throw new OpsError('Superseding node belongs to a different run.', 'denied');
      if (old.kind !== replacement.kind) throw new OpsError(`Superseding node kind ${replacement.kind} does not match ${old.kind}.`, 'denied');
      if (old.state === 'superseded') throw new OpsError(`Node ${id} is already superseded.`, 'bad_transition');
      if (replacement.state !== 'active') throw new OpsError(`Replacement node ${byNodeId} is not active.`, 'bad_transition');
      if (id === byNodeId) throw new OpsError('A node cannot supersede itself.', 'denied');
      const payload = { ...old.payload, supersededBy: byNodeId };
      this.db.prepare("UPDATE nodes SET state='superseded', payload=?, updated_at=? WHERE id=?").run(JSON.stringify(payload), now(), id);
    });
  }

  // ── goals ───────────────────────────────────────────────────────────────────────────────
  /**
   * Attest a goal met (§3): anchors the goal to the given finding nodes and requires ≥1 whose
   * LIVE ledger status is 'verified' (read via deps.findingStatus inside the txn). Operator
   * override requires origin:'operator' AND a recorded reason (/ops prove path only).
   * Unknown ledger ids / reader errors fail closed.
   */
  attestGoal(id: number, evidenceNodeIds: number[], origin: string, reason?: string): void {
    if (!isLeadOrOperator(origin)) throw new OpsError(`Goal attestation requires lead/operator origin (got ${origin}).`, 'denied');
    this.tx(() => {
      const goal = this.getNode(id);
      if (goal.kind !== 'goal') throw new OpsError(`Node ${id} is not a goal.`, 'bad_transition');
      if (goal.state !== 'open') throw new OpsError(`Goal ${id} is already ${goal.state}.`, 'bad_transition');
      const evidence: number[] = [];
      let verifiedCount = 0;
      for (const nid of evidenceNodeIds) {
        const node = this.getNode(nid);
        if (node.kind !== 'finding' || node.runId !== goal.runId) throw new OpsError(`Evidence node ${nid} is not a finding in this run.`, 'denied');
        evidence.push(nid);
        if (this.ledgerVerified(node)) verifiedCount++;
      }
      const patch: Record<string, unknown> = { attestedBy: origin, evidenceNodeIds: evidence };
      if (origin === 'operator' && reason) {
        patch.reason = reason;
      } else {
        if (reason) throw new OpsError('Override reason is operator-only (/ops prove).', 'denied');
        if (verifiedCount === 0) throw new OpsError('Attestation requires ≥1 anchored finding with verified ledger status, or an operator override.', 'denied');
      }
      for (const nid of evidence) this.db.prepare('INSERT OR IGNORE INTO anchors(node_id,anchor_id) VALUES (?,?)').run(id, nid);
      this.patchNode(id, 'met', patch);
      this.pushTrigger(goal.runId, 'goal_met', id);
    });
  }

  abandonGoal(id: number, reason: string, origin: string): void {
    if (!isLeadOrOperator(origin)) throw new OpsError(`Goal abandonment requires lead/operator origin (got ${origin}).`, 'denied');
    this.tx(() => {
      const goal = this.getNode(id);
      if (goal.kind !== 'goal' || goal.state !== 'open') throw new OpsError(`Goal ${id} cannot be abandoned from ${goal.state}.`, 'bad_transition');
      this.patchNode(id, 'abandoned', { reason });
    });
  }

  /** Live ledger check; any reader error or unknown id is NOT verified (fail closed). */
  private ledgerVerified(findingNode: OpsNode): boolean {
    const ledgerId = findingNode.payload.ledgerId;
    if (typeof ledgerId !== 'string' || !ledgerId) return false;
    try {
      return this.deps.findingStatus(ledgerId) === 'verified';
    } catch {
      return false;
    }
  }

  private patchNode(id: number, state: string, patch: Record<string, unknown>, completed = false): void {
    const node = this.getNode(id);
    const payload = { ...node.payload, ...patch };
    gatePayload(payload);
    const t = now();
    this.db.prepare('UPDATE nodes SET state=?, payload=?, updated_at=?, completed_at=? WHERE id=?').run(state, JSON.stringify(payload), t, completed ? t : node.completedAt, id);
  }

  // ── intents ─────────────────────────────────────────────────────────────────────────────
  /**
   * Atomically claim the next open intent (priority DESC, then id FIFO — recorded
   * interpretation, plan leaves ordering open). Caller supplies the dispatch-generated token;
   * it is stored as owner_job until attachJob swaps in the real job id. One txn, CAS-guarded.
   */
  claimNextIntent(runId: string, claimToken: string): OpsNode | null {
    return this.tx(() => {
      const cand = this.db
        .prepare("SELECT id FROM nodes WHERE run_id=? AND kind='intent' AND state='open' ORDER BY priority DESC, id ASC LIMIT 1")
        .get(runId) as { id: number } | undefined;
      if (!cand) return null;
      const t = now();
      const res = this.db.prepare("UPDATE nodes SET state='claimed', owner_job=?, claimed_at=?, updated_at=? WHERE id=? AND state='open'").run(claimToken, t, t, cand.id);
      if (res.changes === 0) return null;
      return this.getNode(cand.id);
    });
  }

  /** claimed → running; owner_job becomes the real worker job id. */
  attachJob(intentId: number, jobId: string): void {
    this.tx(() => {
      const intent = this.requireIntent(intentId);
      if (intent.state !== 'claimed') throw new OpsError(`Intent ${intentId} is ${intent.state}, not claimed.`, 'bad_transition');
      const t = now();
      this.db.prepare("UPDATE nodes SET state='running', owner_job=?, updated_at=? WHERE id=?").run(jobId, t, intentId);
    });
  }

  /** Immediate release on spawn failure / policy deny: claimed → open (never running). */
  releaseClaim(intentId: number): void {
    this.tx(() => {
      const intent = this.requireIntent(intentId);
      if (intent.state !== 'claimed') throw new OpsError(`Intent ${intentId} is ${intent.state}; only claimed intents can be released.`, 'bad_transition');
      this.clearClaim(intentId, 'open');
    });
  }

  /** Validated transition + payload patch. Terminal → open is NOT here — use reopenIntent. */
  markIntent(id: number, state: IntentState, patch?: Record<string, unknown>): void {
    this.tx(() => {
      const intent = this.requireIntent(id);
      if (!canTransition(intent.state, state)) throw new OpsError(`Illegal intent transition ${intent.state} → ${state}.`, 'bad_transition');
      if (state === 'blocked' && !patch?.blocked_reason) throw new OpsError('blocked requires blocked_reason in the patch.', 'denied');
      const merged = patch ?? {};
      if (state === 'open') {
        this.clearClaim(id, 'open', merged);
        return;
      }
      const terminal = TERMINAL_INTENT.includes(state);
      const cleaned = terminal ? { ...merged, claimToken: undefined } : merged;
      this.patchNode(id, state, cleaned, terminal);
      if (terminal) this.db.prepare('UPDATE nodes SET owner_job=NULL, claimed_at=NULL WHERE id=?').run(id);
      if (state === 'done') this.pushTrigger(intent.runId, 'intent_done', id);
    });
  }

  /** Explicit reopen of a terminal intent — lead/operator only, reason recorded (§3). */
  reopenIntent(id: number, reason: string, origin: string): void {
    if (!isLeadOrOperator(origin)) throw new OpsError(`Reopen requires lead/operator origin (got ${origin}).`, 'denied');
    this.tx(() => {
      const intent = this.requireIntent(id);
      if (!REOPENABLE_STATES.includes(intent.state)) throw new OpsError(`Intent ${id} is ${intent.state}; not reopenable.`, 'bad_transition');
      this.clearClaim(id, 'open', { reopenReason: reason });
      this.db.prepare('UPDATE nodes SET completed_at=NULL WHERE id=?').run(id);
    });
  }

  private clearClaim(id: number, state: IntentState, patch: Record<string, unknown> = {}): void {
    const node = this.getNode(id);
    const payload = { ...node.payload, ...patch };
    gatePayload(payload);
    this.db.prepare('UPDATE nodes SET state=?, payload=?, owner_job=NULL, claimed_at=NULL, updated_at=? WHERE id=?').run(state, JSON.stringify(payload), now(), id);
  }

  private requireIntent(id: number): IntentNode {
    const node = this.getNode(id);
    if (node.kind !== 'intent') throw new OpsError(`Node ${id} is not an intent.`, 'bad_transition');
    return node as IntentNode;
  }

  /**
   * Crash recovery (§3): claimed intents expire purely on claimed_at age (no job yet);
   * running intents recover ONLY when the injected liveness probe says the owner job is dead
   * — never on age. A throwing probe is treated as alive (fail toward no double-dispatch).
   */
  recoverOrphans(runId: string, isJobAlive: (jobId: string) => boolean, claimTtlMs = DEFAULT_CLAIM_TTL_MS): number {
    return this.tx(() => {
      const intents = this.listNodes(runId, { kind: 'intent' }) as IntentNode[];
      const cutoff = Date.now() - claimTtlMs;
      let n = 0;
      for (const intent of intents) {
        if (intent.state === 'claimed') {
          const claimedAt = intent.claimedAt ? Date.parse(intent.claimedAt) : 0;
          if (claimedAt <= cutoff) {
            this.clearClaim(intent.id, 'open', { recovered: 'claim_expired' });
            n++;
          }
        } else if (intent.state === 'running' && intent.ownerJob) {
          let alive = true;
          try {
            alive = isJobAlive(intent.ownerJob);
          } catch {
            alive = true;
          }
          if (!alive) {
            this.clearClaim(intent.id, 'open', { recovered: 'owner_dead' });
            n++;
          }
        }
      }
      return n;
    });
  }

  // ── triggers (durable consumed-flag watermark) ──────────────────────────────────────────
  private pushTrigger(runId: string, kind: TriggerKind, nodeId: number): void {
    this.db.prepare('INSERT INTO triggers(run_id,kind,node_id,consumed) VALUES (?,?,?,0)').run(runId, kind, nodeId);
  }

  pendingTriggers(runId: string, limit = 100): Trigger[] {
    return (this.db.prepare('SELECT * FROM triggers WHERE run_id=? AND consumed=0 ORDER BY seq LIMIT ?').all(runId, limit) as Record<string, unknown>[]).map((r) => this.rowTrigger(r));
  }

  /** Mark consumed up to seq in one txn, scoped to this run. Restart never double-feeds. */
  consumeTriggers(runId: string, throughSeq: number): void {
    this.tx(() => {
      this.db.prepare('UPDATE triggers SET consumed=1 WHERE run_id=? AND seq<=? AND consumed=0').run(runId, throughSeq);
    });
  }

  private rowTrigger(r: Record<string, unknown>): Trigger {
    return { seq: r.seq as number, runId: r.run_id as string, kind: r.kind as TriggerKind, nodeId: r.node_id as number, consumed: Boolean(r.consumed) };
  }

  /** Enricher completion feed (§3 enrich_done) — called by the pool after a fact lands. */
  pushEnrichDone(runId: string, assetNodeId: number): void {
    this.tx(() => {
      this.pushTrigger(runId, 'enrich_done', assetNodeId);
    });
  }

  // ── advisory run lock (one dispatcher per run across sessions) ──────────────────────────
  acquireLock(runId: string, sessionId: string): boolean {
    return this.tx(() => {
      const existing = this.db.prepare('SELECT session_id FROM run_locks WHERE run_id=?').get(runId) as { session_id: string } | undefined;
      if (existing && existing.session_id !== sessionId) return false;
      this.db
        .prepare('INSERT INTO run_locks(run_id,session_id,acquired_at) VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET acquired_at=excluded.acquired_at')
        .run(runId, sessionId, now());
      return true;
    });
  }

  releaseLock(runId: string, sessionId: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM run_locks WHERE run_id=? AND session_id=?').run(runId, sessionId);
    });
  }

  getLock(runId: string): { sessionId: string; acquiredAt: string } | undefined {
    const r = this.db.prepare('SELECT * FROM run_locks WHERE run_id=?').get(runId) as { session_id: string; acquired_at: string } | undefined;
    return r ? { sessionId: r.session_id, acquiredAt: r.acquired_at } : undefined;
  }

  // ── coverage + overview ─────────────────────────────────────────────────────────────────
  coverage(runId: string): CoverageCounters {
    const nodes = this.listNodes(runId, { includeSuperseded: true });
    const assets = nodes.filter((n) => n.kind === 'asset' && n.state === 'active');
    const factAnchors = new Set<number>();
    for (const n of nodes) if (n.kind === 'fact' && n.state === 'active') for (const a of this.anchorIds(n.id)) factAnchors.add(a);
    const goals = nodes.filter((n) => n.kind === 'goal');
    const intents = nodes.filter((n) => n.kind === 'intent');
    const intentsByState = { open: 0, claimed: 0, running: 0, done: 0, blocked: 0, exhausted: 0, stopped: 0 } as Record<IntentState, number>;
    for (const i of intents) intentsByState[i.state as IntentState]++;
    return {
      assetsTotal: assets.length,
      assetsWithFact: assets.filter((a) => factAnchors.has(a.id)).length,
      goalsOpen: goals.filter((g) => g.state === 'open').length,
      goalsMet: goals.filter((g) => g.state === 'met').length,
      goalsAbandoned: goals.filter((g) => g.state === 'abandoned').length,
      intentsByState,
      pendingTriggers: this.pendingTriggers(runId, 1_000_000).length,
    };
  }

  /**
   * Bounded text render (§7): goals + open intents + recent findings/assets + coverage +
   * stale-evidence warnings (anchored finding no longer 'verified' in the live ledger).
   * Cap 200 nodes / 16 KiB; superseded-oldest folded first.
   */
  overview(runId: string, opts?: { maxNodes?: number }): GraphOverview {
    const run = this.getRun(runId);
    const counters = this.coverage(runId);
    const maxNodes = Math.min(opts?.maxNodes ?? MAX_OVERVIEW_NODES, MAX_OVERVIEW_NODES);
    const all = this.listNodes(runId, { includeSuperseded: true });
    const lines: string[] = [];
    lines.push(`# Ops run ${run.id} (${run.status}) — engagement ${run.engagementId}`);
    lines.push(`objective: ${run.objective}`);
    const lock = this.getLock(runId);
    if (lock) lines.push(`dispatcher lock: session ${lock.sessionId} since ${lock.acquiredAt}`);
    lines.push(
      `coverage: ${counters.assetsWithFact}/${counters.assetsTotal} assets explored · goals ${counters.goalsMet} met / ${counters.goalsOpen} open · intents ${counters.intentsByState.done} done / ${counters.intentsByState.open} open · ${counters.pendingTriggers} pending triggers`,
    );
    const stale = (node: OpsNode): string => {
      if (node.kind !== 'finding') return '';
      return this.ledgerVerified(node) ? '' : ' ⚠ evidence no longer verified';
    };
    const nodeLine = (n: OpsNode): string =>
      `- #${n.id} [${n.kind}/${n.state}] ${summarize(n.payload)}${this.anchorIds(n.id).length ? ` (anchors: ${this.anchorIds(n.id).join(',')})` : ''}${stale(n)}`;

    const goals = all.filter((n) => n.kind === 'goal');
    if (goals.length) {
      lines.push('## Goals');
      for (const g of goals) {
        lines.push(nodeLine(g));
        // Stale-evidence on met goals: an anchored finding later unverifed does not revoke met.
        if (g.state === 'met') {
          for (const aid of this.anchorIds(g.id)) {
            const anchored = all.find((n) => n.id === aid);
            if (anchored?.kind === 'finding' && !this.ledgerVerified(anchored)) lines.push(`  ⚠ goal #${g.id}: anchored finding #${aid} no longer verified`);
          }
        }
      }
    }
    const intents = all.filter((n) => n.kind === 'intent');
    const liveIntents = intents.filter((n) => !TERMINAL_INTENT.includes(n.state as IntentState));
    if (liveIntents.length) {
      lines.push('## Intents (live)');
      for (const i of liveIntents) lines.push(nodeLine(i));
    }
    // Render order: active data nodes newest-first, then superseded oldest-first (folded first).
    const dataActive = all.filter((n) => DATA_KINDS.includes(n.kind) && n.state === 'active').reverse();
    const dataSuperseded = all.filter((n) => DATA_KINDS.includes(n.kind) && n.state === 'superseded');
    const ordered = [...dataActive, ...dataSuperseded];
    const fixedCount = goals.length + liveIntents.length;
    let shown = fixedCount;
    let truncated = false;
    const dataLines: string[] = [];
    for (const n of ordered) {
      if (shown >= maxNodes) {
        truncated = true;
        break;
      }
      const line = nodeLine(n);
      if (Buffer.byteLength([...lines, '## Nodes', ...dataLines, line].join('\n'), 'utf8') > MAX_OVERVIEW_BYTES) {
        truncated = true;
        break;
      }
      dataLines.push(line);
      shown++;
    }
    if (dataLines.length) {
      lines.push('## Nodes');
      lines.push(...dataLines);
    }
    if (truncated) lines.push(`… truncated (${ordered.length - dataLines.length} more nodes folded, superseded-oldest first; query specific ids)`);
    return { text: lines.join('\n'), truncated, counters };
  }
}

function summarize(payload: Record<string, unknown>): string {
  const title = (payload.title ?? payload.name ?? payload.summary ?? payload.text ?? payload.prompt ?? payload.path) as string | undefined;
  if (typeof title === 'string') return title.length > 120 ? title.slice(0, 117) + '…' : title;
  return `{${Object.keys(payload).slice(0, 4).join(', ')}}`;
}