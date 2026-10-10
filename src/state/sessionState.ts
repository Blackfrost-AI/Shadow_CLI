import { MissionState, type MissionSnapshot } from '../agent/mission.js';
import { PlanModeState, type PlanSnapshot } from '../agent/planMode.js';
import { TodoList, type TodoItem } from '../agent/todo.js';
import type { WorkCenter, WorkCenterSnapshot } from '../app/workCenter.js';
import { readLatestWorkCenterSnapshot } from './workCenterPersistence.js';
import { visitControlRecords } from './controlJournal.js';

/** Control state is committed in the same JSONL record as its conversation snapshot. */
export interface SessionStateSnapshot {
  /**
   * v1 predates harness snapshots. v2 is emitted only when the immutable harness identity is
   * present, and readers must reject a v2 record whose harness was removed or malformed.
   */
  version: 1 | 2;
  mission: MissionSnapshot;
  plan: PlanSnapshot;
  todos: TodoItem[];
  workCenter?: WorkCenterSnapshot;
  /** Immutable harness composition used to build this session's prompt and capability view. */
  harness?: SessionHarnessSnapshot;
}

export interface SessionHarnessPackageSnapshot {
  id: string;
  version: string;
  digest: string;
}

export interface SessionHarnessSnapshot {
  foundation: SessionHarnessPackageSnapshot;
  addons: SessionHarnessPackageSnapshot[];
  digest: string;
}

export type InProcessResumeHarnessIssue =
  | 'active-harness-unknown'
  | 'legacy-session-with-active-addons'
  | 'harness-mismatch';

function sameHarnessPackage(
  left: SessionHarnessPackageSnapshot,
  right: SessionHarnessPackageSnapshot,
): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

/**
 * Decide whether an already-running process may safely adopt a saved conversation.
 *
 * Prompt text, tools and harness skills are frozen when the process starts. A saved context may
 * therefore cross the in-process `/resume` boundary only when its complete harness identity is
 * exactly the one already loaded. Legacy sessions predate harness snapshots; startup deliberately
 * treats them as Security-foundation-only, so that is the sole active stack they may enter.
 */
export function inProcessResumeHarnessIssue(
  active: SessionHarnessSnapshot | undefined,
  saved: SessionHarnessSnapshot | undefined,
): InProcessResumeHarnessIssue | undefined {
  // Preserve standalone/legacy clients that know nothing about harness snapshots. Production
  // renderers always supply `active`, but old fixtures and embedders may omit both sides.
  if (!active && !saved) return undefined;
  if (!active) return 'active-harness-unknown';
  if (!saved) {
    return active.addons.length === 0 && active.foundation.id === 'shadow-security'
      ? undefined
      : 'legacy-session-with-active-addons';
  }
  if (active.digest !== saved.digest || !sameHarnessPackage(active.foundation, saved.foundation)) {
    return 'harness-mismatch';
  }
  if (active.addons.length !== saved.addons.length) return 'harness-mismatch';
  for (let index = 0; index < active.addons.length; index++) {
    if (!sameHarnessPackage(active.addons[index]!, saved.addons[index]!)) return 'harness-mismatch';
  }
  return undefined;
}

/** User-facing refusal for an unsafe in-process resume, including the safe restart path. */
export function inProcessResumeHarnessMessage(
  active: SessionHarnessSnapshot | undefined,
  saved: SessionHarnessSnapshot | undefined,
  sessionId: string,
): string | undefined {
  const issue = inProcessResumeHarnessIssue(active, saved);
  if (!issue) return undefined;
  const reason = issue === 'legacy-session-with-active-addons'
    ? 'the saved session predates harness snapshots while this process already has add-ons loaded'
    : issue === 'active-harness-unknown'
      ? 'this process cannot verify the immutable harness it loaded'
      : 'the saved session uses a different harness stack from this process';
  return (
    `Cannot resume in this process because ${reason}. ` +
    `Exit Shadow, then run \`shadow resume ${sessionId}\`. ` +
    'A new process will load the session harness before building its prompt, tools, and skills; ' +
    'if a recorded add-on changed or is missing, restore its exact version and digest first.'
  );
}

export interface SessionStateOwners {
  mission?: MissionState;
  planMode?: PlanModeState;
  todoList?: TodoList;
  workCenter?: WorkCenter;
  harness?: SessionHarnessSnapshot;
}

export function captureSessionState(owners: SessionStateOwners): SessionStateSnapshot {
  return {
    version: owners.harness ? 2 : 1,
    mission: owners.mission?.snapshot() ?? new MissionState().snapshot(),
    plan: owners.planMode?.snapshot() ?? { mode: 'implement' },
    todos: owners.todoList?.snapshot() ?? [],
    ...(owners.workCenter ? { workCenter: owners.workCenter.snapshot() } : {}),
    ...(owners.harness ? { harness: structuredClone(owners.harness) } : {}),
  };
}

