import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, isAbsolute, relative, resolve } from 'node:path';
import { atomicWrite } from '../tools/util.js';

const CHECKPOINTS_SUBDIR = join('.shadow', 'checkpoints');
const INDEX_FILE = 'index.json';

export interface CheckpointEntry {
  relPath: string;
  file: string;
  absPath: string;
  /** The file did not exist before this turn — rewinding past it means DELETING it. */
  absent?: boolean;
}

function turnDir(workspaceRoot: string, sessionId: string, turn: number): string {
  return join(workspaceRoot, CHECKPOINTS_SUBDIR, sessionId, String(turn));
}

function hashRelPath(relPath: string): string {
  return createHash('sha256').update(relPath).digest('hex').slice(0, 8);
}

function readIndex(dir: string): CheckpointEntry[] {
  const path = join(dir, INDEX_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CheckpointEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(dir: string, entries: CheckpointEntry[]): void {
  atomicWrite(join(dir, INDEX_FILE), JSON.stringify(entries, null, 2) + '\n');
}

/**
 * Normalize a caller-supplied path to a workspace-relative key.
 *
 * Callers pass the MODEL's raw `input.path`, which may be `src/a.ts` on one call and
 * `/abs/ws/src/a.ts` on the next. Those hashed to two different entries for the same file, and
 * rewind then applied both in arbitrary order — restoring a state that never existed.
 */
function checkpointKey(workspaceRoot: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p);
  const rel = relative(resolve(workspaceRoot), abs);
  return rel === '' ? '.' : rel;
}

/**
 * Save a pre-mutation file backup. Returns the absolute path to the `.bak` file.
 * Layout: `<workspace>/.shadow/checkpoints/<sessionId>/<turn>/<hash>.bak`
 *
 * FIRST WRITE WINS per (turn, file). A turn that edits the same file twice used to overwrite its
 * own backup with the post-first-edit content, so rewinding restored a state that never existed
 * on disk. The whole point of the checkpoint is the state BEFORE the turn touched the file, so a
 * later write in the same turn must not replace it.
 */
export function saveCheckpoint(
  workspaceRoot: string,
  sessionId: string,
  turn: number,
  relPath: string,
  content: string,
): string {
  const key = checkpointKey(workspaceRoot, relPath);
  const dir = turnDir(workspaceRoot, sessionId, turn);
  mkdirSync(dir, { recursive: true });
  const file = `${hashRelPath(key)}.bak`;
  const absPath = join(dir, file);

  const entries = readIndex(dir);
  const existing = entries.find((e) => e.relPath === key);
  if (existing && existsSync(existing.absPath)) return existing.absPath; // first write wins

  writeFileSync(absPath, content, 'utf8');
  if (!existing) {
    entries.push({ relPath: key, file, absPath });
    writeIndex(dir, entries);
  }
  return absPath;
}

/** Record that a file did NOT exist before this turn, so rewind can delete it again. */
export function saveCheckpointAbsent(
  workspaceRoot: string,
  sessionId: string,
  turn: number,
  relPath: string,
): void {
  const key = checkpointKey(workspaceRoot, relPath);
  const dir = turnDir(workspaceRoot, sessionId, turn);
  mkdirSync(dir, { recursive: true });
  const entries = readIndex(dir);
  if (entries.some((e) => e.relPath === key)) return; // first write wins
  entries.push({ relPath: key, file: '', absPath: '', absent: true });
  writeIndex(dir, entries);
}

/** Read checkpoint file content from disk. */
export function restoreCheckpoint(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Every turn index that has a checkpoint directory, ascending. */
export function listCheckpointTurns(workspaceRoot: string, sessionId: string): number[] {
  const root = join(workspaceRoot, CHECKPOINTS_SUBDIR, sessionId);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((d) => Number(d))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
}

/** List checkpoints recorded for a session turn. */
export function listCheckpointsForTurn(
  workspaceRoot: string,
  sessionId: string,
  turn: number,
): CheckpointEntry[] {
  const dir = turnDir(workspaceRoot, sessionId, turn);
  if (!existsSync(dir)) return [];
  const indexed = readIndex(dir);
  if (indexed.length) return indexed;
  // Fallback: scan `.bak` files when no index exists (legacy / partial writes).
  return readdirSync(dir)
    .filter((f) => f.endsWith('.bak'))
    .map((file) => ({ relPath: file, file, absPath: join(dir, file) }));
}