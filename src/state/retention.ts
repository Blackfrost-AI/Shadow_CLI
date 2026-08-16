// Session log retention (P2-13) — OPT-IN, and ARCHIVE OVER DELETE, always.
//
// Session logs accumulate under <workspaceRoot>/.shadow/sessions/ forever by default. When the
// user opts in via the GLOBAL-ONLY config keys `sessionRetentionDays` and/or
// `sessionRetentionKeep` (both PROJECT_UNTRUSTED_KEYS — a cloned repo must not be able to sweep
// history), stale logs are swept at session start. The sweep NEVER deletes: it MOVES each log
// (plus its checkpoint tree, which is meaningless without its log) into sessions/.archive/ —
// still 0600/0700, still on disk. A /rewind can only use checkpoints alongside the log they were
// captured for, so the tree is archived as `checkpoints-<id>` beside the log; restoring a session
// means moving the log AND its paired tree back together.
//
// Rules:
//   sessionRetentionDays: N  — archive logs whose mtime is older than N days.
//   sessionRetentionKeep: M  — ALWAYS protect the newest M sessions from any rule; set ALONE
//                              (no days), archive everything beyond the newest M.
// Both set: archive logs older than N days, but never one of the newest M.
// Neither set (the default): retention is OFF — nothing is ever touched.
//
// Two more invariants, independent of the rules:
//   - a log written to within the last LIVE_FRESH_MS is never touched — it may belong to a
//     session still running (two sessions can share one workspace: TUI + web, two terminals),
//     and a sweep must not move a live session's log out from under its writer;
//   - explicit resume targets are excluded by the caller (bootstrap passes the --resume id),
//     so hydration never reads a file the sweep just moved.
// The sweep also runs BEFORE the new session's own log is opened, so it can never archive the
// very session that is starting (even with sessionRetentionKeep: 0).
//
// `planRetention` is pure (dry-run — what WOULD be archived) and is what `/doctor` surfaces
// BEFORE any pruning happens; `applyRetention` performs the move and reports what it did so the
// caller can print a one-line notice.

import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SessionLog } from './session.js';

/** The retention-relevant config keys (a subset of ShadowConfig, kept loose to avoid an
 *  import cycle with config.ts). */
export interface RetentionConfig {
  sessionRetentionDays?: number;
  sessionRetentionKeep?: number;
}

/** One log the current config would archive (dry-run row). */
export interface RetentionCandidate {
  path: string;
  id: string;
  mtimeMs: number;
  size: number;
  /** Which rule matched: `age` (older than sessionRetentionDays) or `count` (beyond the
   *  newest sessionRetentionKeep, when no days rule is set). */
  reason: 'age' | 'count';
}

export const ARCHIVE_DIRNAME = '.archive';

/** Logs written to within this window may belong to a session still RUNNING (two sessions can
 *  share one workspace — TUI + web, or two terminals). A sweep never moves a live session's
 *  log out from under its writer; it simply leaves it for the next sweep.
 *
 *  The window is deliberately WIDER than a minute: a session's write gaps can exceed 60s
 *  (shell tools run up to `shellTimeoutMs` — default 60s — and streaming/tool-heavy stretches
 *  write no snapshot-bearing lines at all), so a 60s guard would misclassify a live session as
 *  stale. 5 minutes is the heuristic; it is documented honestly because it cannot be perfect
 *  without a lockfile. Even when it misfires, nothing is lost: the writer holds its fd open and
 *  a POSIX rename re-points the path — the live session keeps appending into the archived file,
 *  and recovery is a move-back. */
const LIVE_FRESH_MS = 5 * 60_000;

/** Sweep options (both are protections, never relaxations). */
export interface RetentionSweepOpts {
  /** Session ids that must never be archived this sweep (e.g. the explicit --resume target). */
  excludeIds?: string[];
}

/** The session id is the log filename minus `.jsonl`, and it is joined DIRECTLY into the
 *  checkpoint-tree path — so a log planted as `.jsonl` (id `''`) or `...jsonl` (id `'..'`)
 *  would make join() walk OUT of the checkpoints dir (the root, or the whole `.shadow` tree).
 *  Accept only conservative filename shapes before touching any path built from an id. */
function safeSessionId(id: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(id);
}

/**
 * Pure dry-run: the sessions the current retention config WOULD archive, newest first. No
 * filesystem mutation — safe to run from `/doctor` at any time. Returns [] when retention is
 * not configured (the default), which means "never touch anything".
 */
