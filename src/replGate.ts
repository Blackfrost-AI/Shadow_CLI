import type { Interface as ReadlineInterface } from 'node:readline/promises';
import type { AutonomyLevel } from './safety/permissions.js';
import type { ApprovalDecision, ApprovalGate, ApprovalRequest, UserQuestion } from './agent/approval.js';
import { sanitizeTerminalEscapes } from './util/scrub.js';

/**
 * Which input the headless loop consumes when no `--task` was given: the prompt-loop
 * REPL when a human is on stdin, else the pipe captured at startup. STDIN alone
 * decides — stdout being redirected (`shadow | tee`, `> log`) does NOT make the run
 * a pipe. Routing a terminal stdin to the pipe made its fallback read fd 0
 * synchronously, which BLOCKS on the terminal until EOF: `shadow | tee` hung with no
 * prompt. The invariant: fd 0 is read directly only when it is NOT a TTY; a TTY is
 * read exclusively through the readline REPL. Pure so it can be unit-tested without
 * touching real TTYs (same pattern as cli/autoOnboard.ts).
 */
export function headlessInputSource(stdinIsTTY: boolean): 'repl' | 'piped' {
  return stdinIsTTY ? 'repl' : 'piped';
}

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
    private readonly options: { plain?: boolean } = {},
  ) {}

  private write(text: string): void {
    process.stdout.write(this.options.plain ? sanitizeTerminalEscapes(text, false) : text);
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (req.kind === 'user_question' && req.questions?.length) {
      return this.askQuestions(req.questions);
    }

    this.write(
      `\n\x1b[1;33m${promptLabel(req.kind)}\x1b[0m ${req.preview}\n  [${req.risk}] ${req.reason}\n`,
    );
    // F07-09: an acknowledge-only dialog offers NO approve/deny verbs — the call is already
    // hard-blocked by the loop. We wait for one keystroke so the human SEES what was attempted,
    // then return 'deny' (the loop discards the decision anyway; 'deny' is the honest value).
    if (req.acknowledgeOnly) {
      await this.rl.question('press Enter to acknowledge (the command is blocked either way): ');
      return 'deny';
    }
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
      this.write(`\n\x1b[1;36m${q.header ? `${q.header}: ` : ''}${q.question}\x1b[0m\n`);
      q.options.forEach((o, i) => {
        const desc = o.description ? ` — ${o.description}` : '';
        this.write(`  ${i + 1}. ${o.label}${desc}\n`);
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
