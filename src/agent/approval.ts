import type { ToolCall } from '../provider/provider.js';
import type { ToolRisk } from '../tools/types.js';
import type { AutonomyLevel } from '../safety/permissions.js';

export type ApprovalKind = 'permission' | 'plan_enter' | 'plan_exit' | 'user_question';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface UserAnswer {
  question: string;
  selected: string[];
}

/**
 * The seam between the headless loop and whatever is driving approvals (the Ink
 * UI, a plain REPL, or a scripted gate in tests). The loop only ever depends on
 * this interface, never on UI code — that is what keeps it testable without Ink.
 */
export type ApprovalDecision =
  | 'approve'
  | 'deny'
  | { setAutonomy: AutonomyLevel }
  | { answers: UserAnswer[] }
  | { approveForSession: true }
  | { approveForPrefix: string };

export interface ApprovalRequest {
  /**
   * Identifies THIS pending request. Terminal gates never needed one — there is exactly one
   * prompt on screen and the human answering it is the human who was asked. Over HTTP neither
   * holds: two tabs can be open, and a decision arrives as a separate request that must name
   * what it is deciding. Without an id a handler can only resolve "whatever is pending", which
   * becomes an authorization hole the moment the decision is `approveForPrefix`.
   */
  id: string;
  kind: ApprovalKind;
  call: ToolCall;
  risk: ToolRisk;
  reason: string;
  preview: string;
  /** Populated when kind === 'user_question'. */
  questions?: UserQuestion[];
  /**
   * Aborts when the turn is interrupted. A gate that can wait indefinitely (a browser tab, a
   * terminal prompt) should stop waiting when this fires. The loop also races it — see
   * `settleWithAbort` — so a gate that ignores it still cannot hang the turn.
   */
  signal?: AbortSignal;
}

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}

/**
 * Resolve `p`, or 'deny' if `signal` aborts first.
 *
 * Every `gate.request(...)` in the loop used to be a bare await racing nothing, which meant
 * interrupt did not work during an approval AT ALL. In the TUI this is visible today: while a
 * prompt is pending the key handler intercepts every key and never reaches the ESC/Ctrl-C abort
 * path, so the only way out of a stuck approval is killing the process. A browser console makes
 * it worse, because pending-approval is its DEFAULT state at manual autonomy — a closed tab
 * would park the turn forever.
 *
 * Denying on abort (rather than rejecting) keeps the loop's existing control flow: every call
 * site already handles a denial, and an interrupted turn should not run the tool.
 */
export function settleWithAbort(p: Promise<ApprovalDecision>, signal?: AbortSignal): Promise<ApprovalDecision> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve('deny');
  return new Promise<ApprovalDecision>((resolve) => {
    const onAbort = (): void => resolve('deny');
    signal.addEventListener('abort', onAbort, { once: true });
    void p
      .then(resolve, () => resolve('deny'))
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Mint an approval id. Unique per process; the browser only needs to match it back. */
let approvalSeq = 0;
export function nextApprovalId(): string {
  approvalSeq += 1;
  return `ap_${approvalSeq.toString(36)}_${Math.trunc(performance.now()).toString(36)}`;
}

/** Test/M0 gate: returns scripted decisions in order; defaults to a fallback. */
export class ScriptedApprovalGate implements ApprovalGate {
  private i = 0;
  constructor(
    private readonly decisions: ApprovalDecision[] = [],
    private readonly fallback: ApprovalDecision = 'approve',
  ) {}

  request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    const d = this.i < this.decisions.length ? this.decisions[this.i++]! : this.fallback;
    return Promise.resolve(d);
  }
}

/** Always approves — useful for `--autonomy full` smoke runs and the mock loop. */
export class AutoApproveGate implements ApprovalGate {
  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (req.kind === 'user_question' && req.questions?.length) {
      return Promise.resolve({
        answers: req.questions.map((q) => ({
          question: q.question,
          selected: q.options[0] ? [q.options[0].label] : [],
        })),
      });
    }
    return Promise.resolve('approve');
  }
}

/**
 * Non-interactive gate for `--task` automation: there is no human to ask, so any
 * call that reaches the gate is DENIED (and fed back to the model as a recoverable
 * error). At `--autonomy full` the only calls that reach the gate are denylisted
 * catastrophic ops, so this is the safe default — capability is governed by the
 * autonomy level, and anything that would need a human is refused, never run blindly.
 */
export class AutoDenyGate implements ApprovalGate {
  request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return Promise.resolve('deny');
  }
}