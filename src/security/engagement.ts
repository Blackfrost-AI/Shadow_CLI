// engagement.ts — pure F3EAD targeting-doctrine core for offensive operations.
//
// Phase 2 of the red-team harness: the model is held to the doctrine, not merely
// told about it. An engagement is an explicit state machine (Find → Fix →
// Finish → Exploit → Analyze → Disseminate); every action the model logs must
// declare the phase it belongs to and carry an ATT&CK tactic/technique tag.
// No state may be advanced without an objective and success criteria recorded
// up front, and no phase may be skipped. Everything here is pure computation:
// persistence, jail resolution and redaction live in the store/tool layers.

import { createHash } from 'node:crypto';

/** Doctrine phases in order. F3EAD front half is operations-led (find/fix/finish),
 * back half is intelligence-led (exploit/analyze/disseminate). */
export const F3EAD_PHASES = ['find', 'fix', 'finish', 'exploit', 'analyze', 'disseminate'] as const;
export type F3EADPhase = (typeof F3EAD_PHASES)[number];

export const ENGAGEMENT_STATUSES = ['planning', 'active', 'complete', 'aborted'] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export const MAX_OBJECTIVE_CHARS = 500;
export const MAX_SCOPE_CHARS = 1000;
export const MAX_SUCCESS_CHARS = 500;
export const MAX_NOTE_CHARS = 4000;
export const MAX_ACTION_TITLE_CHARS = 500;

/** ATT&CK Enterprise tactic table. Tactic-level
 * validation is strict: an action may not claim a tactic that does not exist.
 * Technique ids are validated structurally (Txxxx/Txxxx.yyy form); the full
 * technique-to-tactic mapping is intentionally not embedded — the model must
 * name the tactic it believes it is operating in, and the report shows the
 * pairing for operator review rather than silently trusting it. */
export const ATTACK_TACTICS: ReadonlyMap<string, string> = new Map([
  ['ta0001', 'Initial Access'],
  ['ta0002', 'Execution'],
  ['ta0003', 'Persistence'],
  ['ta0004', 'Privilege Escalation'],
  ['ta0005', 'Stealth'],
  ['ta0112', 'Defense Impairment'],
  ['ta0006', 'Credential Access'],
  ['ta0007', 'Discovery'],
  ['ta0008', 'Lateral Movement'],
  ['ta0009', 'Collection'],
  ['ta0010', 'Exfiltration'],
  ['ta0011', 'Command and Control'],
  ['ta0043', 'Reconnaissance'],
  ['ta0042', 'Resource Development'],
  ['ta0040', 'Impact'],
]);

const TECHNIQUE_ID = /^T\d{4}(?:\.\d{3})?$/;
const TACTIC_ID = /^TA\d{4}$/;

export interface EngagementAction {
  at: string;
  phase: F3EADPhase;
  title: string;
  note: string;
  tactic: string;
  techniques: string[];
}

export interface Engagement {
  id: string;
  objective: string;
  scope: string;
  successCriteria: string;
  status: EngagementStatus;
  phaseIndex: number;
  actions: EngagementAction[];
  startedAt: string;
  closedAt?: string;
}

export class EngagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EngagementError';
  }
}

export function isValidTactic(id: string): boolean {
  return ATTACK_TACTICS.has(id.toLowerCase());
}

export function isValidTechnique(id: string): boolean {
  return TECHNIQUE_ID.test(id.toUpperCase());
}export function validateActionPhase(action: { phase: string; tactic: string; techniques: string[] }): void {
  const phase = action.phase as F3EADPhase;
  if (!F3EAD_PHASES.includes(phase)) throw new EngagementError('invalid_phase', `Unknown F3EAD phase: ${action.phase}.`);
  const tactic = action.tactic.toLowerCase();
  if (!TACTIC_ID.test(action.tactic.toUpperCase())) throw new EngagementError('invalid_tactic', `Tactic must be an ATT&CK tactic id (TAxxxx), got: ${action.tactic}.`);
  if (!ATTACK_TACTICS.has(tactic.toLowerCase())) throw new EngagementError('unknown_tactic', `Unknown ATT&CK tactic: ${action.tactic}.`);
  for (const technique of action.techniques ?? []) {
    if (!isValidTechnique(technique)) throw new EngagementError('invalid_technique', `Technique must look like Txxxx[.yyy], got: ${technique}.`);
  }
}

export function validateEngagementSpec(spec: {
  objective?: string;
  scope?: string;
  successCriteria?: string;
}): { objective: string; scope: string; successCriteria: string } {
  const objective = (spec.objective ?? '').trim();
  const scope = (spec.scope ?? '').trim();
  const successCriteria = (spec.successCriteria ?? '').trim();
  if (!objective || objective.length > MAX_OBJECTIVE_CHARS) throw new EngagementError('bad_objective', `Objective is required (up to ${MAX_OBJECTIVE_CHARS} characters).`);
  if (scope.length > MAX_SCOPE_CHARS) throw new EngagementError('bad_scope', `Scope is too long (up to ${MAX_SCOPE_CHARS} characters).`);
  if (!successCriteria || successCriteria.length > MAX_SUCCESS_CHARS) throw new EngagementError('bad_success_criteria', `Success criteria are required (up to ${MAX_SUCCESS_CHARS} characters).`);
  return { objective, scope, successCriteria };
}

export function startEngagement(spec: {
  objective?: string;
  scope?: string;
  successCriteria?: string;
  now?: Date;
}): Engagement {
  const { objective, scope, successCriteria } = validateEngagementSpec(spec);
  const nowIso = (spec.now ?? new Date()).toISOString();
  return {
    id: `engagement_${digest(objective + scope + successCriteria + nowIso)}`,
    objective,
    scope,
    successCriteria,
    status: 'active',
    phaseIndex: 0,
    actions: [],
    startedAt: nowIso,
  };
}

