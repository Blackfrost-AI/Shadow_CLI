import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { redact } from '../util/redact.js';
import type { Context } from '../agent/context.js';
import { serializeContext } from './snapshot.js';

// Append-only JSONL session log. Each run gets its own file under
// <workspaceRoot>/.shadow/sessions/, one JSON object per line: user inputs,
// tool calls, tool results, the final answer — enough to replay what happened.
// Every record is passed through `redact` first, so a leaked secret in a tool
// result never lands on disk. Writes are best-effort: a failed append sets
// `lastError` instead of throwing, so a disk hiccup cannot crash the agent loop.
//
// The redactor is not perfect — a secret it misses still lands in the log — so the
// directory is locked to 0700 and the file to 0600 (private to the owner), and a
// `.shadow/.gitignore` of `*` keeps the whole tree from ever being `git add`ed.

const SHADOW_SUBDIR = '.shadow';
const SESSIONS_SUBDIR = join(SHADOW_SUBDIR, 'sessions');

/**
 * Resolve where session logs live. Default: `<workspaceRoot>/.shadow/sessions/`.
 * `SHADOW_SESSION_DIR` relocates the parent so logs live at `<override>/sessions/` —
 * used by the eval harness to keep the transcript OUT of the graded workspace, so a
 * model's own recursive `grep -r` / `find` can't match the harness's own log. The
 * `inWorkspace` flag tells the caller whether to drop the `.shadow/.gitignore` guard
 * (pointless once the log lives outside the repo).
 */
function resolveSessionsDir(workspaceRoot: string): { dir: string; inWorkspace: boolean } {
  const override = process.env.SHADOW_SESSION_DIR?.trim();
  if (override) return { dir: join(override, 'sessions'), inWorkspace: false };
  return { dir: join(workspaceRoot, SESSIONS_SUBDIR), inWorkspace: true };
}

export class SessionLog {
  /** Set (instead of throwing) if an append ever fails, so the loop survives. */
  public lastError?: string;

  /** Whether the log file has had its 0600 mode forced after the first append. */
  private secured = false;

  private constructor(public readonly path: string) {}

  /**
   * Open a fresh session log. Creates <workspaceRoot>/.shadow/sessions/ (0700) and a
   * new <timestamp>.jsonl file path (timestamp = ISO string with ':' → '-' so
   * it is filesystem-safe). The file itself is created lazily (0600) on first record.
   */
  static open(workspaceRoot: string): SessionLog {
    const { dir, inWorkspace } = resolveSessionsDir(workspaceRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700); // force perms even if umask widened the create mode
    } catch {
      /* best-effort */
    }
    // Belt-and-suspenders against accidental commits: a `.shadow/.gitignore` of `*`
    // so the session logs (which may hold secrets the redactor missed) can't be
    // `git add`ed. Best-effort — never block opening the log on it. Skipped when the
    // log is relocated out of the workspace (SHADOW_SESSION_DIR) — nothing to guard there.
    if (inWorkspace) {
      try {
        writeFileSync(join(workspaceRoot, SHADOW_SUBDIR, '.gitignore'), '*\n', { mode: 0o600 });
      } catch {
        /* best-effort */
      }
    }
    const stamp = new Date().toISOString().replace(/:/g, '-');
    return new SessionLog(join(dir, `${stamp}.jsonl`));
  }

  /** Append one redacted event line. Never throws — records `lastError`. */
  record(event: Record<string, unknown>): void {
    try {
      const line = JSON.stringify(redact({ ts: new Date().toISOString(), ...event }));
      appendFileSync(this.path, line + '\n', { encoding: 'utf8', mode: 0o600 });
      if (!this.secured) {
        try {
          chmodSync(this.path, 0o600); // force 0600 even if umask widened the create mode
        } catch {
          /* best-effort */
        }
        this.secured = true;
      }
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  /** Write a `context_snapshot` record for session resume / rewind. */
  recordSnapshot(ctx: Context, turn?: number): void {
    this.record({ kind: 'context_snapshot', data: serializeContext(ctx), turn });
  }

  /** Session id from a log path — basename without `.jsonl`. */
  static sessionIdFromPath(path: string): string {
    return basename(path).replace(/\.jsonl$/, '');
  }

  /** Latest snapshot payload in a session file, or null. */
  static findLatestSnapshot(path: string): object | null {
    const rec = SessionLog.findLatestSnapshotRecord(path);
    return rec?.data ?? null;
  }

  /** Latest full `context_snapshot` record (data + metadata). */
  static findLatestSnapshotRecord(path: string): Record<string, unknown> | null {
    const events = SessionLog.load(path) as Array<Record<string, unknown>>;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === 'context_snapshot' && e.data) return e;
    }
    return null;
  }

  /** All session file paths under the workspace, newest first. */
  static list(workspaceRoot: string): string[] {
    const dir = resolveSessionsDir(workspaceRoot).dir;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return []; // no sessions dir yet
    }
    return files
      .filter((f) => f.endsWith('.jsonl'))
      .sort((a, b) => b.localeCompare(a)) // ISO timestamps sort lexicographically
      .map((f) => join(dir, f));
  }

  /** Parse a session file into its events. Corrupt/blank lines are skipped. */
  static load(path: string): unknown[] {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const out: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip a corrupt line — best-effort replay
      }
    }
    return out;
  }
}
