import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { SessionLog } from './session.js';

const CHECKPOINTS_SUBDIR = join('.shadow', 'checkpoints');
const INDEX_FILE = 'index.json';

/**
 * P2-11 (F09-10) — fork the CURRENT session: byte-copy the source transcript into a fresh
 * session id and hand back a live SessionLog bound to the copy. The source file is never
 * touched again — append-only lineage becomes copy-on-write lineage, so /resume and /export
 * on the source keep showing exactly what happened before the fork.
 *
 * Mechanics:
 *  - The fork lands NEXT TO the source (dirname of the source path), so a relocated session
 *    store (SHADOW_SESSION_DIR) keeps forks with their originals. A same-stamp collision
 *    (fork twice within one millisecond) appends a `-N` suffix rather than overwriting.
 *  - A `forked_from` marker is appended to the FORK only (never the source) so listing /
 *    /export can show lineage.
 *  - NO fresh context_snapshot is seeded: the source's copied snapshots already ARE the fork's
 *    /rewind history for pre-fork turns, and seeding another would duplicate a transcript-sized
 *    payload for zero information.
 *  - Checkpoint lineage: workspace file checkpoints are keyed by session id
 *    (`.shadow/checkpoints/<id>/<turn>/…`), so a fork would otherwise lose every PRE-fork turn's
 *    backups and a `/rewind` past the fork point would rewind the conversation but leave the
 *    working tree silently untouched. When `workspaceRoot` is given, the source's checkpoint tree
 *    is copied under the fork's id (best-effort; never blocks the fork) and each per-turn
 *    `index.json` is re-pointed at the fork's own `.bak` files so the fork's lineage is
 *    self-contained and does not depend on the source surviving.
 *
 * Safety: the caller must fork BETWEEN turns (the TUI guards on runningRef) — a copy racing a
 * live writer could land mid-line. On any transcript failure the partial copy is removed and the
 * error re-thrown; the source instance is left exactly as it was.
 */
export function forkSession(
  source: SessionLog,
  workspaceRoot?: string,
): {
  log: SessionLog;
  path: string;
  sourceId: string;
  forkId: string;
} {
  const dir = dirname(source.path);
  const stamp = new Date().toISOString().replace(/:/g, '-');
  let path = join(dir, `${stamp}.jsonl`);
  for (let n = 1; existsSync(path); n++) path = join(dir, `${stamp}-${n}.jsonl`);

  const sourceId = SessionLog.sessionIdFromPath(source.path);
  try {
    if (existsSync(source.path)) {
      copyFileSync(source.path, path);
      // The main turn is guarded (the TUI checks runningRef), but a BACKGROUND sub-agent can
      // still be appending to the source while we copy. SessionLog appends are a single
      // writeSync per line, so a concurrent append can at worst leave the copy with a TORN
      // final line (the copy observed a size mid-write). Truncate to the last complete line so
      // the fork never ends mid-record — the fragment is re-written by the live appender's next
      // record. A clean copy always ends in '\n', so this is a no-op in the normal case.
      repairTornTail(path);
    } else {
      // Defensive: a SessionLog whose backing file does not exist (open() now claims eagerly,
      // but a hand-built/openExisting instance might not have one) forks to an empty log.
      writeFileSync(path, '', { mode: 0o600 });
    }
    chmodSync(path, 0o600); // force 0600 even if umask widened the copy's mode
    const log = SessionLog.openExisting(path);
    log.record({ kind: 'forked_from', sessionId: sourceId, path: source.path });
    const forkId = SessionLog.sessionIdFromPath(path);
    if (workspaceRoot) copyCheckpoints(workspaceRoot, sourceId, forkId);
    return { log, path, sourceId, forkId };
  } catch (e) {
    try {
      unlinkSync(path); // never leave a partial / half-copied session file behind
    } catch {
      /* best-effort */
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * If the copied transcript does not end on a line boundary (a torn final line from racing a
 * concurrent appender), truncate it to the last complete line. Best-effort: any IO error is
 * ignored and the copy is used as-is (openExisting still seeds bytesWritten from the real size).
 */
function repairTornTail(path: string): void {
  try {
    const buf = readFileSync(path);
    if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return; // clean
    const lastNl = buf.lastIndexOf(0x0a);
    truncateSync(path, lastNl < 0 ? 0 : lastNl + 1);
  } catch {
    /* best-effort */
  }
}

/**
 * Best-effort copy of the source session's workspace checkpoints under the fork's id, so /rewind
 * in the fork can restore files for pre-fork turns. Failure here is silent and non-fatal — a fork
 * without checkpoint lineage still forks the transcript correctly (the /resume path behaves the
 * same way). Each per-turn index.json is rewritten so its `absPath` entries point at the fork's
 * own `.bak` copies instead of the source's.
 */
function copyCheckpoints(workspaceRoot: string, sourceId: string, forkId: string): void {
  try {
    const srcRoot = join(workspaceRoot, CHECKPOINTS_SUBDIR, sourceId);
    const dstRoot = join(workspaceRoot, CHECKPOINTS_SUBDIR, forkId);
    if (!existsSync(srcRoot)) return; // nothing to carry over
    if (existsSync(dstRoot)) return; // never clobber an existing tree
    cpSync(srcRoot, dstRoot, { recursive: true });
    // Re-point the copied index.json files at the fork's own .bak paths. Entries for absent
    // files (file: '', absent: true) have no .bak and are left untouched.
    for (const turn of readdirSync(dstRoot)) {
      const index = join(dstRoot, turn, INDEX_FILE);
      if (!existsSync(index)) continue;
      try {
        const entries = JSON.parse(readFileSync(index, 'utf8')) as Array<{
          file?: string;
          absPath?: string;
          absent?: boolean;
        }>;
        if (!Array.isArray(entries)) continue;
        for (const e of entries) {
          if (e.absent || !e.file) continue;
          e.absPath = join(dstRoot, turn, e.file);
        }
        writeFileSync(index, JSON.stringify(entries, null, 2) + '\n');
      } catch {
        /* a malformed per-turn index must not fail the fork */
      }
    }
  } catch {
    /* best-effort */
  }
}
