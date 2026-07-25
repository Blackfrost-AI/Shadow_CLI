import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { atomicWrite } from '../tools/util.js';
import { listCheckpointsForTurn, listCheckpointTurns, restoreCheckpoint } from './checkpoints.js';
import { hydrateContext, type ContextSnapshotData, type HydrateOptions } from './snapshot.js';
import { SessionLog } from './session.js';
import type { Context } from '../agent/context.js';

export interface RewindResult {
  context: Context;
  restoredFiles: string[];
  /** Files created after the target turn and removed by the rewind. */
  deletedFiles: string[];
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
  const deletedFiles: string[] = [];

  // Restore EVERY turn from the target onward, newest first so the OLDEST backup lands last and
  // wins. Restoring only the picked turn left every later turn's edits on disk while reporting
  // "Restored N file(s)" — the conversation went back but the working tree did not, which is a
  // worse state than not rewinding at all because the two now disagree silently.
  const turns = listCheckpointTurns(workspaceRoot, sessionId).filter((t) => t >= turn);
  const seen = new Set<string>();
  for (const t of [...turns].sort((a, b) => b - a)) {
    for (const entry of listCheckpointsForTurn(workspaceRoot, sessionId, t)) {
      const dest = resolve(workspaceRoot, entry.relPath);
      if (entry.absent) {
        // The file did not exist before that turn — rewinding past it means removing it again.
        if (existsSync(dest)) {
          rmSync(dest, { force: true });
          if (!seen.has(entry.relPath)) deletedFiles.push(entry.relPath);
        }
        seen.add(entry.relPath);
        continue;
      }
      if (!existsSync(entry.absPath)) continue;
      atomicWrite(dest, restoreCheckpoint(entry.absPath));
      if (!seen.has(entry.relPath)) restoredFiles.push(entry.relPath);
      seen.add(entry.relPath);
    }
  }

  const context = hydrateContext(pick.data, opts);
  return { context, restoredFiles, deletedFiles, turn };
}