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
  kind: ApprovalKind;
  call: ToolCall;
  risk: ToolRisk;
  reason: string;
  preview: string;
  /** Populated when kind === 'user_question'. */
  questions?: UserQuestion[];
}

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
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