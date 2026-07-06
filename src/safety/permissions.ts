import type { ToolRisk } from '../tools/types.js';

/**
 * Graduated autonomy. The level decides which risk classes auto-approve and
 * which must pass through the ApprovalGate. Extended in M2 with the denylist
 * (catastrophic ops always require confirmation regardless of level).
 *
 * The optional `autoClassifier` config flag (not a separate autonomy level) extends
 * `auto-read` with a rule-based classifier stub — see `src/safety/classifier.ts`.
 */
export type AutonomyLevel =
  | 'manual' // confirm EVERY tool call
  | 'auto-read' // auto-approve read+search; confirm write/exec/network
  | 'auto-edit' // auto-approve read + writes inside the workspace; confirm exec/network
  | 'full'; // auto-approve everything EXCEPT denylisted/destructive ops

export const AUTONOMY_LEVELS: AutonomyLevel[] = ['manual', 'auto-read', 'auto-edit', 'full'];

/** Claude Code permission mode names for parity / display. */
export function claudeModeName(level: AutonomyLevel): string {
  switch (level) {
    case 'manual':
      return 'default';
    case 'auto-read':
      return 'auto';
    case 'auto-edit':
      return 'acceptEdits';
    case 'full':
      return 'bypassPermissions';
  }
}

/** True when `level` is at least as autonomous as `min`. */
export function isAutonomyAtLeast(level: AutonomyLevel, min: AutonomyLevel): boolean {
  return AUTONOMY_LEVELS.indexOf(level) >= AUTONOMY_LEVELS.indexOf(min);
}

/** Next level in the cycle, for the mid-session toggle key (wraps full→manual). */
export function cycleAutonomy(level: AutonomyLevel): AutonomyLevel {
  const i = AUTONOMY_LEVELS.indexOf(level);
  return AUTONOMY_LEVELS[(i + 1) % AUTONOMY_LEVELS.length]!;
}

/**
 * One level more autonomous, clamped at `full` — for an "always/approve-and-raise"
 * action, which must never silently DOWNGRADE the session the way the wrapping
 * cycle would (full→manual).
 */
export function raiseAutonomy(level: AutonomyLevel): AutonomyLevel {
  const i = AUTONOMY_LEVELS.indexOf(level);
  return AUTONOMY_LEVELS[Math.min(i + 1, AUTONOMY_LEVELS.length - 1)]!;
}

/**
 * Does a tool of the given risk require explicit approval at this level?
 * (The denylist, added in M2, can force approval even when this returns false.)
 */
export function needsApproval(risk: ToolRisk, level: AutonomyLevel): boolean {
  switch (level) {
    case 'manual':
      return true;
    case 'auto-read':
      return risk !== 'read';
    case 'auto-edit':
      return risk === 'exec' || risk === 'network';
    case 'full':
      return false;
  }
}
