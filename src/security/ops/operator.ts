/**
 * `/ops` — the OPERATOR control surface (plan §9), shared by both renderers. Fully sync
 * (node:sqlite DatabaseSync, JobStore, EngagementStore are all sync) so it fits the Ink
 * slash switch and the Snowfall command switch without async plumbing.
 *
 * Operator origin is real here: this path is typed by the human at the terminal, never
 * reachable from a model tool call. `prove` is the ONLY sanctioned operator attestation —
 * it requires a non-empty trimmed reason, recorded in the goal patch (graph.ts attestGoal
 * override branch). Lifecycle transitions reuse the SAME engagement authorization predicate
 * as ops_dispatch (exported, never duplicated — drift on a security predicate is a bug).
 *
 * Handles: existence-checked lazy OpsGraph via the session OpsRuntime when provided (no DB
 * creation from a UI path — review R5), otherwise a direct open for tests. Every error is
 * pushed as a red line; nothing throws into the render loop.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OpsGraph } from './graph.js';
import { OPS_DB_PATH, OpsError } from './types.js';
import type { IntentNode } from './types.js';
import { opsHudLine } from './feed.js';
import { JobStore } from '../../state/jobStore.js';
import { EvidenceStore } from '../evidence.js';
import { readEngagement, engagementProblem } from '../../tools/opsDispatch.js';
import type { OpsToolDeps } from '../../tools/opsTools.js';

export interface OpsCommandIo {
  workspace: string;
  /** MUST be the lead's session id (SessionLog.sessionIdFromPath at call time) so the
   *  advisory dispatcher lock matches claim_and_spawn — review R6. */
  sessionId: string;
  pushLine: (text: string, opts?: { error?: boolean; system?: boolean }) => void;
  /** Session-lived handle pool when available; omitted in tests. */
  deps?: OpsToolDeps;
}

const USAGE =
  'Usage: /ops [status] · graph · pause · resume · stop <intentId> · recover · prove <goalId> --reason <text> · complete · abort';

/** Open a read/write graph for one command; returns undefined (with a pushed note) when
 *  the DB does not exist yet — a UI path must never CREATE the ops store. */
function openExisting(io: OpsCommandIo): { g: OpsGraph; release: () => void } | undefined {
  if (!existsSync(join(io.workspace, OPS_DB_PATH))) {
    io.pushLine('No ops run yet. Start one with the ops_dispatch tool (start_run) from the lead.', { system: true });
    return undefined;
  }
  if (io.deps) {
    return { g: io.deps.graph(io.workspace), release: () => io.deps!.release(io.workspace) };
  }
  // Direct open (tests / no session runtime): fresh ledger reader per handle, same pattern
  // as OpsRuntime.findingStatusReader — the operator path never pins stale finding status.
  const g = new OpsGraph(io.workspace, {
    findingStatus: (ledgerId) => {
      const ev = new EvidenceStore(io.workspace);
      try {
        return ev.get(ledgerId).status;
      } finally {
        ev.close();
      }
    },
  });
  return { g, release: () => g.close() };
}

