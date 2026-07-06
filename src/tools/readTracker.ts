import { statSync } from 'node:fs';

/**
 * Per-run STALE-edit guard. If the model read a file and then it changed on disk
 * underneath it, editing against the now-stale content is refused (read again
 * first). We deliberately do NOT require a prior read for files never seen: the
 * exact-string match in edit_file already guarantees the model knows the content
 * (you can't match text you haven't seen), and forcing an explicit read-first
 * adds friction that weaker models don't reliably recover from. One instance per
 * agent run (threaded through ToolContext), so it never leaks across runs/tests.
 */
export interface ReadTracker {
  /** Record mtime for staleness (read or successful write/edit). */
  markRead(absPath: string): void;
  /** Mark the path as explicitly known to the agent this run (read_file or write_file). */
  markSeen(absPath: string): void;
  /** ok unless the path was seen this run *and* mtime changed on disk. */
  check(absPath: string): { ok: true } | { ok: false; reason: string };
  /** True only if read_file (or write_file creating it) was called for this path this run. */
  hasSeen(absPath: string): boolean;
}

export function createReadTracker(): ReadTracker {
  const mtimes = new Map<string, number>(); // absPath → mtimeMs
  const seenThisRun = new Set<string>(); // files read via read_file or created via write this run
  const getMtime = (p: string): number => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  };
  return {
    markRead: (p) => mtimes.set(p, getMtime(p)),
    markSeen: (p) => {
      seenThisRun.add(p);
      mtimes.set(p, getMtime(p));
    },
    check: (p) => {
      if (mtimes.has(p) && getMtime(p) !== mtimes.get(p)) {
        return {
          ok: false,
          reason: 'the file changed on disk since you last read it — read it again before editing',
        };
      }
      return { ok: true };
    },
    hasSeen: (p) => seenThisRun.has(p),
  };
}
