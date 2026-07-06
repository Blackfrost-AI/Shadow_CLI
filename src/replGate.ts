import type { Interface as ReadlineInterface } from 'node:readline/promises';
import type { AutonomyLevel } from './safety/permissions.js';
import type { ApprovalDecision, ApprovalGate, ApprovalRequest, UserQuestion } from './agent/approval.js';

/**
 * Interactive approval for the plain REPL. A human is at the keyboard, so a gated
 * call (exec/network under the current autonomy, or a denylisted command) prompts
 * y/n/a on the SAME readline the prompt uses — never silently denied the way the
 * non-interactive `--task` / piped path must be. `a` (always) approves this call
 * and raises autonomy one notch for the rest of the session.
 */
export class ReplGate implements ApprovalGate {
  constructor(
    private readonly rl: ReadlineInterface,
    private readonly raiseAutonomy: () => AutonomyLevel,
  ) {}

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (req.kind === 'user_question' && req.questions?.length) {
      return this.askQuestions(req.questions);
    }

    process.stdout.write(
      `\n\x1b[1;33m${promptLabel(req.kind)}\x1b[0m ${req.preview}\n  [${req.risk}] ${req.reason}\n`,
    );
    const hint =
      req.kind === 'plan_enter'
        ? '(y)es / (n)o [n]: '
        : '(y)es / (n)o / (a)lways [n]: ';
    const ans = (await this.rl.question(hint)).trim().toLowerCase();
    if (ans === 'y' || ans === 'yes') return 'approve';
    if (req.kind !== 'plan_enter' && (ans === 'a' || ans === 'always')) {
      return { setAutonomy: this.raiseAutonomy() };
    }
    return 'deny';
  }

  private async askQuestions(questions: UserQuestion[]): Promise<ApprovalDecision> {
    const answers: Array<{ question: string; selected: string[] }> = [];
    for (const q of questions) {
      process.stdout.write(`\n\x1b[1;36m${q.header ? `${q.header}: ` : ''}${q.question}\x1b[0m\n`);
      q.options.forEach((o, i) => {
        const desc = o.description ? ` — ${o.description}` : '';
        process.stdout.write(`  ${i + 1}. ${o.label}${desc}\n`);
      });
      const raw = (await this.rl.question(q.multiSelect ? 'Enter numbers (comma-separated) or empty to skip: ' : 'Enter number [1]: ')).trim();
      if (!raw) {
        answers.push({ question: q.question, selected: [] });
        continue;
      }
      if (q.multiSelect) {
        const picks = raw
          .split(/[,\s]+/)
          .map((s) => Number(s) - 1)
          .filter((n) => n >= 0 && n < q.options.length)
          .map((n) => q.options[n]!.label);
        answers.push({ question: q.question, selected: picks });
      } else {
        const n = Number(raw) - 1;
        const pick = n >= 0 && n < q.options.length ? q.options[n]!.label : q.options[0]?.label;
        answers.push({ question: q.question, selected: pick ? [pick] : [] });
      }
    }
    return { answers };
  }
}

function promptLabel(kind: ApprovalRequest['kind']): string {
  switch (kind) {
    case 'plan_enter':
      return 'enter plan mode?';
    case 'plan_exit':
      return 'approve plan?';
    case 'user_question':
      return 'question?';
    default:
      return 'approve?';
  }
}