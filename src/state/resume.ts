import { SessionLog } from './session.js';
import { hydrateContext, type ContextSnapshotData, type HydrateOptions } from './snapshot.js';
import type { Context } from '../agent/context.js';

export interface ResumableSession {
  path: string;
  id: string;
  ts: string;
}

export interface ResumeMeta {
  sessionId: string;
  sessionPath: string;
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
    });
  }
  return out;
}

export type ResumeSessionOpts = HydrateOptions;

/** Hydrate context from the latest snapshot in a session log. */
export function resumeSession(
  sessionPath: string,
  opts: ResumeSessionOpts,
): { context: Context; meta: ResumeMeta } {
  // One read of the latest snapshot record — data + metadata together.
  const record = SessionLog.findLatestSnapshotRecord(sessionPath);
  const data = record?.data as ContextSnapshotData | undefined;
  if (!data) throw new Error(`No context snapshot in session: ${sessionPath}`);
  const context = hydrateContext(data, opts);
  return {
    context,
    meta: {
      sessionId: SessionLog.sessionIdFromPath(sessionPath),
      sessionPath,
      snapshotTs: record?.ts as string | undefined,
      turn: typeof record?.turn === 'number' ? record.turn : undefined,
      subAgentTasks: (data as any).subAgentTasks,
    },
  };
}