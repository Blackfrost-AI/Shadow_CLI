/**
 * ops_dispatch — the lead's orchestration tool (plan §7.2).
 *
 *   start_run | claim_and_spawn | status | stop_intent | pause_run | resume_run |
 *   recover | complete_run | abort_run
 *
 * Lifecycle + dispatch are lead-only and fail closed: an active run bound to a
 * readable, active engagement with objective/scope/success-criteria; the advisory
 * run lock keeps one dispatcher per run across sessions; policy-checked targets
 * and CANONICAL archetype tools (shadow defs can never widen the plan); worker
 * cap; durable negative evidence on every denial. Workers never dispatch.
 *
 * Every spawn goes through the host's real (permission-gated) agent tool with
 * run_in_background:true + isolation:'none' — a worktree checkout would give the
 * worker a DIFFERENT checks store and break live-check verification — forwarding
 * ctx unchanged so gate/autonomy/budget inheritance holds. Job liveness,
 * heartbeats and cancellation stay the single source of truth (JobStore).
 *
 * This tool never executes anything itself: it claims, checks, spawns, records.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import type { OpsToolDeps } from './opsTools.js';
import type { OpsGraph } from '../security/ops/graph.js';
import { EngagementStore } from './engagementOps.js';
import type { Engagement } from '../security/engagement.js';
import { JobStore } from '../state/jobStore.js';
import { DEFAULT_MAX_WORKERS, OpsError, type Archetype, type IntentNode, type Origin, type Run } from '../security/ops/types.js';
import { OPS_ARCHETYPES, canonicalOpsTools, matchesCanonical } from '../security/ops/archetypes.js';
import { resolveAgentDef } from '../agent/defs.js';
import { policyFromScope, checkDispatch, checkRunBinding } from '../security/ops/policy.js';

const opsDispatchSchema = z.object({
  action: z.enum(['start_run', 'claim_and_spawn', 'status', 'stop_intent', 'pause_run', 'resume_run', 'recover', 'complete_run', 'abort_run']),
  run_id: z.string().max(200).optional(),
  intent_id: z.number().int().positive().optional(),
  engagement_id: z.string().max(200).optional(),
  objective: z.string().max(2000).optional(),
  success_criteria: z.string().max(2000).optional(),
  reason: z.string().max(2000).optional(),
  max_workers: z.number().int().positive().max(16).optional(),
});
type OpsDispatchInput = z.infer<typeof opsDispatchSchema>;

/** The host's real agent tool, late-bound at registration (index.ts after gatedAgent). */
export type OpsAgentLauncher = () => Tool | undefined;

const RISK = 'exec' as const;

export function readEngagement(workspace: string, engagementId: string): Engagement | undefined {
  const store = new EngagementStore(workspace);
  try {
    return store.get(engagementId);
  } catch {
    return undefined; // unreadable engagement = unauthorized (fail closed)
  } finally {
    store.close();
  }
}

/** Authorization precondition: readable, active, fully specified engagement. */
export function engagementProblem(eng: Engagement | undefined, engagementId: string): string | undefined {
  if (!eng) return `engagement ${engagementId} not found`;
  if (eng.status !== 'active') return `engagement ${engagementId} is ${eng.status}, not active`;
  if (!eng.objective?.trim() || !eng.scope?.trim() || !eng.successCriteria?.trim()) return `engagement ${engagementId} lacks objective/scope/successCriteria`;
  return undefined;
}

/** Durable negative evidence for a denied dispatch — the claim is released immediately so a
 *  corrected plan can re-queue. Reuses the caller's open graph handle (released once in run()). */
function denyHint(g: OpsGraph, intent: IntentNode, reason: string, t0: number): ToolResult<unknown> {
  let hintId: number | undefined;
  try {
    const hint = g.addNode({ runId: intent.runId, kind: 'hint', payload: { text: `dispatch denied intent #${intent.id}: ${reason}` }, origin: 'policy', anchors: [intent.id] });
    hintId = hint.id;
  } catch { /* hint write is best-effort; the denial still stands */ }
  try { g.releaseClaim(intent.id); } catch { /* already released */ }
  const result = fail('ops_dispatch', RISK, Date.now() - t0, 'denied', reason);
  return { ...result, data: { intentId: intent.id, hintId } };
}

