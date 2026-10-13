import type { LoopEvent } from './events.js';
import type { TodoItem } from './todo.js';
import type { MissionSnapshot } from './mission.js';
import type { CheckSelection } from '../checks/store.js';

export interface CompletionPolicy { enabled?: boolean; maxRetries?: number; }
export interface CompletionEvidence {
  todos?: TodoItem[]; mission?: MissionSnapshot; checks?: CheckSelection[];
  canUpdateTodos: boolean; canUpdateMission: boolean; canRunChecks: boolean;
}

/** Evidence, never prose promises, may request a corrective turn. The lifetime is one user run;
 * stale session lists cannot turn an unrelated question into resumed work. */
export class CompletionGuard {
  readonly maxRetries: number;
  attempts = 0;
  blocked = false;
  private todosTouched = false;
  private missionTouched = false;
  private checksTouched = false;
  private readonly checkCalls = new Set<string>();
  constructor(policy?: CompletionPolicy) {
    const requested = policy?.maxRetries;
    this.maxRetries = policy?.enabled === false ? 0 : Math.max(0, Math.min(2, Number.isFinite(requested) ? Math.floor(requested!) : 2));
  }
  markCheckCall(id: string): void { this.checkCalls.add(id); this.checksTouched = true; }
  observe(event: LoopEvent): void {
    // A delegated loop owns its own evidence; its events must not accidentally veto the lead.
    if ('subagent' in event && event.subagent) return;
    if (event.type === 'tool_denied') this.blocked = true;
    if (event.type !== 'tool_end') return;
    const { call, result } = event;
    if (!result.ok) {
      const isFailedCheck = (this.checkCalls.has(call.id) || call.name === 'project_checks') && result.error?.code === 'nonzero_exit';
      if (!isFailedCheck) this.blocked = true;
      return;
    }
    if (call.name === 'todo_write') this.todosTouched = true;
    if (call.name === 'mission_update' || call.name === 'exit_plan_mode') this.missionTouched = true;
    if (call.name === 'project_checks' && (call.input as { action?: string })?.action === 'select') this.checksTouched = true;
  }
  reasons(evidence: CompletionEvidence): string[] {
    if (this.blocked) return [];
    const reasons: string[] = [];
    if (this.todosTouched && evidence.canUpdateTodos) {
      for (const item of evidence.todos ?? []) {
        // Detached work is allowed to outlive this run. A linked background job is visible in
        // the task list/Work Center and never causes automatic polling or a false task failure.
        if (item.status !== 'completed' && !item.jobId) reasons.push(`Task ${item.id} is ${item.status}: ${item.subject.slice(0, 300)}`);
      }
    }
    const mission = evidence.mission;
    if (this.missionTouched && evidence.canUpdateMission && mission?.active && ['executing', 'verifying'].includes(mission.phase)) {
      for (const item of mission.tasks) {
        if (item.status === 'pending' || item.status === 'in_progress') reasons.push(`Mission ${item.id} is ${item.status}: ${item.subject.slice(0, 300)}`);
      }
      if (mission.phase === 'verifying' && !mission.tasks.some((item) => item.status === 'failed' || item.status === 'delegated')) reasons.push('The current mission is still in its verification phase.');
    }
    if (this.checksTouched && evidence.canRunChecks) {
      for (const item of evidence.checks ?? []) {
        if (item.selected && (item.status === 'failed' || item.status === 'not_run')) reasons.push(`Required check ${item.profile.id} is ${item.status}.`);
      }
    }
    return reasons.slice(0, 16);
  }
}

/** Conservative escape hatch for an intentional handoff. This only SUPPRESSES continuation;
 * text classification can never start work or override a permission/cancellation boundary. */
export function completionAwaitsUser(text: string): boolean {
  const tail = text.trim().split(/\n\s*\n/).at(-1) ?? '';
  return /\?\s*$/.test(tail) || /(?:^|\n)\s*(?:blocked(?:\b|:)|waiting (?:for|on) (?:you|your|user)|(?:i |we )?need (?:your|user) (?:input|confirmation|approval|permission)|please (?:provide|confirm|choose|select|send|approve))\b/i.test(tail);
}

export function completionPrompt(reasons: string[], attempt: number, maxAttempts = 2): string {
  return `Shadow completion check ${attempt}/${maxAttempts}: explicit task evidence remains unresolved.\n` +
    reasons.map((reason) => `- ${reason}`).join('\n') +
    '\nContinue only the already authorized task at the next safe step. Reuse completed tool results; never replay a write or command merely because an answer was incomplete. ' +
    'If work is already complete, update its task/check state using actual evidence. If blocked, awaiting user input, or intentionally leaving a background job running, explain that and stop. Do not invent new work or mark checks passed without running them.';
}