/** Latest run (any status) — status/graph should still work on a paused or finished run. */
function latestRun(g: OpsGraph): ReturnType<OpsGraph['activeRun']> {
  return g.activeRun() ?? g.listRuns().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * Run one `/ops <args>` line. Synchronous by construction; never throws.
 */
export function runOpsCommand(arg: string, io: OpsCommandIo): void {
  const [sub = 'status', ...rest] = arg.trim().split(/\s+/).filter(Boolean);
  let opened: { g: OpsGraph; release: () => void } | undefined;
  try {
    opened = openExisting(io);
    if (!opened) return;
    const { g } = opened;
    const run = latestRun(g);
    if (!run) {
      io.pushLine('Ops store exists but has no runs.', { system: true });
      return;
    }
    switch (sub) {
      case 'status': {
        const c = g.coverage(run.id);
        io.pushLine(opsHudLine(run, c), { system: true });
        io.pushLine(`objective: ${run.objective}`, { system: true });
        const lock = g.getLock(run.id);
        io.pushLine(
          lock
            ? `dispatcher lock: session ${lock.sessionId} (one dispatcher per run${lock.sessionId === io.sessionId ? ' — this session' : ''})`
            : 'dispatcher lock: none held',
          { system: true },
        );
        const goals = g.listNodes(run.id, { kind: 'goal' });
        for (const goal of goals) io.pushLine(`  goal #${goal.id} [${goal.state}] ${String(goal.payload.title ?? goal.payload.text ?? '')}`, { system: true });
        return;
      }
      case 'graph': {
        io.pushLine(g.overview(run.id).text, { system: true });
        return;
      }
      case 'pause': {
        g.setRunStatus(run.id, 'paused', 'operator');
        io.pushLine(`Run ${run.id} paused. Workers already running keep their jobs; new dispatch is refused until resume.`, { system: true });
        return;
      }
      case 'resume': {
        // Same fail-closed authorization re-check as ops_dispatch resume_run.
        const problem = engagementProblem(readEngagement(io.workspace, run.engagementId), run.engagementId);
        if (problem) {
          io.pushLine(`Resume denied: ${problem}`, { error: true });
          return;
        }
        g.setRunStatus(run.id, 'active', 'operator');
        // acquireLock is boolean — a silent failure here would mislead (review R6).
        if (!g.acquireLock(run.id, io.sessionId)) {
          const lock = g.getLock(run.id);
          io.pushLine(`Run ${run.id} resumed, but the dispatcher lock is held by session ${lock?.sessionId ?? 'unknown'} — claim_and_spawn from this session will deny until that session releases it.`, { error: true });
        } else {
          io.pushLine(`Run ${run.id} resumed; dispatcher lock held by this session.`, { system: true });
        }
        return;
      }
      case 'stop': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id) || id <= 0) {
          io.pushLine('Usage: /ops stop <intentId>', { error: true });
          return;
        }
        const node = g.getNode(id);
        if (node.kind !== 'intent' || node.runId !== run.id) {
          io.pushLine(`Node #${id} is not an intent on run ${run.id}.`, { error: true });
          return;
        }
        const intent = node as IntentNode;
        g.markIntent(id, 'stopped', { stopped_by: 'operator' });
        io.pushLine(
          intent.ownerJob
            ? `Intent #${id} stopped. NOTE: the worker job ${intent.ownerJob} keeps running — cancel it via the jobs surface if needed.`
            : `Intent #${id} stopped.`,
          { system: true },
        );
        return;
      }
      case 'recover': {
        const jobs = new JobStore(io.workspace);
        let n: number;
        try {
          n = g.recoverOrphans(run.id, (jobId) => {
            const job = jobs.get(jobId);
            return !!job && (job.status === 'running' || job.status === 'pending');
          });
        } finally {
          jobs.close();
        }
        io.pushLine(`Recovery: ${n} orphaned claim(s) requeued on run ${run.id}.`, { system: true });
        return;
      }
      case 'prove': {
        const id = Number(rest[0]);
        const flagAt = rest.indexOf('--reason');
        const reason = flagAt >= 0 ? rest.slice(flagAt + 1).join(' ').trim() : '';
        if (!Number.isInteger(id) || id <= 0 || !reason) {
          io.pushLine('Usage: /ops prove <goalId> --reason <text> — an operator override needs a recorded reason.', { error: true });
          return;
        }
        // Operator attestation: no evidence anchors, the reason IS the record (§9).
        g.attestGoal(id, [], 'operator', reason);
        io.pushLine(`Goal #${id} attested met by operator override — reason recorded in the goal patch.`, { system: true });
        return;
      }
      case 'complete':
      case 'abort': {
        const status = sub === 'complete' ? 'complete' : 'aborted';
        g.setRunStatus(run.id, status, 'operator');
        g.releaseLock(run.id, io.sessionId);
        const lock = g.getLock(run.id);
        io.pushLine(
          `Run ${run.id} ${status}.` + (lock ? ` Lock row remains (held by session ${lock.sessionId}); harmless — new runs get new ids.` : ''),
          { system: true },
        );
        return;
      }
      default:
        io.pushLine(USAGE, { error: true });
    }
  } catch (e) {
    io.pushLine(e instanceof OpsError ? `ops: ${e.message}` : `ops error: ${e instanceof Error ? e.message : String(e)}`, { error: true });
  } finally {
    try {
      opened?.release();
    } catch {
      /* release is best-effort */
    }
  }
}