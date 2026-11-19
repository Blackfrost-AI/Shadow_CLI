/**
 * ops_* tools (plan §7) — the graph's tool surface. Origin is ALWAYS harness-derived from
 * ToolContext (§1.4): ctx.nestedAgent ? 'worker:'+currentWorkId : 'lead'. No schema carries an
 * origin field; 'operator' exists only on the /ops slash-command path. Every payload passes the
 * §5 gate inside the store. These tools only record/observe — they never touch targets.
 *
 * Store lifetime: per-call open + close (securityFindings.ts pattern). The enricher pool is the
 * one session-lived piece (cooldown state + in-flight queue); it binds lazily to a graph handle
 * it closes itself on release.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import type { OpsGraph } from '../security/ops/graph.js';
import type { EvidenceStore, FindingInput } from '../security/evidence.js';
import type { EnricherPool } from '../security/ops/enrich.js';
import { LOCAL_ENRICHERS, NETWORK_ENRICHERS } from '../security/ops/enrich.js';
import { OPS_ARCHETYPES, canonicalOpsTools } from '../security/ops/archetypes.js';
import { policyFromScope, targetInScope } from '../security/ops/policy.js';
import { EngagementStore } from './engagementOps.js';
import { OpsError, type Archetype, type IntentNode, type IntentState, type Origin } from '../security/ops/types.js';

export interface OpsToolDeps {
  graph: (workspace: string) => OpsGraph;
  evidence: (workspace: string) => EvidenceStore;
  pool: (workspace: string) => EnricherPool;
  /** Close the per-call graph/evidence handles. The pool keeps its own handle until release. */
  release: (workspace: string) => void;
}

/** §1.4: harness-derived origin. Never tool input. */
export function originFromCtx(ctx: ToolContext): Origin | { error: string } {
  if (ctx.nestedAgent) {
    if (!ctx.currentWorkId) return { error: 'Nested ops worker has no work id; cannot attribute write-back.' };
    return `worker:${ctx.currentWorkId}`;
  }
  return 'lead';
}

function isWorker(origin: Origin): boolean {
  return origin.startsWith('worker:');
}

function errResult(tool: string, risk: 'read' | 'write', ms: number, e: unknown): ToolResult<never> {
  if (e instanceof OpsError) return fail(tool, risk, ms, e.code, e.message);
  return fail(tool, risk, ms, 'ops_error', (e as Error).message);
}

