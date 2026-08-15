import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { redact } from '../util/redact.js';
import type { Context } from '../agent/context.js';
import { serializeContext } from './snapshot.js';

// Append-only JSONL session log. Each run gets its own file under
// <workspaceRoot>/.shadow/sessions/, one JSON object per line: user inputs,
// tool calls, tool results, the final answer — enough to replay what happened.
// Every record is passed through `redact` first, so a leaked secret in a tool
// result never lands on disk. Writes are best-effort: a failed write sets
// `lastError` instead of throwing, so a disk hiccup cannot crash the agent loop.
//
// The redactor is not perfect — a secret it misses still lands in the log — so the
// directory is locked to 0700 and the file to 0600 (private to the owner), and a
// `.shadow/.gitignore` of `*` keeps the whole tree from ever being `git add`ed.
//
// Performance (P1B-06 / P1B-07): the write path holds ONE persistent append fd and
// `writeSync`s each line to it, instead of `appendFileSync` re-opening+closing the file
// on every record. Per-token stream deltas (`text`/`thinking`/`shell_output`) are NOT
// recorded at all — the committed `assistant_done`/`reasoning_done` events carry the same
// text and are all any disk consumer (resume, rewind, `/export`) needs. Snapshot lookups
// scan the file TAIL backwards instead of parsing the whole (tens-of-MB) log, and a
// per-session manifest (id/ts/turn-count/latest-snapshot-offset), invalidated by mtime+size,
// keeps listing and `countSnapshots` from re-reading the log on every call.

const SHADOW_SUBDIR = '.shadow';
const SESSIONS_SUBDIR = join(SHADOW_SUBDIR, 'sessions');

/** Bus event types whose per-token records are NOT persisted (reconstructed from the
 *  committed `assistant_done`/`reasoning_done` events, which are). Dropping these turns a
 *  100-delta turn from ~100 synchronous writes into O(1) — the single committed record. */
const SKIP_EVENT_TYPES = new Set(['text', 'thinking', 'shell_output']);

/** Chunk size for the backward tail scan (and the forward single-line read). */
const TAIL_CHUNK = 64 * 1024;
/** Fast-reject marker: the `kind` value only a snapshot line carries. */
const SNAPSHOT_MARKER = Buffer.from('"context_snapshot"');
const NL = 0x0a; // '\n'

/**
 * Per-session manifest, cached in-process and invalidated when the file's mtime OR size
 * changes. Lets `listResumableSessions` / `countSnapshots` answer without re-reading the log.
 */
interface SessionManifest {
  mtimeMs: number;
  size: number;
  hasSnapshot: boolean;
  /** ts of the latest `context_snapshot` record. */
  snapshotTs?: string;
  /** turn of the latest `context_snapshot` record. */
  snapshotTurn?: number;
  /** countSnapshots() value — max snapshot turn + 1 (turns are monotonic per file). */
  snapshotCount: number;
  /** Byte offset where the latest snapshot line begins, for a direct one-line read. */
  latestOffset?: number;
}
const manifestCache = new Map<string, SessionManifest>();

