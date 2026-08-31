// /goal mission mode (Sprint 3 item 3.2) — the harness-side half of an orchestrator.
//
// The division of labor is deliberate: the MODEL orchestrates inside its own turns
// (dispatching subtasks, reading results, verifying); the harness only gates the plan
// (plan mode), tracks state, and pins this block in front of the model every turn.
// Like TodoList, the mission lives in the SYSTEM PROMPT, not the message history —
// summarization/compaction can never eat it, and it is always current.
//
// Sub-agents never see this block (the sub-agent loop factory omits `mission`), and
// their mission_update calls are inert (ctx.nestedAgent guard) — one lead agent owns
// the mission state or a fleet of delegates would clobber it.

import { openSync, readSync, closeSync, statSync } from 'node:fs';

export type MissionPhase = 'planning' | 'executing' | 'verifying' | 'done' | 'failed';

export type MissionTaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'delegated';

export interface MissionTask {
  /** Positional id assigned at seeding (m-1, m-2, ...). Stable for the mission's life. */
  id: string;
  subject: string;
  status: MissionTaskStatus;
  /** One-line outcome/evidence, updated alongside status. */
  detail?: string;
}

export interface MissionSnapshot {
  active: boolean;
  mission: string;
  phase: MissionPhase;
  tasks: MissionTask[];
  /** Path of the approved plan file, once plan approval seeded the tasks. */
  planPath?: string;
  updatedAt: string;
}

export type MissionListener = (snapshot: MissionSnapshot) => void;

/** Matches plan_write's `tasks` cap — the two must move together. */
export const MISSION_TASK_LIMIT = 24;

const MISSION_TEXT_CHARS = 400;
const BLOCK_TASK_LIMIT = 12;
/** How much of the session log tail to scan for the last mission record. */
const RESUME_SCAN_BYTES = 64 * 1024;

const PHASES: ReadonlySet<string> = new Set(['planning', 'executing', 'verifying', 'done', 'failed']);
const TASK_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'done', 'failed', 'delegated']);

