import type { EventBus } from '../agent/events.js';
import type { ApprovalGate, ApprovalRequest, ApprovalDecision } from '../agent/approval.js';

/**
 * Fail-closed approval gate for browser-created sessions (§8 Q1 → option a).
 *
 * There is no approval channel in v1 — `LoopEvent` has no approval variant — so a tool that
 * reaches the gate (`run_shell`, network at `auto-edit`) has no human to answer it. Rather than
 * hang the turn until it is interrupted, DENY immediately and surface a visible `finding` so the
 * browser shows WHY. Capability is governed by autonomy + the jail + the allowlist; anything that
 * would need a per-tool prompt is refused, never run blindly.
 */
export class WebDenyGate implements ApprovalGate {
  constructor(private readonly bus: EventBus) {}

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.bus.emit({
      type: 'finding',
      title: `${req.call.name} needs approval`,
      body:
        `The browser can't answer tool approvals yet, so this ${req.call.name} was denied ` +
        `(${req.reason}). Run it from the terminal session instead.`,
      severity: 'warn',
    });
    return Promise.resolve('deny');
  }
}