export function logAction(
  engagement: Engagement,
  action: {
    phase: F3EADPhase;
    title?: string;
    note?: string;
    tactic: string;
    techniques?: string[];
    now?: Date;
  },
): Engagement {
  if (engagement.status !== 'active') throw new EngagementError('not_active', 'Only an active engagement can accept actions.');
  validateActionPhase({ phase: action.phase, tactic: action.tactic, techniques: action.techniques ?? [] });
  const title = (action.title ?? '').trim();
  const note = (action.note ?? '').trim();
  if (!title || title.length > MAX_ACTION_TITLE_CHARS) throw new EngagementError('bad_title', `Action title is required (up to ${MAX_ACTION_TITLE_CHARS} characters).`);
  if (note.length > MAX_NOTE_CHARS) throw new EngagementError('bad_note', `Action note is too long (up to ${MAX_NOTE_CHARS} characters).`);
  const declared = F3EAD_PHASES.indexOf(action.phase);
  if (declared !== engagement.phaseIndex && declared !== engagement.phaseIndex + 1) {
    throw new EngagementError(
      'phase_violation',
      `Cannot log a ${action.phase} action while in the ${F3EAD_PHASES[engagement.phaseIndex]} phase. Only the current or next phase may be logged.`,
    );
  }
  if (declared === engagement.phaseIndex + 1) {
    const current = F3EAD_PHASES[engagement.phaseIndex]!;
    if (!engagement.actions.some((a) => a.phase === current)) {
      throw new EngagementError(
        'phase_empty',
        `Cannot begin the ${action.phase} phase: no action has been logged in ${current}. Finish the current phase first.`,
      );
    }
  }
  const next: Engagement = {
    ...engagement,
    phaseIndex: declared,
    actions: [
      ...engagement.actions,
      {
        at: (action.now ?? new Date()).toISOString(),
        phase: action.phase,
        title,
        note,
        tactic: action.tactic.toLowerCase(),
        techniques: (action.techniques ?? []).map((t) => t.toUpperCase()),
      },
    ],
  };
  return next;
}

export function advancePhase(engagement: Engagement): Engagement {
  if (engagement.status !== 'active') throw new EngagementError('not_active', 'Only an active engagement can advance phase.');
  if (engagement.phaseIndex >= F3EAD_PHASES.length - 1) {
    throw new EngagementError('phase_terminal', 'Already in the final (disseminate) phase; close the engagement instead.');
}
  const current = F3EAD_PHASES[engagement.phaseIndex]!;
  if (!engagement.actions.some((a) => a.phase === current)) {
    throw new EngagementError('phase_empty', `Cannot advance from ${current}: no action has been logged in this phase.`);
  }
  return { ...engagement, phaseIndex: engagement.phaseIndex + 1 };
}

export function closeEngagement(engagement: Engagement, status: 'complete' | 'aborted', now?: Date): Engagement {
  if (status !== 'complete' && status !== 'aborted') {
    throw new EngagementError('invalid_status', `Close status must be 'complete' or 'aborted', got: ${String(status)}.`);
  }
  if (engagement.status !== 'active') throw new EngagementError('not_active', 'Only an active engagement can be closed.');
  return { ...engagement, status, closedAt: (now ?? new Date()).toISOString() };
}

export function engagementCoverage(engagement: Engagement): {
  phaseActions: { phase: F3EADPhase; actions: number }[];
  tactics: { tactic: string; name: string; actions: number }[];
} {
  const phaseActions = F3EAD_PHASES.map((phase) => ({
    phase,
    actions: engagement.actions.filter((a) => a.phase === phase).length,
  }));
  const counts = new Map<string, number>();
  for (const action of engagement.actions) {
    const tactic = action.tactic.toLowerCase();
    counts.set(tactic, (counts.get(tactic) ?? 0) + 1);
  }
  const tactics = [...counts.entries()].map(([tactic, actions]) => ({ tactic, name: ATTACK_TACTICS.get(tactic) ?? 'unknown', actions })).sort();
  return { phaseActions, tactics };
}

export function engagementReport(engagement: Engagement): string {
  const { phaseActions, tactics } = engagementCoverage(engagement);
  const statusLine = `${engagement.status}${engagement.closedAt ? ` (closed ${engagement.closedAt})` : ''}`;
  const phases = phaseActions
    .map((p) => `- ${p.phase}: ${p.actions} action(s)`)
    .join('\n');
  const tacticLines = tactics.map((t) => `- ${t.tactic.toUpperCase()} (${t.name}): ${t.actions}`).join('\n') || '- (none)';
  return [
    `# Engagement report — ${engagement.id}`,
    '',
    `Objective: ${engagement.objective}`,
    `Scope: ${engagement.scope || '(none recorded)'}`,
    `Success criteria: ${engagement.successCriteria}`,
    `Status: ${statusLine}`,
    `Current phase: ${F3EAD_PHASES[engagement.phaseIndex]}`,
    'Evidence linkage: action log only; workspace findings are not linked to this engagement.',
    '',
    '## Actions by F3EAD phase',
    phases,
    '',
    '## ATT&CK coverage',
    tacticLines,
    '',
    '## Action log',
    ...engagement.actions.map(
      (a, index) =>
        `${index + 1}. [${a.at}] ${a.phase} — ${a.title} (${a.tactic.toUpperCase()}${a.techniques.length ? `, ${a.techniques.join(', ')}` : ''})${a.note ? `\n   ${a.note}` : ''}`,
    ),
    '',
    'Unexecuted phases are shown as zero: they are gaps in coverage, not achievements.',
  ].join('\n');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
