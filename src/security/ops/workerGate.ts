/**
 * Ops worker enforcement (plan §4b) — the per-call policy gate for dispatched workers.
 *
 * Two enforcement points, both fail-closed:
 *   1. the worker loop, AFTER alias canonicalization and BEFORE permissions/classifier
 *      (loop.ts runToolCall) — only subtracts; an allow still faces the full safety pipeline;
 *   2. executeProjectCheck, BEFORE the inner run_shell is admitted — a bound profile is
 *      required even though the inner shell is harness-created.
 *
 * The policy is rebuilt from DURABLE state on every call (active run → running intent owned
 * by this job → engagement scope → canonical archetype plan). Nothing is cached across
 * calls, so a stopped run, a finished intent, or a closed engagement takes effect immediately.
 * Any failure to resolve the binding denies — an ops worker without a provable policy is
 * not an unrestricted worker.
 */
import type { IntentNode } from './types.js';
import type { Archetype } from './types.js';
import { OPS_ARCHETYPES, canonicalOpsTools } from './archetypes.js';
import { policyFromScope, checkToolCall, type Decision, type OpsPolicy } from './policy.js';
import { EngagementStore } from '../../tools/engagementOps.js';
import { OpsGraph } from './graph.js';
import { EvidenceStore } from '../evidence.js';

export interface OpsWorkerGate {
  /** Consulted for EVERY tool call inside an ops worker loop. Non-ops loops never get one. */
  (call: { name: string; input: unknown }): Decision;
}

/**
 * Build the gate for one dispatched worker. `jobId` is the loop's currentWorkId (the job
 * store id the dispatcher attached to the intent). Opens its own short-lived handles per
 * call — the gate must not depend on the lead's runtime handles being open.
 */
export function makeOpsWorkerGate(workspace: string, jobId: string): OpsWorkerGate {
  const deny = (reason: string): Decision => ({ allow: false, reason: `ops policy: ${reason}` });
  return (call) => {
    let g: OpsGraph | undefined;
    let eng: EngagementStore | undefined;
    try {
      g = new OpsGraph(workspace, {
        findingStatus: (ledgerId) => {
          const ev = new EvidenceStore(workspace);
          try {
            return ev.get(ledgerId).status;
          } finally {
            ev.close();
          }
        },
      });
      const run = g.activeRun();
      if (!run) return deny('no active ops run; worker authority has expired.');
      const intent = (g.listNodes(run.id, { kind: 'intent', state: 'running' }) as IntentNode[]).find((n) => n.ownerJob === jobId);
      if (!intent) return deny(`no running intent owned by job ${jobId}; write-back or finish, do not act.`);
      const archetype = intent.payload.archetype as Archetype;
      if (!OPS_ARCHETYPES[archetype]) return deny(`intent carries unknown archetype '${String(intent.payload.archetype)}'.`);
      eng = new EngagementStore(workspace);
      const record = eng.get(run.engagementId);
      if (!record || record.status !== 'active') return deny(`engagement ${run.engagementId} is not active.`);
      const checkProfiles = Array.isArray(intent.payload.checkProfiles) ? (intent.payload.checkProfiles as string[]) : [];
      const policy: OpsPolicy = policyFromScope(run.engagementId, record.scope, canonicalOpsTools(archetype), checkProfiles);
      return checkToolCall(policy, call);
    } catch (e) {
      return deny(`policy resolution failed (${(e as Error).message}); failing closed.`);
    } finally {
      try {
        eng?.close();
      } catch {
        /* best effort */
      }
      try {
        g?.close();
      } catch {
        /* best effort */
      }
    }
  };
}

/** True when `type` names a canonical ops archetype (used by the agent tool to bind the gate). */
export function isOpsArchetype(type: string | undefined): type is Archetype {
  return type === 'recon' || type === 'auditor' || type === 'verifier';
}