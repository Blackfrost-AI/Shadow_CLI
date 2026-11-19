/**
 * Ops-Graph types — the durable knowledge graph behind chained security swarms.
 * Vocabulary is generic domain language (goal/intent/fact/asset/anchor/hint); every identifier
 * is original to Shadow. Schema and contracts: plans/ops-graph-security-swarm-2026-11-18.md §3.
 */
import type { FindingStatus } from '../evidence.js';

export type RunStatus = 'active' | 'paused' | 'complete' | 'aborted';
export type GoalState = 'open' | 'met' | 'abandoned';
export type IntentState = 'open' | 'claimed' | 'running' | 'done' | 'blocked' | 'exhausted' | 'stopped';
/** Data-node lifecycle (§3): append-only, supersede keeps history. */
export type DataState = 'active' | 'superseded';
export type Origin = 'lead' | 'operator' | 'policy' | `worker:${string}` | `enricher:${string}`;
export type NodeKind = 'goal' | 'intent' | 'fact' | 'asset' | 'finding' | 'hint';
export type Archetype = 'recon' | 'auditor' | 'verifier';
export type TriggerKind = 'intent_done' | 'finding_new' | 'goal_met' | 'asset_new' | 'enrich_done';

/** Row shape of `nodes` (§3 literal schema). Timestamps are ISO-8601 TEXT. */
export interface OpsNode {
  id: number;
  runId: string;
  kind: NodeKind;
  payload: Record<string, unknown>;
  state: string;
  priority: number;
  origin: Origin;
  /** Claim token while claimed; the real worker job id once running (intents only). */
  ownerJob: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface IntentNode extends OpsNode {
  kind: 'intent';
  state: IntentState;
}

export interface GoalNode extends OpsNode {
  kind: 'goal';
  state: GoalState;
}

export interface Run {
  id: string;
  engagementId: string;
  objective: string;
  status: RunStatus;
  createdAt: string;
}

export interface Trigger {
  seq: number;
  runId: string;
  kind: TriggerKind;
  nodeId: number;
  consumed: boolean;
}

export interface CoverageCounters {
  assetsTotal: number;
  /** Assets with ≥1 anchored fact node (§7 — facts only, not findings). */
  assetsWithFact: number;
  goalsOpen: number;
  goalsMet: number;
  goalsAbandoned: number;
  intentsByState: Record<IntentState, number>;
  pendingTriggers: number;
}

export interface GraphOverview {
  text: string;
  truncated: boolean;
  counters: CoverageCounters;
}

/** Injected read-only ledger seam (§3): live verification status, fail-closed on unknown ids. */
export interface OpsGraphDeps {
  findingStatus: (ledgerId: string) => FindingStatus;
}

/** Typed errors so tools map failures to honest deny reasons. */
export class OpsError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'bad_transition'
      | 'denied'
      | 'secret_payload'
      | 'payload_too_large'
      | 'anchor_invalid'
      | 'lock_held'
      | 'schema_future'
      | 'not_implemented',
  ) {
    super(message);
    this.name = 'OpsError';
  }
}

export class SecretInPayloadError extends OpsError {
  constructor(message: string) {
    super(message, 'secret_payload');
    this.name = 'SecretInPayloadError';
  }
}

export const OPS_SCHEMA_VERSION = 1;
export const OPS_DB_PATH = '.shadow/security/ops.sqlite';
export const MAX_PAYLOAD_BYTES = 8 * 1024;
export const MAX_OVERVIEW_BYTES = 16 * 1024;
export const MAX_OVERVIEW_NODES = 200;
export const MAX_FEED_BYTES = 4 * 1024;
export const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000;
/** Policy default (§4); hard cap = session subagentConcurrency, enforced at dispatch. */
export const DEFAULT_MAX_WORKERS = 3;

/**
 * Transitions usable via `markIntent` (§3 state machine). Terminal → open is deliberately
 * absent: terminal states are immutable except the explicit `reopenIntent` path, which is
 * lead/operator-only and records a reason. `open/claimed → stopped` is a recorded
 * interpretation (build log): stop_intent must be able to stop queued work.
 */
export const INTENT_TRANSITIONS: Record<IntentState, readonly IntentState[]> = {
  open: ['claimed', 'stopped'],
  claimed: ['running', 'open', 'stopped'],
  running: ['done', 'blocked', 'exhausted', 'stopped', 'open'],
  done: [],
  blocked: [],
  exhausted: [],
  stopped: [],
};

/** States `reopenIntent` may resurrect (lead/operator origin only). */
export const REOPENABLE_STATES: readonly IntentState[] = ['done', 'blocked', 'exhausted', 'stopped'];

export function canTransition(from: IntentState, to: IntentState): boolean {
  return INTENT_TRANSITIONS[from].includes(to);
}