const payloadObj = z.record(z.unknown());
// Weak-model tolerance (§10 Phase 3a): stringified arrays are parsed back, mirroring the
// z.preprocess precedent elsewhere in the toolbelt. Garbage strings fall through to zod's error.
function safeParseArray(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
const idsArr = z.preprocess((v) => (typeof v === 'string' ? safeParseArray(v) : v), z.array(z.number().int().positive()));
const strArr = z.preprocess((v) => (typeof v === 'string' ? safeParseArray(v) : v), z.array(z.string().max(2000)).max(200));
const archetypeEnum = z.enum(['recon', 'auditor', 'verifier']);

/** Scope-derived policy for lead-side intent validation; null when the engagement can't be read. */
function policyForRun(workspace: string, run: { engagementId: string }): ReturnType<typeof policyFromScope> | null {
  let eng: EngagementStore | undefined;
  try {
    eng = new EngagementStore(workspace);
    const e = eng.get(run.engagementId);
    return policyFromScope(e.id, e.scope, canonicalOpsTools('recon').concat(canonicalOpsTools('auditor'), canonicalOpsTools('verifier')));
  } catch {
    return null;
  } finally {
    eng?.close();
  }
}

// ── ops_graph (lead-only observation/control) ─────────────────────────────────────────────
const opsGraphSchema = z.object({
  // §7: lead-side observation AND planning/attestation actions live here.
  action: z.enum(['overview', 'pending_triggers', 'consume_triggers', 'node_detail', 'list_nodes', 'coverage', 'runs', 'plan_intent', 'set_goal', 'attest_goal', 'stop_intent', 'reopen_intent']),
  run_id: z.string().optional(),
  node_id: z.number().int().positive().optional(),
  kind: z.enum(['goal', 'intent', 'fact', 'asset', 'finding', 'hint']).optional(),
  through_seq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(500).optional(),
  reason: z.string().max(2000).optional(),
  // plan_intent / set_goal / attest_goal fields (lead-only)
  archetype: archetypeEnum.optional(),
  prompt: z.string().max(8000).optional(),
  targets: strArr.optional(),
  from: idsArr.optional(),
  priority: z.number().int().optional(),
  text: z.string().max(4000).optional(),
  goal_id: z.number().int().positive().optional(),
  evidence_node_ids: idsArr.optional(),
  // verifier intents: named project-check profiles bound at dispatch time (§5.3).
  check_profiles: strArr.optional(),
});
type OpsGraphInput = z.infer<typeof opsGraphSchema>;

export function makeOpsGraphTool(deps: OpsToolDeps): Tool<OpsGraphInput> {
  return {
    name: 'ops_graph',
    description:
      'Observe and steer the ops knowledge graph (lead only): overview, pending_triggers, consume_triggers, node_detail, list_nodes, coverage, runs, plan_intent, set_goal, attest_goal (verified ledger evidence required), stop_intent, reopen_intent.',
    risk: 'write',
    inputSchema: opsGraphSchema,
    deferred: true,
    searchAliases: ['ops', 'graph', 'swarm', 'intent', 'coverage', 'knowledge graph', 'pentest chain', 'engagement graph', 'recon workflow'],
    async run(input, ctx) {
      const t0 = Date.now();
      const origin = originFromCtx(ctx);
      if (typeof origin !== 'string') return fail('ops_graph', 'write', 0, 'denied', origin.error);
      if (isWorker(origin)) return fail('ops_graph', 'write', Date.now() - t0, 'denied', 'ops_graph is lead-only. Workers use ops_writeback.');
      // Write-tool dry-run contract: no persistence layer is even opened (engagementOps.ts precedent).
      if (ctx.dryRun && !['overview', 'pending_triggers', 'node_detail', 'list_nodes', 'coverage', 'runs'].includes(input.action))
        return ok('ops_graph', 'write', 0, `Dry run: would ${input.action} on the ops graph.`);
      try {
        const g = deps.graph(ctx.workspaceRoot);
        const runId = input.run_id ?? g.activeRun()?.id;
        const needRun = (): string => {
          if (!runId) throw new OpsError('No active ops run; pass run_id.', 'not_found');
          return runId;
        };
        switch (input.action) {
          case 'overview': {
            const ov = g.overview(needRun());
            return ok('ops_graph', 'write', Date.now() - t0, `Ops overview (${ov.truncated ? 'truncated' : 'full'})`, ov);
          }
          case 'pending_triggers': {
            const triggers = g.pendingTriggers(needRun(), input.limit ?? 100);
            return ok('ops_graph', 'write', Date.now() - t0, `${triggers.length} pending trigger(s)`, { triggers });
          }
          case 'consume_triggers': {
            if (input.through_seq === undefined) return fail('ops_graph', 'write', Date.now() - t0, 'bad_input', 'consume_triggers requires through_seq.');
            g.consumeTriggers(needRun(), input.through_seq);
            return ok('ops_graph', 'write', Date.now() - t0, `Consumed triggers through seq ${input.through_seq}.`);
          }
          case 'node_detail': {
            if (input.node_id === undefined) return fail('ops_graph', 'write', Date.now() - t0, 'bad_input', 'node_detail requires node_id.');
            const node = g.getNode(input.node_id);
            return ok('ops_graph', 'write', Date.now() - t0, `Node #${node.id} [${node.kind}/${node.state}]`, { node, anchors: g.anchorIds(node.id) });
          }
          case 'plan_intent': {
            if (!input.archetype || !input.prompt?.trim()) return fail('ops_graph', 'write', Date.now() - t0, 'bad_input', 'plan_intent requires archetype and prompt.');
            const archetype = input.archetype as Archetype;
            if (!OPS_ARCHETYPES[archetype]) return fail('ops_graph', 'write', Date.now() - t0, 'denied', `Unknown archetype ${archetype}.`);
            const rid = needRun();
            const from = input.from ?? [];
            // Validate targets against engagement scope NOW so out-of-scope intents never queue.
            // Same deterministic matcher ops_dispatch re-runs before spawning (§4a); deny-only.
            if ((input.targets ?? []).length > 0) {
              const policy = policyForRun(ctx.workspaceRoot, g.getRun(rid));
              if (!policy) return fail('ops_graph', 'write', Date.now() - t0, 'denied', 'Cannot read the bound engagement scope; intent targets unvalidatable.');
              for (const t of input.targets ?? []) {
                if (!targetInScope(t, policy.scopeTargets)) return fail('ops_graph', 'write', Date.now() - t0, 'denied', `Target out of scope: ${t}`);
              }
            }
            const node = g.addNode({ runId: rid, kind: 'intent', payload: { archetype, prompt: input.prompt, targets: input.targets ?? [], from, ...(input.check_profiles?.length ? { checkProfiles: input.check_profiles } : {}) }, origin, anchors: from, priority: input.priority ?? 0 });
            return ok('ops_graph', 'write', Date.now() - t0, `Intent #${node.id} queued (${archetype}).`, { nodeId: node.id });
          }
          case 'set_goal': {
            if (!input.text?.trim()) return fail('ops_graph', 'write', Date.now() - t0, 'bad_input', 'set_goal requires text.');
            const node = g.addNode({ runId: needRun(), kind: 'goal', payload: { text: input.text }, origin });
            return ok('ops_graph', 'write', Date.now() - t0, `Goal #${node.id} set.`, { nodeId: node.id });
          }
          case 'attest_goal': {
            if (input.goal_id === undefined) return fail('ops_graph', 'write', Date.now() - t0, 'bad_input', 'attest_goal requires goal_id.');
            // Operator override is unreachable here (§1.4): no reason channel on any tool.
            g.attestGoal(input.goal_id, input.evidence_node_ids ?? [], origin);
            return ok('ops_graph', 'write', Date.now() - t0, `Goal #${input.goal_id} attested met.`, { nodeId: input.goal_id });
          }
          case 'list_nodes': {
            const nodes = g.listNodes(needRun(), { kind: input.kind });
            return ok('ops_graph', 'write', Date.now() - t0, `${nodes.length} node(s)`, { nodes });
          }
          case 'coverage':
            return ok('ops_graph', 'write', Date.now() - t0, 'Coverage counters', g.coverage(needRun()));
          case 'runs':
            return ok('ops_graph', 'write', Date.now() - t0, `${g.listRuns().length} run(s)`, { runs: g.listRuns() });
          case 'stop_intent': {
            if (input.node_id === undefined) return fail('ops_graph', 'write', Date.now() - t0, 'bad_input', 'stop_intent requires node_id.');
            g.markIntent(input.node_id, 'stopped', { stopped_by: origin });
            return ok('ops_graph', 'write', Date.now() - t0, `Intent #${input.node_id} stopped.`);
          }
          case 'reopen_intent': {
            if (input.node_id === undefined || !input.reason?.trim()) return fail('ops_graph', 'write', Date.now() - t0, 'bad_input', 'reopen_intent requires node_id and reason.');
            g.reopenIntent(input.node_id, input.reason, origin);
            return ok('ops_graph', 'write', Date.now() - t0, `Intent #${input.node_id} reopened.`);
          }
        }
      } catch (e) {
        return errResult('ops_graph', 'write', Date.now() - t0, e);
      } finally {
        deps.release(ctx.workspaceRoot);
      }
    },
  };
}

// ── ops_writeback (worker-side persistence; §7 action set) ────────────────────────────────
const opsWritebackSchema = z.object({
  action: z.enum(['note_fact', 'register_asset', 'file_finding', 'add_note', 'finish_intent']),
  run_id: z.string().optional(),
  payload: payloadObj.optional(),
  anchors: idsArr.optional(),
  intent_id: z.number().int().positive().optional(),
  outcome: z.enum(['done', 'blocked', 'exhausted', 'stopped']).optional(),
  summary: z.string().max(4000).optional(),
  blocked_reason: z.string().max(2000).optional(),
  text: z.string().max(4000).optional(),
  finding: z
    .object({
      title: z.string().min(1).max(500),
      description: z.string().max(16000).optional(),
      rule: z.string().max(500).optional(),
      source: z.string().max(500).optional(),
      path: z.string().max(2000).optional(),
      line: z.number().int().min(1).optional(),
      severity: z.enum(['error', 'warning', 'note', 'none']).optional(),
    })
    .optional(),
});
type OpsWritebackInput = z.infer<typeof opsWritebackSchema>;

export function makeOpsWritebackTool(deps: OpsToolDeps): Tool<OpsWritebackInput> {
  return {
    name: 'ops_writeback',
    description:
      'Worker write-back into the ops graph: note_fact, register_asset, file_finding (ledger + graph atomically), add_note (hint), finish_intent. Origin is harness-derived; payloads are secret-gated and capped at 8 KiB. A run that writes nothing back is a failed run.',
    risk: 'write',
    inputSchema: opsWritebackSchema,
    deferred: true,
    searchAliases: ['ops', 'writeback', 'fact', 'finding', 'asset', 'intent', 'graph write', 'record', 'note fact', 'finish intent'],
    async run(input, ctx) {
      const t0 = Date.now();
      const origin = originFromCtx(ctx);
      if (typeof origin !== 'string') return fail('ops_writeback', 'write', 0, 'denied', origin.error);
      if (ctx.dryRun) return ok('ops_writeback', 'write', 0, `Dry run: would ${input.action} into the ops graph.`);
      try {
        const g = deps.graph(ctx.workspaceRoot);
        const runId = input.run_id ?? g.activeRun()?.id;
        const needRun = (): string => {
          if (!runId) throw new OpsError('No active ops run; pass run_id.', 'not_found');
          return runId;
        };
        const anchors = input.anchors ?? [];
        switch (input.action) {
          case 'register_asset': {
            if (!input.payload) return fail('ops_writeback', 'write', Date.now() - t0, 'bad_input', 'register_asset requires payload.');
            const node = g.addNode({ runId: needRun(), kind: 'asset', payload: input.payload, origin, anchors });
            // Local enrichment queues automatically (§8); failures never fail the write-back.
            let queued: string[] = [];
            try {
              const pool = deps.pool(ctx.workspaceRoot);
              queued = Object.keys(LOCAL_ENRICHERS).filter((name) => pool.enqueue({ runId: node.runId, assetNodeId: node.id, enricher: name }) === 'queued');
            } catch {
              /* enrichment is best-effort */
            }
            return ok('ops_writeback', 'write', Date.now() - t0, `Asset #${node.id} registered; enrichment queued: ${queued.join(', ') || 'none'}.`, { nodeId: node.id, enrichmentQueued: queued });
          }
          case 'note_fact': {
            if (!input.payload) return fail('ops_writeback', 'write', Date.now() - t0, 'bad_input', 'note_fact requires payload.');
            const node = g.addNode({ runId: needRun(), kind: 'fact', payload: input.payload, origin, anchors });
            return ok('ops_writeback', 'write', Date.now() - t0, `Fact #${node.id} noted.`, { nodeId: node.id });
          }
          case 'file_finding': {
            if (!input.finding) return fail('ops_writeback', 'write', Date.now() - t0, 'bad_input', 'file_finding requires finding.');
            const rid = needRun();
            const ev = deps.evidence(ctx.workspaceRoot);
            const findingInput: FindingInput = {
              title: input.finding.title,
              description: input.finding.description ?? '',
              rule: input.finding.rule ?? 'manual',
              source: input.finding.source ?? (isWorker(origin) ? origin : 'operator'),
              path: input.finding.path ?? '',
              ...(input.finding.line !== undefined ? { line: input.finding.line } : {}),
              severity: input.finding.severity ?? 'warning',
            };
            const imported = ev.importFindings([findingInput]);
            const ledgerId = imported.ids[0]!;
            const node = g.addNode({ runId: rid, kind: 'finding', payload: { title: findingInput.title, ledgerId, severity: findingInput.severity, path: findingInput.path }, origin, anchors });
            return ok('ops_writeback', 'write', Date.now() - t0, `Finding recorded: ledger ${ledgerId}, graph #${node.id}. A claim until a live check verifies it.`, { nodeId: node.id, ledgerId, added: imported.added, duplicates: imported.duplicates });
          }
          case 'add_note': {
            if (!input.text?.trim() && !input.payload) return fail('ops_writeback', 'write', Date.now() - t0, 'bad_input', 'add_note requires text or payload.');
            const payload = input.payload ?? { text: input.text };
            const node = g.addNode({ runId: needRun(), kind: 'hint', payload, origin, anchors });
            return ok('ops_writeback', 'write', Date.now() - t0, `Hint #${node.id} recorded.`, { nodeId: node.id });
          }
          case 'finish_intent': {
            if (input.intent_id === undefined || !input.outcome || !input.summary?.trim()) return fail('ops_writeback', 'write', Date.now() - t0, 'bad_input', 'finish_intent requires intent_id, outcome, summary.');
            const intent = g.getNode(input.intent_id) as IntentNode;
            if (intent.kind !== 'intent') throw new OpsError(`Node ${input.intent_id} is not an intent.`, 'bad_transition');
            // Ownership: a worker may only finish the intent it owns.
            if (isWorker(origin)) {
              const jobId = origin.slice('worker:'.length);
              if (intent.ownerJob !== jobId) throw new OpsError(`Intent ${input.intent_id} is owned by ${intent.ownerJob ?? 'nobody'}, not ${jobId}.`, 'denied');
            }
            // §7 write-back gate: ≥1 node THIS job wrote (any kind, any anchor). Zero writes →
            // exhausted with reason "no write-back" — never done. Negative evidence still counts.
            const writes = g.listNodes(intent.runId, { includeSuperseded: true }).filter((n) => n.origin === origin && n.kind !== 'goal' && n.kind !== 'intent');
            if (writes.length === 0) {
              g.markIntent(intent.id, 'exhausted', { summary: input.summary, exhausted_reason: 'no write-back' });
              return ok('ops_writeback', 'write', Date.now() - t0, `Intent #${intent.id} → exhausted (no write-back). A run that writes nothing back is a failed run.`, { nodeId: intent.id, state: 'exhausted' });
            }
            const patch: Record<string, unknown> = { summary: input.summary };
            if (input.outcome === 'blocked') {
              if (!input.blocked_reason?.trim()) return fail('ops_writeback', 'write', Date.now() - t0, 'bad_input', 'blocked requires blocked_reason.');
              patch.blocked_reason = input.blocked_reason;
            }
            g.markIntent(intent.id, input.outcome as IntentState, patch);
            return ok('ops_writeback', 'write', Date.now() - t0, `Intent #${intent.id} → ${input.outcome}.`, { nodeId: intent.id, state: input.outcome });
          }
        }
      } catch (e) {
        return errResult('ops_writeback', 'write', Date.now() - t0, e);
      } finally {
        deps.release(ctx.workspaceRoot);
      }
    },
  };
}

// ── ops_enrich (worker + lead; local enrichers only in Phase 3a) ──────────────────────────
const opsEnrichSchema = z.object({
  action: z.enum(['enqueue', 'status']),
  run_id: z.string().optional(),
  asset_node_id: z.number().int().positive().optional(),
  enricher: z.string().max(100).optional(),
});
type OpsEnrichInput = z.infer<typeof opsEnrichSchema>;

export function makeOpsEnrichTool(deps: OpsToolDeps): Tool<OpsEnrichInput> {
  return {
    name: 'ops_enrich',
    description:
      'Queue bounded local enrichment for a registered asset (file-hash, git-provenance) or read pool status. Results land as gated fact nodes anchored to the asset; failures as hint negative evidence. Never throws into the worker loop.',
    risk: 'write',
    inputSchema: opsEnrichSchema,
    deferred: true,
    searchAliases: ['ops', 'enrich', 'hash', 'provenance', 'asset metadata', 'file hash', 'git provenance'],
    async run(input, ctx) {
      const t0 = Date.now();
      if (ctx.dryRun && input.action === 'enqueue') return ok('ops_enrich', 'write', 0, `Dry run: would enqueue ${input.enricher ?? 'enricher'} on asset #${input.asset_node_id ?? '?'}.`);
      try {
        const pool = deps.pool(ctx.workspaceRoot);
        if (input.action === 'status') return ok('ops_enrich', 'write', Date.now() - t0, 'Enricher pool status', pool.status());
        if (input.asset_node_id === undefined || !input.enricher) return fail('ops_enrich', 'write', Date.now() - t0, 'bad_input', 'enqueue requires asset_node_id and enricher.');
        const g = deps.graph(ctx.workspaceRoot);
        const runId = input.run_id ?? g.activeRun()?.id;
        if (!runId) return fail('ops_enrich', 'write', Date.now() - t0, 'not_found', 'No active ops run; pass run_id.');
        const outcome = pool.enqueue({ runId, assetNodeId: input.asset_node_id, enricher: input.enricher });
        if (outcome === 'unknown-enricher') return fail('ops_enrich', 'write', Date.now() - t0, 'bad_input', `Unknown enricher: ${input.enricher}. Available: ${Object.keys({ ...LOCAL_ENRICHERS, ...NETWORK_ENRICHERS }).join(', ')}.`);
        if (outcome === 'invalid-asset') return fail('ops_enrich', 'write', Date.now() - t0, 'bad_input', 'Asset node not found in this run or has no path payload.');
        return ok('ops_enrich', 'write', Date.now() - t0, outcome === 'queued' ? `Enrichment queued: ${input.enricher} on #${input.asset_node_id}.` : `Cooldown: ${input.enricher} on #${input.asset_node_id} ran recently.`, { outcome });
      } catch (e) {
        return errResult('ops_enrich', 'write', Date.now() - t0, e);
      } finally {
        deps.release(ctx.workspaceRoot);
      }
    },
  };
}