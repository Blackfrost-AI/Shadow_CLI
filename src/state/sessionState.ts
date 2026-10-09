import { MissionState, type MissionSnapshot } from '../agent/mission.js';
import { PlanModeState, type PlanSnapshot } from '../agent/planMode.js';
import { TodoList, type TodoItem } from '../agent/todo.js';
import type { WorkCenter, WorkCenterSnapshot } from '../app/workCenter.js';
import { readLatestWorkCenterSnapshot } from './workCenterPersistence.js';
import { visitControlRecords } from './controlJournal.js';

/** Control state is committed in the same JSONL record as its conversation snapshot. */
export interface SessionStateSnapshot {
  version: 1;
  mission: MissionSnapshot;
  plan: PlanSnapshot;
  todos: TodoItem[];
  workCenter?: WorkCenterSnapshot;
}

export interface SessionStateOwners {
  mission?: MissionState;
  planMode?: PlanModeState;
  todoList?: TodoList;
  workCenter?: WorkCenter;
}

export function captureSessionState(owners: SessionStateOwners): SessionStateSnapshot {
  return {
    version: 1,
    mission: owners.mission?.snapshot() ?? new MissionState().snapshot(),
    plan: owners.planMode?.snapshot() ?? { mode: 'implement' },
    todos: owners.todoList?.snapshot() ?? [],
    ...(owners.workCenter ? { workCenter: owners.workCenter.snapshot() } : {}),
  };
}

/** Validate and copy persisted data using each state's normal restore boundary. */
export function coerceSessionState(value: unknown): SessionStateSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<SessionStateSnapshot>;
  if (raw.version !== 1 || !raw.mission || !raw.plan || !Array.isArray(raw.todos)) return undefined;
  const mission = new MissionState();
  const planMode = new PlanModeState();
  const todoList = new TodoList();
  mission.restore(raw.mission);
  planMode.restore(raw.plan);
  todoList.restore(raw.todos);
  return {
    ...captureSessionState({ mission, planMode, todoList }),
    ...(raw.workCenter?.version === 1 && Array.isArray(raw.workCenter.items) ? { workCenter: raw.workCenter } : {}),
  };
}

/** Restore data only. Workers and side-effecting tools are never restarted here. */
export function restoreSessionState(owners: SessionStateOwners, state: SessionStateSnapshot): void {
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