function statOrNull(path: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** Parse a single JSONL line buffer, returning it only if it is a `context_snapshot` record. */
function parseSnapshotLine(lineBuf: Buffer): Record<string, unknown> | null {
  if (lineBuf.length === 0 || !lineBuf.includes(SNAPSHOT_MARKER)) return null;
  const s = lineBuf.toString('utf8').trim();
  if (!s) return null;
  try {
    const rec = JSON.parse(s) as Record<string, unknown>;
    if (rec && rec.kind === 'context_snapshot' && rec.data) return rec;
  } catch {
    // not valid JSON on its own — a false-positive marker (e.g. the literal string inside
    // some other record's text). Skip it; the real snapshot is elsewhere.
  }
  return null;
}

/**
 * Find the LATEST `context_snapshot` record by scanning the file TAIL backwards in chunks.
 * Only candidate lines (those carrying the snapshot marker) are JSON-parsed, and the scan
 * stops at the first (newest) match — so it never parses the whole file. A single snapshot
 * line larger than one chunk is reassembled across chunks via `pending`.
 */
function tailScanLatestSnapshot(path: string): { record: Record<string, unknown>; offset: number } | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    let pos = size;
    // Bytes of a line whose start lies BELOW `pos` (i.e. in a not-yet-read, earlier chunk),
    // carried down so a snapshot line spanning chunk boundaries is reassembled intact.
    let pending = Buffer.alloc(0);
    while (pos > 0) {
      const readSize = Math.min(TAIL_CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, pos);
      // combined[i] === file byte (pos + i): the freshly read chunk, then the carried tail.
      const combined = pending.length ? Buffer.concat([buf, pending]) : buf;
      let end = combined.length;
      let nl = combined.lastIndexOf(NL, end - 1);
      while (nl !== -1) {
        const rec = parseSnapshotLine(combined.subarray(nl + 1, end));
        if (rec) return { record: rec, offset: pos + nl + 1 };
        end = nl;
        if (end === 0) break;
        nl = combined.lastIndexOf(NL, end - 1);
      }
      // combined[0, end) starts at file offset `pos`. Complete only once pos === 0.
      if (pos === 0) {
        const rec = parseSnapshotLine(combined.subarray(0, end));
        if (rec) return { record: rec, offset: 0 };
      } else {
        pending = Buffer.from(combined.subarray(0, end));
      }
    }
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

/** Read the single JSONL line beginning at `offset` and parse it as a snapshot record. */
function readSnapshotAtOffset(path: string, offset: number): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (offset < 0 || offset >= size) return null;
    let acc = Buffer.alloc(0);
    let pos = offset;
    while (pos < size) {
      const readSize = Math.min(TAIL_CHUNK, size - pos);
      const buf = Buffer.alloc(readSize);
      const n = readSync(fd, buf, 0, readSize, pos);
      if (n <= 0) break;
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(NL);
      if (nl !== -1) {
        acc = acc.length ? Buffer.concat([acc, slice.subarray(0, nl)]) : Buffer.from(slice.subarray(0, nl));
        return parseSnapshotLine(acc);
      }
      acc = acc.length ? Buffer.concat([acc, slice]) : Buffer.from(slice);
      pos += n;
    }
    return parseSnapshotLine(acc);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Return the cached manifest for `path`, recomputing (one tail scan) only when the file is
 * absent from the cache or its mtime/size has changed since the entry was built.
 */
function getManifest(path: string): SessionManifest {
  const st = statOrNull(path);
  if (!st) {
    manifestCache.delete(path);
    return { mtimeMs: 0, size: 0, hasSnapshot: false, snapshotCount: 0 };
  }
  const cached = manifestCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;

  const found = tailScanLatestSnapshot(path);
  const turn = found && typeof found.record.turn === 'number' ? (found.record.turn as number) : undefined;
  const manifest: SessionManifest = found
    ? {
        mtimeMs: st.mtimeMs,
        size: st.size,
        hasSnapshot: true,
        snapshotTs: typeof found.record.ts === 'string' ? (found.record.ts as string) : undefined,
        snapshotTurn: turn,
        // Turns are monotonic within a file (the loop seeds its counter from this value and
        // only increments), so the latest snapshot carries the max turn — max+1 === turn+1.
        snapshotCount: (turn ?? -1) + 1,
        latestOffset: found.offset,
      }
    : { mtimeMs: st.mtimeMs, size: st.size, hasSnapshot: false, snapshotCount: 0 };
  manifestCache.set(path, manifest);
  return manifest;
}

export class SessionLog {
  /** Set (instead of throwing) if a write ever fails, so the loop survives. */
  public lastError?: string;

  /** Whether the log file has had its 0600 mode forced after the first write. */
  private secured = false;

  /** Persistent append fd, opened lazily on the first record (so the file is created lazily). */
  private fd: number | null = null;

  /** Cumulative bytes written by this instance === current file size (append-only, sole writer). */
  private bytesWritten = 0;

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

  /** Append one redacted event line via the persistent fd. Never throws — records `lastError`. */
  record(event: Record<string, unknown>): void {
    try {
      const ts = new Date().toISOString();
      const line = JSON.stringify(redact({ ts, ...event })) + '\n';
      const offset = this.bytesWritten; // byte offset where this line begins
      this.write(line);
      if (event.kind === 'context_snapshot') this.rememberSnapshot(ts, event.turn, offset);
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  /**
   * Persist a single bus event, dropping the per-token stream deltas (`text`/`thinking`/
   * `shell_output`) that are reconstructed from the committed `assistant_done`/`reasoning_done`
   * events. This is the hot path: it is what turns O(tokens) synchronous writes into O(1).
   */
  recordEvent(event: { type?: string; [k: string]: unknown }): void {
    if (typeof event.type === 'string' && SKIP_EVENT_TYPES.has(event.type)) return;
    this.record({ kind: 'event', ...event });
  }

  /** writeSync one line to the persistent append fd, forcing 0600 on first write. */
  private write(line: string): void {
    if (this.fd === null) this.fd = openSync(this.path, 'a', 0o600);
    const buf = Buffer.from(line, 'utf8');
    writeSync(this.fd, buf);
    this.bytesWritten += buf.length;
    if (!this.secured) {
      try {
        fchmodSync(this.fd, 0o600); // force 0600 even if umask widened the create mode
      } catch {
        /* best-effort */
      }
      this.secured = true;
    }
  }

  /** Update the in-process manifest after a snapshot write (the "updated on write" half). */
  private rememberSnapshot(ts: string, turn: unknown, offset: number): void {
    const st = statOrNull(this.path);
    const turnNum = typeof turn === 'number' ? turn : undefined;
    const prev = manifestCache.get(this.path);
    const prevCount = prev?.hasSnapshot ? prev.snapshotCount : 0;
    manifestCache.set(this.path, {
      mtimeMs: st?.mtimeMs ?? 0,
      size: st?.size ?? this.bytesWritten,
      hasSnapshot: true,
      snapshotTs: ts,
      snapshotTurn: turnNum,
      snapshotCount: Math.max(prevCount, (turnNum ?? -1) + 1),
      latestOffset: offset,
    });
  }

  /** Write a `context_snapshot` record for session resume / rewind. */
  recordSnapshot(ctx: Context, turn?: number): void {
    this.record({ kind: 'context_snapshot', data: serializeContext(ctx), turn });
  }

  /**
   * How many assistant turns this session has already snapshotted. The AgentLoop is constructed
   * PER USER MESSAGE, so an instance counter restarted at 0 every message: turn 1 and turn 5 of
   * the same session both wrote to checkpoints/<id>/1/, and the second overwrote the first —
   * destroying the only pristine copy /rewind exists to restore. Seeding from the log makes the
   * counter session-scoped, and survives --resume for free. Answered from the manifest (a tail
   * scan on a cold cache; a cheap stat on a warm one) rather than re-parsing the whole log.
   */
  static countSnapshots(path: string): number {
    return getManifest(path).snapshotCount;
  }

  static sessionIdFromPath(path: string): string {
    return basename(path).replace(/\.jsonl$/, '');
  }

  /**
   * Lightweight snapshot summary for listing — existence + latest ts/turn/count, from the
   * manifest, WITHOUT reading the (potentially large) snapshot payload.
   */
  static snapshotInfo(path: string): {
    hasSnapshot: boolean;
    ts?: string;
    turn?: number;
    count: number;
    /** Byte offset where the latest snapshot line begins (from the tail scan). */
    offset?: number;
  } {
    const m = getManifest(path);
    return {
      hasSnapshot: m.hasSnapshot,
      ts: m.snapshotTs,
      turn: m.snapshotTurn,
      count: m.snapshotCount,
      offset: m.latestOffset,
    };
  }

  /** Latest snapshot payload in a session file, or null. */
  static findLatestSnapshot(path: string): object | null {
    return (SessionLog.findLatestSnapshotRecord(path)?.data as object | undefined) ?? null;
  }

  /** Latest full `context_snapshot` record (data + metadata). */
  static findLatestSnapshotRecord(path: string): Record<string, unknown> | null {
    const m = getManifest(path);
    if (!m.hasSnapshot) return null;
    if (m.latestOffset !== undefined) {
      const rec = readSnapshotAtOffset(path, m.latestOffset);
      if (rec) return rec;
    }
    // Cached offset was stale (file changed under us) — fall back to a fresh tail scan.
    return tailScanLatestSnapshot(path)?.record ?? null;
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
