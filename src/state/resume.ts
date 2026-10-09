import { SessionLog } from './session.js';
import { hydrateContext, type ContextSnapshotData, type HydrateOptions } from './snapshot.js';
import type { Context } from '../agent/context.js';
import { coerceSessionState, legacySessionState, type SessionStateSnapshot } from './sessionState.js';

export interface ResumableSession {
  path: string;
  id: string;
  ts: string;
  title: string;
}

export interface ResumeMeta {
  sessionId: string;
  sessionPath: string;
  title: string;
  snapshotTs?: string;
  turn?: number;
  subAgentTasks?: any[];
}

function sessionTsFromPath(path: string): string {
  const id = SessionLog.sessionIdFromPath(path);
  // Filenames use ISO stamps with ':' → '-' (e.g. 2025-01-01T12-00-00.000Z).
  return id.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3').replace(/-(\d{3})Z$/, '.$1Z');
}

/** Sessions that contain at least one `context_snapshot` record, newest first. */
export function listResumableSessions(workspaceRoot: string): ResumableSession[] {
  const out: ResumableSession[] = [];
  for (const path of SessionLog.list(workspaceRoot)) {
    // Manifest-backed: one tail scan per file (cached, mtime-invalidated), and no snapshot
    // PAYLOAD is read — just existence + ts. Previously this parsed every log TWICE per file.
    const info = SessionLog.snapshotInfo(path);
    if (!info.hasSnapshot) continue;
    out.push({
      path,
      id: SessionLog.sessionIdFromPath(path),
      ts: info.ts ?? sessionTsFromPath(path),
      title: SessionLog.titleFor(path) || 'Untitled session',
    });
  }
  return out;
}

export type ResumeSessionOpts = HydrateOptions;

export function readSessionState(path: string): SessionStateSnapshot {
  const data = SessionLog.findLatestSnapshotRecord(path)?.data as ContextSnapshotData | undefined;
  return coerceSessionState(data?.sessionState) ?? legacySessionState(path);
}

/** Exact identity wins; duplicate titles remain ambiguous and must be presented to the user. */
export function resolveSessionMatches(sessions: ResumableSession[], query: string): ResumableSession[] {
  const value = query.trim();
  if (!value) return sessions;
  const identity = sessions.filter((session) => session.id === value || session.path === value);
  if (identity.length) return identity;
  const title = sessions.filter((session) => session.title.toLocaleLowerCase() === value.toLocaleLowerCase());
  if (title.length) return title;
  return sessions.filter((session) => session.id.startsWith(value) || session.path.endsWith(value)
    || session.title.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
}

/** Hydrate context from the latest snapshot in a session log. */
export function resumeSession(
  sessionPath: string,
  opts: ResumeSessionOpts,
): { context: Context; meta: ResumeMeta; state: SessionStateSnapshot } {
  // One read of the latest snapshot record — data + metadata together.
  const record = SessionLog.findLatestSnapshotRecord(sessionPath);
  const data = record?.data as ContextSnapshotData | undefined;
  if (!data) throw new Error(`No context snapshot in session: ${sessionPath}`);
  const context = hydrateContext(data, opts);
  return {
    context,
    state: coerceSessionState(data.sessionState) ?? legacySessionState(sessionPath),
    meta: {
      sessionId: SessionLog.sessionIdFromPath(sessionPath),
      sessionPath,
      title: SessionLog.titleFor(sessionPath),
      snapshotTs: record?.ts as string | undefined,
      turn: typeof record?.turn === 'number' ? record.turn : undefined,
      subAgentTasks: (data as any).subAgentTasks,
    },
  };
}