export function planRetention(
  workspaceRoot: string,
  cfg: RetentionConfig,
  opts: RetentionSweepOpts = {},
): RetentionCandidate[] {
  const { sessionRetentionDays: days, sessionRetentionKeep: keep } = cfg;
  if (days == null && keep == null) return []; // retention OFF unless explicitly opted in

  const paths = SessionLog.list(workspaceRoot); // newest first (ISO stamps sort lexicographically)
  const now = Date.now();
  const out: RetentionCandidate[] = [];
  paths.forEach((path, idx) => {
    if (keep != null && idx < keep) return; // the newest M are ALWAYS protected
    const id = SessionLog.sessionIdFromPath(path);
    if (opts.excludeIds && opts.excludeIds.includes(id)) return; // e.g. the --resume target
    let st: { mtimeMs: number; size: number };
    try {
      const s = statSync(path);
      st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return; // a log that cannot be stat'd is left alone
    }
    if (now - st.mtimeMs < LIVE_FRESH_MS) return; // possibly a live concurrent session
    const aged = days != null && now - st.mtimeMs > days * 86_400_000;
    // days rule set → only AGE matches (keep just protects); days absent → the keep rule alone
    // archives everything beyond the newest M.
    const reason: RetentionCandidate['reason'] | null = aged ? 'age' : days == null ? 'count' : null;
    if (reason) out.push({ path, id, ...st, reason });
  });
  return out;
}

export interface RetentionResult {
  archived: Array<{ id: string; from: string; to: string }>;
  archiveDir: string;
}

/**
 * Archive the planned sessions under <sessionsDir>/.archive/ — a MOVE, never a delete. Also
 * relocates each session's checkpoint tree (which a /rewind can only use alongside its log).
 * Cross-device renames (SHADOW_SESSION_DIR on another volume) leave the checkpoint tree in
 * place rather than failing the log's archive. Every failure is per-entry and non-fatal: a
 * locked or half-written log simply stays put and the next sweep retries it.
 */
export function applyRetention(
  workspaceRoot: string,
  cfg: RetentionConfig,
  opts: RetentionSweepOpts = {},
): RetentionResult {
  const plan = planRetention(workspaceRoot, cfg, opts);
  const archiveDir = join(SessionLog.sessionsDir(workspaceRoot), ARCHIVE_DIRNAME);
  const result: RetentionResult = { archived: [], archiveDir };
  if (!plan.length) return result;

  try {
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  } catch {
    return result; // cannot create the archive dir → archive nothing this sweep
  }
  // lstat, never stat: if `.archive` ALREADY EXISTED as a SYMLINK, mkdirSync succeeded (the
  // path exists) and the next chmodSync would FOLLOW the link — and every renameSync below
  // would deposit logs wherever the link points. Only a REAL directory may be the archive.
  let st: { isDirectory(): boolean };
  try {
    st = lstatSync(archiveDir);
  } catch {
    return result;
  }
  if (!st.isDirectory()) return result; // symlink/file squatting on the path → refuse, archive nothing
  try {
    chmodSync(archiveDir, 0o700);
  } catch {
    /* best-effort */
  }

  for (const c of plan) {
    let to = join(archiveDir, basename(c.path));
    if (existsSync(to)) {
      // Same-stamp collision: NEVER overwrite an existing archive entry.
      let n = 1;
      while (existsSync((to = join(archiveDir, `${c.id}-${n}.jsonl`)))) n++;
    }
    try {
      renameSync(c.path, to);
    } catch {
      continue; // locked/half-written — leave it for the next sweep
    }
    result.archived.push({ id: c.id, from: c.path, to });

    // The id is joined into paths — validate it first (`.jsonl`/`...jsonl` would otherwise
    // resolve the checkpoints ROOT or the entire `.shadow` tree). The log's own archive move is
    // basename-based and safe either way, so an invalid id only forfeits the checkpoint move.
    if (!safeSessionId(c.id)) continue;
    const cpDir = join(workspaceRoot, '.shadow', 'checkpoints', c.id);
    if (existsSync(cpDir)) {
      const cpTo = join(archiveDir, `checkpoints-${c.id}`);
      if (!existsSync(cpTo)) {
        try {
          renameSync(cpDir, cpTo);
        } catch {
          /* cross-device or busy — the log is archived; the checkpoints stay put */
        }
      }
    }
  }
  return result;
}

/** Human-readable byte size for retention reporting. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
