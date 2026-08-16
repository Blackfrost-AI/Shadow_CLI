/**
 * The approval bridge: the loop's `ApprovalGate` on one side, the editor's
 * `session/request_permission` on the other. This is what makes ACP strictly MORE capable than
 * the web console (whose WebDenyGate can only deny) while keeping the same fail-closed floor:
 * every ambiguity, cancellation, and transport failure resolves to 'deny'.
 *
 * Mapping (pinned by tests):
 *  - allow_once      → 'approve'
 *  - allow_always    → { approveForSession: true }  (the loop records it in SessionApprovals)
 *  - reject_once / reject_always / cancelled / unknown / transport error → 'deny'
 *  - acknowledgeOnly → a single "acknowledge" option is shown, but the call is hard-blocked:
 *                      the decision is ALWAYS 'deny' (F07-09 — the dialog is informational).
 *  - user_question   → auto-answered with each question's FIRST option (AutoApproveGate parity)
 *                      plus a finding so the user sees what was answered; v0 editors have no
 *                      question UI on this channel.
 *  - plan_enter / plan_exit → auto-'approve': mode transitions are non-destructive state
 *                      changes, and every CALL that follows still goes through this gate.
 *  - req.signal      → raced via settleWithAbort: interrupt during a pending approval = 'deny'.
 */
import { settleWithAbort } from '../agent/approval.js';
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from '../agent/approval.js';
import { redact } from '../util/redact.js';
import { toolKindFor } from './events.js';
import type { RequestPermissionOption, RequestPermissionParams, RequestPermissionResult } from './protocol.js';

/** Transport seam (injected by the server): ask the editor, resolve undefined on any failure. */
export type PermissionAsk = (
  params: RequestPermissionParams,
  signal?: AbortSignal,
) => Promise<RequestPermissionResult | undefined>;

export class AcpPermissionGate implements ApprovalGate {
  constructor(
    private readonly sessionId: string,
    private readonly ask: PermissionAsk,
    private readonly emitFinding: (title: string, body: string) => void = () => {},
  ) {}

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    // Already interrupted: never START an editor round-trip for a turn that is gone — settle
    // raced the request above would deny anyway, but this avoids a pointless wire request.
    if (req.signal?.aborted) return Promise.resolve('deny');
    return settleWithAbort(this.decide(req), req.signal);
  }

  private async decide(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (req.kind === 'user_question') {
      const questions = req.questions ?? [];
      const answers = questions.map((q) => ({
        question: q.question,
        selected: q.options[0] ? [q.options[0].label] : [],
      }));
      if (questions.length) {
        this.emitFinding(
          'user_question auto-answered',
          `No question UI on the ACP channel in v0 — first option taken: ${questions
            .map((q) => `${q.question} → ${q.options[0]?.label ?? '(none)'}`)
            .join(' | ')}`,
        );
      }
      return { answers };
    }

    if (req.kind === 'plan_enter' || req.kind === 'plan_exit') return 'approve';

    const options: RequestPermissionOption[] = req.acknowledgeOnly
      ? [{ optionId: 'acknowledge', kind: 'allow_once', name: 'Acknowledge' }]
      : [
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'allow_always', kind: 'allow_always', name: 'Allow for this session' },
        ];

    const params: RequestPermissionParams = {
      sessionId: this.sessionId,
      toolCall: {
        toolCallId: req.call.id,
        title: req.call.name,
        description: req.reason,
        kind: toolKindFor(req.call, req.risk),
        rawInput: req.call.input,
      },
      options,
    };

    let result: RequestPermissionResult | undefined;
    try {
      // The permission params carry the tool's raw input to the editor (whose thread store
      // persists it) — scrubbed at this boundary, same posture as the web console's bus→wire
      // seam. The loop's own execution path still sees the unredacted call.
      result = await this.ask(redact(params), req.signal);
    } catch {
      return 'deny'; // transport failure = fail-closed
    }

    if (req.acknowledgeOnly) return 'deny'; // informational — hard-blocked regardless of the answer

    const optionId = result?.outcome?.outcome === 'selected' ? result.outcome.optionId : undefined;
    switch (optionId) {
      case 'allow_once':
        return 'approve';
      case 'allow_always':
        return { approveForSession: true };
      default:
        return 'deny'; // reject_once, reject_always, cancelled, undefined, or an unknown optionId
    }
  }
}
