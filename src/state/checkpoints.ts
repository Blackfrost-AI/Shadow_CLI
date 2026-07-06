import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../tools/util.js';

const CHECKPOINTS_SUBDIR = join('.shadow', 'checkpoints');
const INDEX_FILE = 'index.json';

export interface CheckpointEntry {
  relPath: string;
  file: string;
  absPath: string;
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
 * Save a pre-mutation file backup. Returns the absolute path to the `.bak` file.
 * Layout: `<workspace>/.shadow/checkpoints/<sessionId>/<turn>/<hash>.bak`
 */
export function saveCheckpoint(
  workspaceRoot: string,
  sessionId: string,
  turn: number,
  relPath: string,
  content: string,
): string {
  const dir = turnDir(workspaceRoot, sessionId, turn);
  mkdirSync(dir, { recursive: true });
  const file = `${hashRelPath(relPath)}.bak`;
  const absPath = join(dir, file);
  writeFileSync(absPath, content, 'utf8');

  const entries = readIndex(dir).filter((e) => e.relPath !== relPath);
  entries.push({ relPath, file, absPath });
  writeIndex(dir, entries);
  return absPath;
}

/** Read checkpoint file content from disk. */
export function restoreCheckpoint(path: string): string {
  return readFileSync(path, 'utf8');
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