const PHASE_INSTRUCTIONS: Record<MissionPhase, string> = {
  planning:
    'You are in the PLANNING phase. Explore and read freely, then write the plan with plan_write ' +
    '(include a `tasks` array of concrete implementation steps) and call exit_plan_mode for user ' +
    'approval. Do not begin implementation until the plan is approved.',
  executing:
    'You are in the EXECUTING phase. Work the tasks in order; dispatch independent subtasks to ' +
    'sub-agents when useful (they inherit session autonomy and budget ceilings — never escalate). ' +
    'Keep mission task statuses current with mission_update as work completes or fails.',
  verifying:
    'You are in the VERIFYING phase. Implementation has stopped. Verify each task against real ' +
    'evidence — run the tests, read the files, check the output — before marking the mission done. ' +
    'If verification fails, set the affected tasks back to failed with mission_update.',
  done:
    'This mission is DONE. Report the final outcome honestly, including anything that failed or ' +
    'was skipped. Start new work only if the user asks.',
  failed:
    'This mission FAILED. Report what was attempted, what broke, and the evidence — do not claim ' +
    'success. Retry only if the user asks.',
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export class MissionState {
  private snap: MissionSnapshot = { active: false, mission: '', phase: 'planning', tasks: [], updatedAt: new Date().toISOString() };
  private readonly listeners = new Set<MissionListener>();

  get active(): boolean {
    return this.snap.active;
  }

  /** `/goal <text>` — begin a mission in the planning phase (the caller enters plan mode). */
  begin(text: string): MissionSnapshot {
    const mission = text.trim();
    this.snap = {
      active: mission.length > 0,
      mission,
      phase: 'planning',
      tasks: [],
      updatedAt: new Date().toISOString(),
    };
    this.emit();
    return this.snapshot();
  }

  /** `/goal clear` — deactivate. History stays in the session log. */
  clear(): MissionSnapshot {
    this.snap = { active: false, mission: '', phase: 'planning', tasks: [], updatedAt: new Date().toISOString() };
    this.emit();
    return this.snapshot();
  }

  /**
   * Plan-exit approval: seed the mission's tasks from plan_write's `tasks` array and move to
   * executing. An approved plan with no tasks is a phase-only mission (still pinned, no list).
   */
  onPlanApproved(input: { title?: string; path?: string; tasks?: string[] }): MissionSnapshot {
    if (!this.snap.active) return this.snapshot();
    const subjects = (input.tasks ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, MISSION_TASK_LIMIT);
    this.snap = {
      ...this.snap,
      phase: 'executing',
      tasks: subjects.map((subject, i) => ({ id: `m-${i + 1}`, subject, status: 'pending' as const })),
      planPath: input.path ?? this.snap.planPath,
      updatedAt: new Date().toISOString(),
    };
    this.emit();
    return this.snapshot();
  }

  /** Apply mission_update task patches. Unknown ids are ignored (never throw). */
  updateTasks(updates: Array<{ id: string; status: MissionTaskStatus; detail?: string }>): MissionSnapshot {
    if (!this.snap.active) return this.snapshot();
    const byId = new Map(updates.map((u) => [u.id, u]));
    this.snap = {
      ...this.snap,
      tasks: this.snap.tasks.map((t) => {
        const u = byId.get(t.id);
        if (!u || !TASK_STATUSES.has(u.status)) return t;
        const next: MissionTask = { ...t, status: u.status };
        if (u.detail !== undefined) next.detail = u.detail;
        else if (u.status !== t.status) delete next.detail; // old evidence belonged to the old status
        return next;
      }),
      updatedAt: new Date().toISOString(),
    };
    this.emit();
    return this.snapshot();
  }

  /** Advance the phase. `planning` is set only by begin() — it cannot be re-entered. */
  setPhase(phase: MissionPhase): MissionSnapshot {
    if (!this.snap.active || phase === 'planning' || this.snap.phase === phase) return this.snapshot();
    this.snap = { ...this.snap, phase, updatedAt: new Date().toISOString() };
    this.emit();
    return this.snapshot();
  }

  /**
   * Rehydrate from a persisted snapshot (session resume). Defensively normalized by the
   * same coerce the log scan uses — a corrupt record restores nothing rather than a
   * half-shape. Inactive snapshots restore the cleared state.
   */
  restore(candidate: MissionSnapshot): MissionSnapshot {
    const snap = coerceSnapshot(candidate);
    if (snap) {
      this.snap = snap;
      this.emit();
    }
    return this.snapshot();
  }

  snapshot(): MissionSnapshot {
    return { ...this.snap, tasks: this.snap.tasks.map((t) => ({ ...t })), planPath: this.snap.planPath };
  }

  /** Register a listener fired on every mutation. Returns an unsubscribe function. */
  onUpdate(fn: MissionListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * The block pinned into the system prompt every turn while a mission is active ('' when
   * inactive — no placeholder noise, TodoList.block() parity).
   */
  block(): string {
    if (!this.snap.active) return '';
    const lines = [
      '',
      '',
      '## Mission',
      `Goal: ${truncate(this.snap.mission, MISSION_TEXT_CHARS)}`,
      `Phase: ${this.snap.phase}`,
    ];
    if (this.snap.planPath) lines.push(`Plan file: ${this.snap.planPath}`);
    if (this.snap.tasks.length > 0) {
      lines.push('Tasks:');
      const shown = this.snap.tasks.slice(0, BLOCK_TASK_LIMIT);
      for (const t of shown) {
        const detail = t.detail ? ` — ${t.detail}` : '';
        lines.push(`${t.id}. [${t.status}] ${t.subject}${detail}`);
      }
      const rest = this.snap.tasks.length - shown.length;
      if (rest > 0) lines.push(`(+${rest} more — keep them moving with mission_update)`);
    } else {
      lines.push('Tasks: none recorded (phase-only mission).');
    }
    lines.push(PHASE_INSTRUCTIONS[this.snap.phase]);
    lines.push(
      'Rules: never call mission_update from a sub-agent (the lead agent manages the mission); ' +
        'the mission is not complete while tasks remain incomplete or the end state is unverified; ' +
        'report outcomes honestly.',
    );
    return lines.join('\n');
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        // a listener must never break a mission transition
      }
    }
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Every {type:'mission'} bus event is already journaled by the bus→recordEvent
// subscriber as `{kind:'event', type:'mission', mission:{...}}`. Resume = tail-scan
// for the LAST such record — no separate write path to drift out of sync.

function coerceSnapshot(raw: unknown): MissionSnapshot | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.active !== true) return null; // inactive records exist only to mark `clear()`
  if (typeof r.mission !== 'string' || r.mission.length === 0) return null;
  if (typeof r.phase !== 'string' || !PHASES.has(r.phase)) return null;
  const tasks = Array.isArray(r.tasks)
    ? r.tasks.filter(
        (t): t is MissionTask =>
          t != null &&
          typeof t === 'object' &&
          typeof (t as MissionTask).id === 'string' &&
          typeof (t as MissionTask).subject === 'string' &&
          typeof (t as MissionTask).status === 'string' &&
          TASK_STATUSES.has((t as MissionTask).status),
      )
    : [];
  const snap: MissionSnapshot = {
    active: true,
    mission: r.mission,
    phase: r.phase as MissionPhase,
    tasks: tasks.map((t) => ({ ...t })),
    updatedAt: new Date().toISOString(),
  };
  if (typeof r.planPath === 'string') snap.planPath = r.planPath;
  if (typeof r.updatedAt === 'string') snap.updatedAt = r.updatedAt;
  return snap;
}

/**
 * The last mission snapshot recorded in a session log, or null. Reads only the tail
 * (64 KiB) so a huge transcript costs the same as a small one; torn/partial lines at
 * the read seam are skipped like any other malformed record.
 */
export function readMissionSnapshot(logPath: string): MissionSnapshot | null {
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return null;
  }
  let text: string;
  try {
    const offset = Math.max(0, size - RESUME_SCAN_BYTES);
    const fd = openSync(logPath, 'r');
    try {
      const len = size - offset;
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, offset);
      text = buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.includes('"mission"')) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn line at the read seam or unrelated record
    }
    if (rec == null || typeof rec !== 'object') continue;
    const r = rec as Record<string, unknown>;
    if (r.type !== 'mission') continue;
    // The newest well-formed mission event is authoritative — including a `clear`
    // (active:false): never fall through to a stale older mission behind it.
    return coerceSnapshot(r.mission);
  }
  return null;
}
