import { settleWithAbort } from '../agent/approval.js';
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '../agent/approval.js';
import { redactString } from '../util/redact.js';
import type { WebSession } from './registry.js';

/**
 * The browser's approval gate — the same bridge AcpPermissionGate builds to an editor, pointed at
 * the web console instead: the loop's `ApprovalGate` on one side, an amber strip in the browser on
 * the other.
 *
 * Round-trip: `request()` emits a display-safe `approval_request` on the session bus (SSE carries
 * it to every open tab; the replay ring hands it to a refreshing one), parks the resolver on
 * `session.pendingApprovals` keyed by the request id, and waits. The browser answers via
 * POST /api/sessions/:id/approvals/:approvalId → registry.decide() → the parked settle(). Every
 * other path settles 'deny' — abort (interrupt), session close, and transport-gone (the last
 * browser detaches with the ask still open: the registry's TRANSPORT_GONE_MS grace timer
 * settles it cancelled, so a closed tab cannot park the run lock behind a ghost grant):
 * fail-closed is the floor this gate shares with every other one.
 *
 * Mapping (pinned by test/web-approval.test.ts):
 *  - 'approve'          → 'approve'
 *  - 'session'          → { approveForSession: true }  (lands on the session's SessionApprovals)
 *  - 'deny'             → 'deny'
 *  - { answers }        → { answers }                  (user_question, answered by the browser)
 *  - abort / close      → 'deny' (approval_resolved 'cancelled')
 *  - acknowledgeOnly    → informational only: the ask renders, ANY answer still resolves 'deny'
 *  - plan_enter/exit    → auto-'approve' (non-destructive state change; calls still gate here)
 *
 * The wire copy never carries the raw `call.input`: `argHint` is a short redacted digest built
 * from the same fields the transcript shows (command/path/query/url). The loop's execution path
 * still receives the unredacted call — redaction happens at this boundary, exactly like
 * sessionStream's bus→wire seam.
 */

/** Arg fields worth showing in the strip, in priority order (mirrors the transcript heuristic). */
const HINT_KEYS = ['command', 'path', 'file', 'file_path', 'pattern', 'query', 'url'] as const;

const ARG_HINT_MAX = 160;

function argHintFor(call: ApprovalRequest['call']): string | undefined {
  const input = call.input as Record<string, unknown> | undefined;
  if (input && typeof input === 'object') {
    for (const key of HINT_KEYS) {
      const v = input[key];
      if (typeof v === 'string' && v.trim()) {
        return redactString(v.length > ARG_HINT_MAX ? `${v.slice(0, ARG_HINT_MAX)}…` : v);
      }
    }
  }
  return undefined;
}

function outcomeLabel(d: ApprovalDecision): 'approved' | 'session' | 'denied' | 'cancelled' | 'answered' {
  if (d === 'approve') return 'approved';
  if (typeof d === 'object' && d !== null && 'approveForSession' in d) return 'session';
  if (typeof d === 'object' && d !== null && 'answers' in d) return 'answered';
  return 'denied'; // plain 'deny' — the tool/question resolution itself is unchanged
}

export class WebApprovalGate implements ApprovalGate {
  constructor(private readonly session: WebSession) {}

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    // Never START a browser round-trip for a turn that is already gone.
    if (req.signal?.aborted) return Promise.resolve('deny');
    return settleWithAbort(this.decide(req), req.signal);
  }

  private async decide(req: ApprovalRequest): Promise<ApprovalDecision> {
    // Mode transitions are non-destructive state changes; every CALL that follows still gates here.
    if (req.kind === 'plan_enter' || req.kind === 'plan_exit') return 'approve';

    this.session.bus.emit({
      type: 'approval_request',
      id: req.id,
      kind: req.kind,
      tool: req.call.name,
      risk: req.risk,
      reason: req.reason,
      preview: redactString(req.preview ?? '').slice(0, 2000),
      argHint: argHintFor(req.call),
      acknowledgeOnly: req.acknowledgeOnly || undefined,
      questions: req.kind === 'user_question' ? req.questions : undefined,
    });

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const settle = (
        d: ApprovalDecision,
        label: 'approved' | 'session' | 'denied' | 'cancelled' | 'answered' = outcomeLabel(d),
      ): void => {
        if (settled) return; // late browser answer after an abort/close — drop it
        settled = true;
        this.session.pendingApprovals.delete(req.id);
        req.signal?.removeEventListener('abort', onAbort);
        this.session.bus.emit({ type: 'approval_resolved', id: req.id, outcome: label });
        resolve(d);
      };
      const onAbort = (): void => settle('deny', 'cancelled');
      req.signal?.addEventListener('abort', onAbort, { once: true });
      this.session.pendingApprovals.set(req.id, { settle, receivedAt: Date.now() });
    });

    // An informational dialog hard-blocks the call regardless of what was acknowledged.
    if (req.acknowledgeOnly) return 'deny';
    return decision;
  }
}
