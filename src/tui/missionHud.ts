// Mission HUD rendering (Sprint 3 item 3.2, Package 8) — pure functions, no JSX.
// The mission gets ONE line while running (riding the row the old standing-goal
// occupied — row-count parity with layout.ts's hasGoal accounting) and ONE row in
// the idle PinnedState block. All truncation happens HERE, never in JSX, so the
// frame budget (fitHud) is untouched: one line in, one line out.

import type { MissionSnapshot } from '../agent/mission.js';

/** HUD/pinned one-liner budget — the old goal row's practical ceiling. */
const HUD_CHARS = 80;

function counts(s: MissionSnapshot): string {
  if (s.tasks.length === 0) return '';
  const done = s.tasks.filter((t) => t.status === 'done').length;
  return ` ${done}/${s.tasks.length}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The one-line pinned summary: `🎯 <mission> · <phase> n/m`. '' when no active
 * mission — empty keeps hudPinnedLine/composer budgets identical to the pre-mission
 * state (a blank segment is filtered out by the join).
 */
export function missionHudLine(s: MissionSnapshot | null): string {
  if (!s?.active) return '';
  return truncate(`🎯 ${s.mission} · ${s.phase}${counts(s)}`, HUD_CHARS);
}

/**
 * The idle PinnedState row (replaces the old `🎯 Goal:` row — still ONE truncate
 * row, purple, same budget slot). null when no active mission.
 */
export function missionPinnedRow(s: MissionSnapshot | null): string | null {
  if (!s?.active) return null;
  return truncate(`🎯 Mission: ${s.mission} · ${s.phase}${counts(s)}`, HUD_CHARS);
}

/** The `/goal` (no args) and `/status` summary — full text, the transcript scrolls. */
export function missionStatusLines(s: MissionSnapshot | null): string[] {
  if (!s?.active) return ['No mission active. Use /goal <text> to start one; /goal clear removes it.'];
  const out = [`Mission: ${s.mission}`, `Phase: ${s.phase}`];
  if (s.planPath) out.push(`Plan: ${s.planPath}`);
  if (s.tasks.length > 0) {
    for (const t of s.tasks) {
      out.push(`  ${t.id}. [${t.status}] ${t.subject}${t.detail ? ` — ${t.detail}` : ''}`);
    }
  } else {
    out.push('  (no task list — phase-only mission)');
  }
  out.push('Update with mission_update; /goal clear ends the mission.');
  return out;
}