export function coerceSessionHarness(value: unknown): SessionHarnessSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<SessionHarnessSnapshot>;
  const validPackage = (item: unknown): item is SessionHarnessPackageSnapshot => {
    if (!item || typeof item !== 'object') return false;
    const p = item as Partial<SessionHarnessPackageSnapshot>;
    return typeof p.id === 'string' && p.id.trim().length > 0
      && typeof p.version === 'string' && p.version.trim().length > 0
      && typeof p.digest === 'string' && p.digest.trim().length > 0;
  };
  if (!validPackage(raw.foundation) || !Array.isArray(raw.addons) || !raw.addons.every(validPackage)
      || typeof raw.digest !== 'string' || raw.digest.trim().length === 0) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const addon of raw.addons) {
    if (ids.has(addon.id)) return undefined;
    ids.add(addon.id);
  }
  return {
    foundation: { ...raw.foundation },
    addons: raw.addons.map((addon) => ({ ...addon })),
    digest: raw.digest,
  };
}

/** Validate and copy persisted data using each state's normal restore boundary. */
export function coerceSessionState(value: unknown): SessionStateSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<SessionStateSnapshot>;
  if ((raw.version !== 1 && raw.version !== 2) || !raw.mission || !raw.plan || !Array.isArray(raw.todos)) return undefined;
  const harness = coerceSessionHarness(raw.harness);
  // v2 is the fail-closed harness era. Never turn a damaged v2 record into a legacy v1 state.
  if (raw.version === 2 && !harness) return undefined;
  const mission = new MissionState();
  const planMode = new PlanModeState();
  const todoList = new TodoList();
  mission.restore(raw.mission);
  planMode.restore(raw.plan);
  todoList.restore(raw.todos);
  return {
    ...captureSessionState({ mission, planMode, todoList }),
    version: raw.version,
    ...(raw.workCenter?.version === 1 && Array.isArray(raw.workCenter.items) ? { workCenter: raw.workCenter } : {}),
    // A v1 harness field was never bound outside the workspace journal. Ignore one if present:
    // genuine pre-harness logs remain foundation-only, and adding a field cannot activate code.
    ...(raw.version === 2 && harness ? { harness } : {}),
  };
}

/** Restore data only. Workers and side-effecting tools are never restarted here. */
export function restoreSessionState(owners: SessionStateOwners, state: SessionStateSnapshot): void {
  // Capability checks are a transaction preflight. Without it, restoring mission first and then
  // discovering that plan mode lacks an exit control would leave the current session half-adopted.
  owners.mission?.assertRestorable(state.mission);
  owners.planMode?.assertRestorable(state.plan);
  owners.mission?.restore(state.mission);
  owners.planMode?.restore(state.plan);
  owners.todoList?.restore(state.todos);
  owners.workCenter?.restore(state.workCenter ?? null);
  owners.workCenter?.syncTodos(state.todos);
}

/** Legacy logs lack a coherent bundle. Retain available history without carrying another session's state. */
export function legacySessionState(path: string): SessionStateSnapshot {
  const mission = new MissionState();
  const planMode = new PlanModeState();
  const todoList = new TodoList();
  visitControlRecords(path, ['event'], (event) => {
    if (event.type === 'mission' && event.mission && typeof event.mission === 'object') mission.restore(event.mission as MissionSnapshot);
    if (event.type === 'plan_mode' && event.plan && typeof event.plan === 'object') planMode.restore(event.plan as PlanSnapshot);
    if (event.type === 'todo' && Array.isArray(event.items)) todoList.restore(event.items as TodoItem[]);
  });
  return {
    ...captureSessionState({ mission, planMode, todoList }),
    workCenter: readLatestWorkCenterSnapshot(path) ?? undefined,
  };
}

/**
 * Legacy-state recovery from the same immutable bytes authenticated by its owner-side receipt.
 * This is deliberately separate from the path reader above: reopening the workspace file after
 * digest verification would let a concurrent rename/swap inject unauthenticated control state.
 */
export function legacySessionStateFromBytes(bytes: Buffer): SessionStateSnapshot {
  const mission = new MissionState();
  const planMode = new PlanModeState();
  const todoList = new TodoList();
  let workCenter: WorkCenterSnapshot | undefined;
  let start = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index < bytes.length && bytes[index] !== 0x0a) continue;
    const line = bytes.subarray(start, index);
    start = index + 1;
    if (line.length === 0 || line.length > 16 * 1024 * 1024) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.kind === 'event') {
      if (record.type === 'mission' && record.mission && typeof record.mission === 'object') {
        mission.restore(record.mission as MissionSnapshot);
      }
      if (record.type === 'plan_mode' && record.plan && typeof record.plan === 'object') {
        planMode.restore(record.plan as PlanSnapshot);
      }
      if (record.type === 'todo' && Array.isArray(record.items)) {
        todoList.restore(record.items as TodoItem[]);
      }
    }
    const candidate = record.kind === 'work_center_snapshot' ? record.data : undefined;
    if (candidate && typeof candidate === 'object') {
      const snapshot = candidate as WorkCenterSnapshot;
      if (snapshot.version === 1 && Array.isArray(snapshot.items)) workCenter = snapshot;
    }
  }
  return {
    ...captureSessionState({ mission, planMode, todoList }),
    ...(workCenter ? { workCenter } : {}),
  };
}
