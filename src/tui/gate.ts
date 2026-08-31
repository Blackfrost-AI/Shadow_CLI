// src/tui/gate.ts — the interactive approval gate bridge (extracted from tui.tsx, plan 2.4).
import type { ApprovalGate, ApprovalRequest, ApprovalDecision } from '../agent/approval.js';

/**
 * Bridges the headless loop's `ApprovalGate` contract to the React UI: `request`
 * surfaces the pending call to the component (via `show`) and parks a Promise;
 * the key handler calls `respond` to resolve it. One stable instance is shared
 * by the loop and the key handler (kept in a ref) so respond() always targets
 * the Promise the running loop is awaiting.
 */
export class InteractiveGate implements ApprovalGate {
  /**
   * Pending requests, oldest first. A single `resolver` field could only ever hold ONE — a second
   * concurrent request overwrote it and the first promise was orphaned, so the loop awaited a
   * decision that could no longer arrive and the turn hung until Esc. Reachable whenever two gated
   * calls land in one turn (parallel tools, or the `ask_user_question` tool racing a permission
   * gate), which `mayNeedPermissionPrompt` no longer under-reports either.
   */
  private queue: Array<{ req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }> = [];
  /** Wired by the component to set/clear the pending-approval state. */
  show: (req: ApprovalRequest | null) => void = () => {};

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const entry = { req, resolve };
      this.queue.push(entry);
      // An aborted request (Esc/Ctrl-C) is settled by settleWithAbort, not by us — but its queue
      // slot must go, or it would surface as a dialog for a call that is already dead.
      req.signal?.addEventListener('abort', () => this.drop(entry), { once: true });
      if (this.queue.length === 1) this.show(req); // nothing ahead of it: show now
    });
  }

  respond(d: ApprovalDecision): void {
    const head = this.queue.shift();
    if (!head) return;
    this.show(this.queue[0]?.req ?? null); // surface the next one, or clear the dialog
    head.resolve(d);
  }

  private drop(entry: { req: ApprovalRequest }): void {
    const i = this.queue.findIndex((e) => e === entry);
    if (i < 0) return;
    const wasHead = i === 0;
    this.queue.splice(i, 1);
    if (wasHead) this.show(this.queue[0]?.req ?? null);
  }

  get awaiting(): boolean {
    return this.queue.length > 0;
  }
}
