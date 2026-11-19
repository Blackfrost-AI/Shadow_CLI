/**
 * Session-lived wiring for the ops_* tools (plan §7). Handles are opened lazily per call and
 * released at call end (securityFindings.ts pattern); the enricher pool is the one persistent
 * piece — its cooldown map and in-flight queue must survive across calls — and it owns a graph
 * handle it closes on dispose(). The pool re-reads nothing stale: the graph is a SQLite view,
 * so a fresh handle sees every committed write from any handle.
 */
import { OpsGraph } from './graph.js';
import { EnricherPool } from './enrich.js';
import { EvidenceStore } from '../evidence.js';
import type { FindingStatus } from '../evidence.js';
import type { OpsToolDeps } from '../../tools/opsTools.js';
import { readEngagement } from '../../tools/opsDispatch.js';
import { parseScope } from './policy.js';

interface WorkspaceOps {
  graph?: OpsGraph;
  evidence?: EvidenceStore;
  pool?: EnricherPool;
  poolGraph?: OpsGraph;
  refs: number;
}

/** One instance per bootstrap (session). Keyed by workspace for tests and worktree callers. */
export class OpsRuntime {
  private byWorkspace = new Map<string, WorkspaceOps>();
  private disposed = false;

  private slot(workspace: string): WorkspaceOps {
    let s = this.byWorkspace.get(workspace);
    if (!s) {
      s = { refs: 0 };
      this.byWorkspace.set(workspace, s);
    }
    return s;
  }

  /** Fresh ledger status reader — the pool's graph handle outlives any one call. */
  private findingStatusReader(workspace: string): (ledgerId: string) => FindingStatus {
    return (ledgerId) => {
      const ev = new EvidenceStore(workspace);
      try {
        return ev.get(ledgerId).status;
      } finally {
        ev.close();
      }
    };
  }

  deps(): OpsToolDeps {
    return {
      graph: (workspace) => {
        if (this.disposed) throw new Error('Ops runtime disposed.');
        const s = this.slot(workspace);
        if (!s.graph) s.graph = new OpsGraph(workspace, { findingStatus: this.findingStatusReader(workspace) });
        s.refs++;
        return s.graph;
      },
      evidence: (workspace) => {
        const s = this.slot(workspace);
        if (!s.evidence) s.evidence = new EvidenceStore(workspace);
        s.refs++; // same lease discipline as graph() — release() decrements unconditionally
        return s.evidence;
      },
      pool: (workspace) => {
        if (this.disposed) throw new Error('Ops runtime disposed.');
        const s = this.slot(workspace);
        if (!s.pool) {
          s.poolGraph = new OpsGraph(workspace, { findingStatus: this.findingStatusReader(workspace) });
          s.pool = new EnricherPool(s.poolGraph, workspace, undefined, undefined, {
            allowNetwork: (engagementId) => this.engagementAllowsNetwork(workspace, engagementId),
          });
        }
        return s.pool;
      },
      release: (workspace) => {
        const s = this.byWorkspace.get(workspace);
        if (!s) return;
        s.refs = Math.max(0, s.refs - 1);
        // Close the call-scoped handles now; the pool keeps its own graph until dispose().
        if (s.refs === 0) {
          try {
            s.graph?.close();
          } catch {
            /* already closed */
          }
          s.graph = undefined;
          try {
            s.evidence?.close();
          } catch {
            /* already closed */
          }
          s.evidence = undefined;
        }
      },
    };
  }

  /** Session shutdown: drain enrichment, then close every handle. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.byWorkspace.values()) {
      try {
        await s.pool?.drain();
      } catch {
        /* drain resolves on quiescence; failures already landed as hints */
      }
      for (const h of [s.graph, s.evidence, s.poolGraph]) {
        try {
          h?.close();
        } catch {
          /* already closed */
        }
      }
    }
    this.byWorkspace.clear();
  }

  /** Literal `allow-network` scope token on the DURABLE engagement (§8): the operator
   *  approval that lets network enrichers egress. Resolved per drain call, never cached —
   *  closing the engagement or editing the scope takes effect on the next lookup.
   *  Uses the SAME token extractor as the dispatch policy (parseScope) so a scope
   *  string cannot mean different things at different enforcement layers. */
  private engagementAllowsNetwork(workspace: string, engagementId: string): boolean {
    const eng = readEngagement(workspace, engagementId);
    return !!eng && parseScope(String(eng.scope ?? '')).allowNetwork;
  }
}