function workerPrompt(intent: IntentNode, run: Run): string {
  return [
    `You are an ops-graph worker (archetype: ${String(intent.payload.archetype)}) on run ${run.id}, intent #${intent.id}.`,
    `Objective: ${run.objective}`,
    `Task: ${String(intent.payload.prompt)}`,
    Array.isArray(intent.payload.targets) && intent.payload.targets.length ? `In-scope targets: ${(intent.payload.targets as string[]).join(', ')}` : 'No explicit targets; stay inside the engagement scope.',
    'Persist every material observation with ops_writeback (note_fact / register_asset / file_finding / add_note) as you go — a run that writes nothing back is a failed run.',
    `When finished, call ops_writeback finish_intent with intent_id ${intent.id} and outcome done|blocked|exhausted|stopped plus a summary. Findings are claims until a live project check verifies them; never claim verification without check evidence.`,
    'You are policy-gated: only your archetype tools plus ops_writeback are allowed, only against in-scope targets. Do not spawn sub-agents.',
  ].join('\n');
}

export function makeOpsDispatchTool(deps: OpsToolDeps, launcher?: OpsAgentLauncher): Tool<OpsDispatchInput> {
  return {
    name: 'ops_dispatch',
    description:
      'Lead-only ops-graph orchestration: start_run (binds an authorized engagement, creates the root goal, takes the run lock), claim_and_spawn (policy-checked background worker from the highest-priority open intent), pause_run/resume_run, recover (crash reconciliation via job liveness), stop_intent, complete_run/abort_run, status. Default-deny gate; denials leave durable hint evidence. Workers never dispatch.',
    risk: RISK,
    inputSchema: opsDispatchSchema,
    deferred: true,
    searchAliases: ['ops', 'dispatch', 'orchestrate', 'spawn worker', 'start run', 'pause run', 'recover', 'swarm', 'claim', 'stop intent', 'pentest chain', 'recon workflow'],
    async run(input, ctx) {
      const t0 = Date.now();
      const origin: Origin = ctx.nestedAgent ? `worker:${ctx.currentWorkId ?? 'unknown'}` : 'lead';
      if (origin !== 'lead' && input.action !== 'status') {
        return fail('ops_dispatch', RISK, 0, 'denied', 'ops_dispatch is lead-only; workers finish their own intent via ops_writeback.');
      }
      if (ctx.dryRun && input.action !== 'status') return ok('ops_dispatch', RISK, 0, `Dry run: would ${input.action} on the ops graph.`);
      const sessionId = ctx.sessionId ?? 'local-session';
      try {
        const g = deps.graph(ctx.workspaceRoot);
        try {
          // Resolves the named run, else the active one, else the newest paused one
          // (resume_run must be able to find a run that activeRun() no longer returns).
          const needRun = (): Run => {
            if (input.run_id) return g.getRun(input.run_id);
            const active = g.activeRun();
            if (active) return active;
            const paused = g.listRuns().filter((r) => r.status === 'paused');
            if (paused.length) return paused[paused.length - 1]!;
            throw new OpsError('No ops run found; start_run first (or pass run_id).', 'not_found');
          };
          switch (input.action) {
            // ── Lifecycle (lead-only) ────────────────────────────────────────────────
            case 'start_run': {
              if (!input.engagement_id) return fail('ops_dispatch', RISK, Date.now() - t0, 'bad_input', 'start_run requires engagement_id (an active engagement with objective/scope/successCriteria).');
              if (!input.objective?.trim()) return fail('ops_dispatch', RISK, Date.now() - t0, 'bad_input', 'start_run requires objective.');
              const problem = engagementProblem(readEngagement(ctx.workspaceRoot, input.engagement_id), input.engagement_id);
              if (problem) return fail('ops_dispatch', RISK, Date.now() - t0, 'denied', `${problem} — authorization is a precondition, not a detail.`);
              if (g.activeRun()) return fail('ops_dispatch', RISK, Date.now() - t0, 'denied', 'An ops run is already active; complete_run/abort_run it first.');
              const run = g.startRun({ engagementId: input.engagement_id, objective: input.objective.trim() });
              if (!g.acquireLock(run.id, sessionId)) {
                g.setRunStatus(run.id, 'aborted', origin);
                return fail('ops_dispatch', RISK, Date.now() - t0, 'denied', `Run lock for ${run.id} is held by another session.`);
              }
              const goal = g.addNode({ runId: run.id, kind: 'goal', payload: { text: input.success_criteria?.trim() || input.objective.trim() }, origin });
              return ok('ops_dispatch', RISK, Date.now() - t0, `Ops run ${run.id} started against engagement ${run.engagementId}; root goal #${goal.id}.`, { runId: run.id, goalId: goal.id });
            }
            case 'pause_run': {
              const r = needRun();
              g.setRunStatus(r.id, 'paused', origin);
              return ok('ops_dispatch', RISK, Date.now() - t0, `Run ${r.id} paused — the worker gate denies further tool calls until resume_run.`, { runId: r.id });
            }
            case 'resume_run': {
              const r = needRun();
              const problem = engagementProblem(readEngagement(ctx.workspaceRoot, r.engagementId), r.engagementId);
              if (problem) return fail('ops_dispatch', RISK, Date.now() - t0, 'denied', problem);
              g.setRunStatus(r.id, 'active', origin);
              g.acquireLock(r.id, sessionId);
              return ok('ops_dispatch', RISK, Date.now() - t0, `Run ${r.id} resumed.`, { runId: r.id });
            }
            case 'recover': {
              const r = needRun();
              const jobs = new JobStore(ctx.workspaceRoot);
              let n: number;
              try {
                // Liveness is the JobStore, never age: a running intent recovers only when its
                // owner job is provably gone/terminal. A missing record means the owner is dead.
                n = g.recoverOrphans(r.id, (jobId) => {
                  const job = jobs.get(jobId);
                  return !!job && (job.status === 'running' || job.status === 'pending');
                });
              } finally { jobs.close(); }
              return ok('ops_dispatch', RISK, Date.now() - t0, `Recovery: ${n} orphaned claim(s) requeued on run ${r.id}.`, { requeued: n });
            }
            case 'complete_run':
            case 'abort_run': {
              const r = needRun();
              const status = input.action === 'complete_run' ? 'complete' : 'aborted';
              // setRunStatus enforces the goal gate for complete (all goals met|abandoned).
              g.setRunStatus(r.id, status, origin);
              if (input.action === 'abort_run' && input.reason?.trim()) {
                g.addNode({ runId: r.id, kind: 'fact', payload: { text: `Run aborted: ${input.reason.trim()}` }, origin });
              }
              g.releaseLock(r.id, sessionId);
              return ok('ops_dispatch', RISK, Date.now() - t0, `Run ${r.id} ${status}.`, { runId: r.id, status });
            }
            case 'stop_intent': {
              if (input.intent_id === undefined) return fail('ops_dispatch', RISK, Date.now() - t0, 'bad_input', 'stop_intent requires intent_id.');
              const node = g.getNode(input.intent_id);
              if (node.kind !== 'intent') throw new OpsError(`#${input.intent_id} is not an intent.`, 'bad_transition');
              g.markIntent(input.intent_id, 'stopped', { stopped_by: origin, ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) });
              return ok('ops_dispatch', RISK, Date.now() - t0, `Intent #${input.intent_id} stopped.`, { intentId: input.intent_id });
            }
            case 'status': {
              const r = needRun();
              const cov = g.coverage(r.id);
              const intents = (g.listNodes(r.id, { kind: 'intent' }) as IntentNode[]).slice(0, 100).map((n) => ({ id: n.id, state: n.state, archetype: n.payload.archetype, ownerJob: n.ownerJob }));
              return ok('ops_dispatch', RISK, Date.now() - t0, `Run ${r.id} ${r.status}: ${cov.intentsByState.open} open, ${cov.intentsByState.running} running, ${cov.assetsTotal} assets, ${cov.pendingTriggers} pending trigger(s).`, { run: r, coverage: cov, intents });
            }
            // ── Dispatch ─────────────────────────────────────────────────────────────
            case 'claim_and_spawn': {
              const run = g.activeRun();
              if (!run) return fail('ops_dispatch', RISK, Date.now() - t0, 'denied', 'No active ops run; start_run first.');
              if (input.run_id && input.run_id !== run.id) return fail('ops_dispatch', RISK, Date.now() - t0, 'denied', `run_id ${input.run_id} is not the active run (${run.id}).`);
              const lock = g.getLock(run.id);
              if (lock && lock.sessionId !== sessionId) return fail('ops_dispatch', RISK, Date.now() - t0, 'denied', `Run ${run.id} is locked by another session (${lock.sessionId}); one dispatcher per run.`);
              if (!lock) g.acquireLock(run.id, sessionId);
              const eng = readEngagement(ctx.workspaceRoot, run.engagementId);
              const problem = engagementProblem(eng, run.engagementId);
              if (problem) return fail('ops_dispatch', RISK, Date.now() - t0, 'denied', `${problem} — authorization is a precondition, not a detail.`);
              const cov = g.coverage(run.id);
              const maxWorkers = Math.min(input.max_workers ?? DEFAULT_MAX_WORKERS, DEFAULT_MAX_WORKERS);
              const busy = cov.intentsByState.running + cov.intentsByState.claimed;
              if (busy >= maxWorkers) return fail('ops_dispatch', RISK, Date.now() - t0, 'denied', `Worker cap reached (${busy}/${maxWorkers} intents claimed or running).`);
              const claimToken = `claim_${randomBytes(8).toString('hex')}`;
              const claimed = g.claimNextIntent(run.id, claimToken);
              if (!claimed) return ok('ops_dispatch', RISK, Date.now() - t0, 'No open intents to dispatch.', { dispatched: false });
              const intent = claimed as IntentNode;
              const archetype = intent.payload.archetype as Archetype;
              if (!OPS_ARCHETYPES[archetype]) return denyHint(g, intent, `unknown archetype '${String(intent.payload.archetype)}' — only recon/auditor/verifier exist.`, t0);
              // Anti-fail-open (§6): the def the agent tool will resolve must EXACTLY equal the
              // canonical constant. A workspace shadow file that widened/renamed it denies here.
              if (!matchesCanonical(resolveAgentDef(archetype, ctx.workspaceRoot), archetype)) {
                return denyHint(g, intent, `archetype '${archetype}' does not resolve to its canonical definition (shadowed or altered def) — refusing to spawn.`, t0);
              }
              // CANONICAL constants only — a workspace shadow def can never widen this plan.
              const toolPlan = canonicalOpsTools(archetype);
              const checkProfiles = Array.isArray(intent.payload.checkProfiles) ? (intent.payload.checkProfiles as string[]) : [];
              const policy = policyFromScope(run.engagementId, eng!.scope, toolPlan, checkProfiles, maxWorkers);
              const binding = checkRunBinding(policy, run);
              if (!binding.allow) return denyHint(g, intent, binding.reason, t0);
              const decision = checkDispatch(policy, intent, toolPlan);
              if (!decision.allow) return denyHint(g, intent, decision.reason, t0);
              const agent = launcher?.();
              if (!agent) return denyHint(g, intent, 'no agent launcher bound in this host — dispatch is unavailable here (fail closed).', t0);
              // Forward ctx UNCHANGED (gate/autonomy/budget inheritance). Always background;
              // isolation:'none' is deliberate — worktree workers get a separate checks store.
              const launched = await agent.run(
                {
                  prompt: workerPrompt(intent, run),
                  subagent_type: archetype,
                  isolation: 'none',
                  run_in_background: true,
                  description: `ops intent #${intent.id} (${archetype})`,
                },
                ctx,
              );
              const jobId = (launched.data as { jobId?: string } | undefined)?.jobId;
              if (!launched.ok || !jobId) {
                return denyHint(g, intent, `worker launch failed: ${launched.error?.message ?? launched.summary ?? 'no job id returned'}`, t0);
              }
              g.attachJob(intent.id, jobId);
              g.addNode({ runId: run.id, kind: 'fact', payload: { text: `Intent #${intent.id} dispatched to job ${jobId} (archetype ${archetype}).` }, origin, anchors: [intent.id] });
              return ok('ops_dispatch', RISK, Date.now() - t0, `Intent #${intent.id} dispatched to background job ${jobId}.`, { dispatched: true, intentId: intent.id, jobId });
            }
          }
        } finally { deps.release(ctx.workspaceRoot); }
      } catch (e) {
        const code = e instanceof OpsError ? e.code : 'failed';
        return fail('ops_dispatch', RISK, Date.now() - t0, code, (e as Error).message);
      }
    },
  };
}