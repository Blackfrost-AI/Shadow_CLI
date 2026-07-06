import { resolve } from 'node:path';
import { atomicWrite } from '../tools/util.js';
import { listCheckpointsForTurn, restoreCheckpoint } from './checkpoints.js';
import { hydrateContext, type ContextSnapshotData, type HydrateOptions } from './snapshot.js';
import { SessionLog } from './session.js';
import type { Context } from '../agent/context.js';

export interface RewindResult {
  context: Context;
  restoredFiles: string[];
  turn: number;
}

interface SnapshotRecord {
  turn?: number;
  ts?: string;
  data: ContextSnapshotData;
}

function loadSnapshots(sessionPath: string): SnapshotRecord[] {
  const events = SessionLog.load(sessionPath) as Array<Record<string, unknown>>;
  const out: SnapshotRecord[] = [];
  for (const e of events) {
    if (e.kind !== 'context_snapshot' || !e.data) continue;
    out.push({
      turn: typeof e.turn === 'number' ? e.turn : out.length,
      ts: typeof e.ts === 'string' ? e.ts : undefined,
      data: e.data as ContextSnapshotData,
    });
  }
  return out;
}

/**
 * Rewind conversation (and workspace files) to the snapshot at `turnIndex`.
 * Turn 0 is the first completed assistant turn; higher indices are later turns.
 */
export function rewindToTurn(
  sessionPath: string,
  turnIndex: number,
  workspaceRoot: string,
  opts: HydrateOptions,
): RewindResult {
  if (turnIndex < 0) throw new Error('turnIndex must be >= 0');
  const snaps = loadSnapshots(sessionPath);
  if (!snaps.length) throw new Error(`No snapshots in session: ${sessionPath}`);

  let pick = snaps[0]!;
  for (const s of snaps) {
    const t = s.turn ?? 0;
    if (t <= turnIndex) pick = s;
    else break;
  }

  const sessionId = SessionLog.sessionIdFromPath(sessionPath);
  const turn = pick.turn ?? 0;
  const restoredFiles: string[] = [];

  for (const entry of listCheckpointsForTurn(workspaceRoot, sessionId, turn)) {
    const content = restoreCheckpoint(entry.absPath);
    const dest = resolve(workspaceRoot, entry.relPath);
    atomicWrite(dest, content);
    restoredFiles.push(entry.relPath);
  }

  const context = hydrateContext(pick.data, opts);
  return { context, restoredFiles, turn };
}