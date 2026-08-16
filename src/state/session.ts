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
//
// Snapshot format (P2-13): two FULL context snapshots per turn (pre-tool + post-tool) each
// serializing the ENTIRE message array made the log O(T²) — a measured 99% of bytes and a
// 100× transcript ratio at 30 turns. Snapshots are now CHAINED DELTAS: a `format:'full'`
// record carries the whole array, and each later `format:'delta'` record stores only the
// messages APPENDED since the previous snapshot (`data.appended`) plus a `baseOffset`
// pointing at that previous snapshot line. A new full is forced only when the lineage
// diverges (per-message digest mismatch — rewind truncation, summarizer replacement,
// microcompact clearing bodies in place) or every FULL_EVERY_N_SNAPSHOTS (bounding the
// reconstruction walk). Readers reassemble deltas to full form transparently; legacy lines
// with no `format` field are fulls, so pre-P2-13 logs keep working untouched.

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

// P2-13 — chained delta snapshots (see file header).
/** Force a fresh full checkpoint once delta payloads since the last full exceed this. Spacing
 *  checkpoints by BYTE VOLUME (not snapshot count) keeps the file ~linear in transcript size:
 *  each full re-serializes the cumulative array, and the context array is bounded by the
 *  summarizer anyway, so a full every ~2MB of appended messages caps checkpoint overhead at
 *  roughly one extra array-copy per 2MB of session. This is the primary spacing rule. */
const FULL_AFTER_DELTA_BYTES = 2 * 1024 * 1024;
/** Secondary spacing rule for sessions of many TINY messages: after this many chained deltas,
 *  force a full so the reconstruction walk (and a mid-file corruption's blast radius) stays
 *  bounded even when delta bytes stay small. */
const FULL_EVERY_N_SNAPSHOTS = 512;
/** Reconstruction walk cap — a corrupted/cyclic baseOffset chain must terminate, not loop. */
const MAX_CHAIN_DEPTH = FULL_EVERY_N_SNAPSHOTS + 16;

/** Lineage-identity digest over one message's JSON — decides whether the new snapshot is a
 *  clean append onto the previous one (delta) or a divergence (full). Two INDEPENDENT FNV-1a
 *  lanes with different offset bases + the byte length, rendered as a string, give a 64-bit+
 *  digest: a single 32-bit lane is collision-prone (~2^-16 birthday) and FNV-1a is algebraically
 *  invertible, so two DIFFERENT messages could share one 32-bit digest — and a collision makes
 *  the writer emit a delta whose reconstruction silently resurrects the OLD base message. Both
 *  lanes AND the length must agree for a false match, which is astronomically unlikely by accident
 *  and infeasible to craft in tool output. */
function msgDigest(m: unknown): string {
  const s = JSON.stringify(m);
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f; // different offset basis → independent lane
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0; // different multiplier → independent lane
  }
  return `${h1.toString(16)}:${h2.toString(16)}:${s.length}`;
}

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
 * line larger than one chunk is reassembled across chunks via `pending`. When `accept` is
 * given, non-accepted matches are skipped and the scan continues backwards — used to fall
 * past an unreconstructable (torn/corrupt) delta to the newest snapshot that CAN be rebuilt.
 */
function tailScanLatestSnapshot(
  path: string,
  accept?: (rec: Record<string, unknown>, offset: number) => boolean,
): { record: Record<string, unknown>; offset: number } | null {
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
        if (rec && (!accept || accept(rec, pos + nl + 1))) return { record: rec, offset: pos + nl + 1 };
        end = nl;
        if (end === 0) break;
        nl = combined.lastIndexOf(NL, end - 1);
      }
      // combined[0, end) starts at file offset `pos`. Complete only once pos === 0.
      if (pos === 0) {
        const rec = parseSnapshotLine(combined.subarray(0, end));
        if (rec && (!accept || accept(rec, 0))) return { record: rec, offset: 0 };
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

/** Read the single JSONL line beginning at `offset` on an OPEN fd and parse it as a snapshot
 *  record. The fd variant lets a delta-chain walk read many lines with one open(). */
function readSnapshotLineFd(fd: number, size: number, offset: number): Record<string, unknown> | null {
  // A fractional or NaN offset would read at a mid-character byte boundary (or throw) — a
  // corrupt baseOffset is treated as a broken chain link, never an exception.
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) return null;
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
    return readSnapshotLineFd(fd, fstatSync(fd).size, offset);
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

  // P2-13 delta bookkeeping — PER CONTEXT, keyed by the Context object itself. The main loop and
  // its sub-agents share THIS SessionLog but snapshot DIFFERENT contexts interleaved; a single
  // "last snapshot" field would bounce between the two lineages and force every snapshot to
  // re-base as a full (correct, but the size win collapses in sub-agent-heavy sessions). Keyed by
  // lineage, each context chains its own deltas independently. In-memory only: openExisting()
  // adopts a file with no digest state, so the adopter's first snapshot is (correctly) a full.
  private snapState = new WeakMap<
    Context,
    {
      offset: number;
      length: number;
      digests: string[];
      /** Snapshots written since this lineage's last full — full forced at FULL_EVERY_N_SNAPSHOTS. */
      snapsSinceFull: number;
      /** Delta payload bytes since this lineage's last full — full forced past FULL_AFTER_DELTA_BYTES. */
      deltaBytesSinceFull: number;
    }
  >();

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
    // Two sessions can start in the SAME MILLISECOND (TUI + web session, harness fan-out) — the
    // ms-granularity stamp alone would silently give both instances the SAME file, and both would
    // assume sole-writer status (delta baseOffsets + the manifest depend on it). Claim the path
    // atomically with O_EXCL and, on collision, suffix until we own a fresh file.
    let candidate = join(dir, `${stamp}.jsonl`);
    for (let suffix = 0; ; suffix++) {
      try {
        const fd = openSync(candidate, 'wx', 0o600); // atomic create-or-fail
        try {
          fchmodSync(fd, 0o600); // force perms even if umask widened the create mode
        } catch {
          /* best-effort */
        }
        closeSync(fd); // claimed; write() reopens with 'a' on first record
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (suffix > 1000) throw new Error('could not allocate a unique session-log path');
        candidate = join(dir, `${stamp}-${suffix + 1}.jsonl`);
      }
    }
    return new SessionLog(candidate);
  }

  /**
   * Adopt an EXISTING session-log file as a live SessionLog (P2-11 /fork). The bytesWritten
   * invariant (=== current file size, sole writer) is seeded from the file itself so the first
   * append records the correct byte offset. forkSession() uses this after byte-copying a source
   * transcript into a fresh path: the fork becomes sole writer of the copy, and the source file
   * is never touched again. The file must already exist on disk.
   */
  static openExisting(path: string): SessionLog {
    const st = statOrNull(path);
    if (!st) throw new Error(`session log does not exist: ${path}`);
    const log = new SessionLog(path);
    log.bytesWritten = st.size;
    return log;
  }

  /** Append one redacted event line via the persistent fd. Never throws — records `lastError`.
   *  Returns the byte offset where the line begins (undefined on a failed write), so snapshot
   *  bookkeeping can chain `baseOffset`s without re-stating the file. */
  record(event: Record<string, unknown>): number | undefined {
    try {
      const ts = new Date().toISOString();
      const line = JSON.stringify(redact({ ts, ...event })) + '\n';
      const offset = this.bytesWritten; // byte offset where this line begins
      this.write(line);
      if (event.kind === 'context_snapshot') this.rememberSnapshot(ts, event.turn, offset);
      return offset;
    } catch (e) {
      this.lastError = (e as Error).message;
      return undefined;
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

  /** writeSync one line to the persistent append fd, forcing 0600 on first write.
   *  Tracks the ACTUAL bytes written and throws on a short write (ENOSPC/quota): the delta
   *  machinery depends on `bytesWritten` === file size exactly — over-counting after a partial
   *  write would make every later `baseOffset`/manifest offset point past real EOF and corrupt
   *  reconstruction. record() catches the throw, sets lastError, and the torn line is left for
   *  readers to skip (the existing one-line blast radius). */
  private write(line: string): void {
    if (this.fd === null) this.fd = openSync(this.path, 'a', 0o600);
    const buf = Buffer.from(line, 'utf8');
    let written = 0;
    while (written < buf.length) {
      const n = writeSync(this.fd, buf, written, buf.length - written);
      if (n <= 0) break; // no progress (ENOSPC/quota) — don't spin
      written += n;
    }
    this.bytesWritten += written; // actual bytes only — never over-count
    if (!this.secured) {
      try {
        fchmodSync(this.fd, 0o600); // force 0600 even if umask widened the create mode
      } catch {
        /* best-effort */
      }
      this.secured = true;
    }
    if (written < buf.length) {
      throw new Error(`short write to session log: ${written}/${buf.length} bytes (disk full or quota?)`);
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

  /**
   * Write a `context_snapshot` record for session resume / rewind (P2-13: chained deltas).
   * The first snapshot this instance writes is a FULL. Each later snapshot is a DELTA storing
   * only the messages appended since the previous one — unless the lineage diverged. Divergence
   * is caught by comparing per-message digests of the current array's prefix against the
   * previous snapshot's: a rewind truncates, the summarizer replaces the prefix, and
   * microcompact clears stale tool_result bodies IN PLACE — all of them change a digest, so the
   * next snapshot re-bases as a full and the delta chain restarts from it. Periodic fulls
   * (FULL_EVERY_N_SNAPSHOTS / FULL_AFTER_DELTA_BYTES) bound the reconstruction walk.
   */
  recordSnapshot(ctx: Context, turn?: number): void {
    const data = serializeContext(ctx);
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    const digests = new Array<string>(msgs.length);
    for (let i = 0; i < msgs.length; i++) digests[i] = msgDigest(msgs[i]);

    // Base for chaining = THIS context's own last snapshot (not merely the last line written —
    // sub-agents interleave their snapshots on the same log; see snapState).
    const base = this.snapState.get(ctx) ?? null;
    let chainable =
      base !== null &&
      msgs.length >= base.length &&
      base.snapsSinceFull < FULL_EVERY_N_SNAPSHOTS &&
      base.deltaBytesSinceFull < FULL_AFTER_DELTA_BYTES;
    if (chainable && base) {
      for (let i = 0; i < base.length; i++) {
        if (digests[i] !== base.digests[i]) {
          chainable = false; // prefix mutated in place → lineage diverged → re-base with a full
          break;
        }
      }
    }

    let offset: number | undefined;
    if (chainable && base) {
      const payload: Record<string, unknown> = { ...(data as unknown as Record<string, unknown>) };
      delete payload.messages;
      payload.appended = msgs.slice(base.length);
      offset = this.record({
        kind: 'context_snapshot',
        format: 'delta',
        baseOffset: base.offset,
        messageCount: msgs.length,
        data: payload,
        turn,
      });
    } else {
      offset = this.record({ kind: 'context_snapshot', format: 'full', data, turn });
    }
    if (offset === undefined) return; // write failed — lastError is set; bookkeeping unchanged

    if (chainable && base) {
      this.snapState.set(ctx, {
        offset,
        length: msgs.length,
        digests,
        snapsSinceFull: base.snapsSinceFull + 1,
        deltaBytesSinceFull: base.deltaBytesSinceFull + (this.bytesWritten - offset),
      });
    } else {
      this.snapState.set(ctx, { offset, length: msgs.length, digests, snapsSinceFull: 0, deltaBytesSinceFull: 0 });
    }
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

  /** Latest `context_snapshot` record (data + metadata), deltas RECONSTRUCTED to full form.
   *  If the newest snapshot cannot be reconstructed (a torn or corrupt delta line), falls back
   *  to the newest snapshot that CAN be — the same one-snapshot blast radius a torn full line
   *  has always had. */
  static findLatestSnapshotRecord(path: string): Record<string, unknown> | null {
    const m = getManifest(path);
    if (!m.hasSnapshot) return null;
    if (m.latestOffset !== undefined) {
      const rec = SessionLog.reconstructSnapshotRecord(path, readSnapshotAtOffset(path, m.latestOffset));
      if (rec) return rec;
    }
    // Cached offset stale (file changed under us) or the latest snapshot unreconstructable —
    // scan the tail backwards and accept the newest snapshot that CAN be reconstructed.
    const found = tailScanLatestSnapshot(path, (rec) => SessionLog.reconstructSnapshotRecord(path, rec) !== null);
    return found ? SessionLog.reconstructSnapshotRecord(path, found.record) : null;
  }

  /**
   * Assemble a full-form record from an already-full-form base plus a delta record (pure).
   * The delta's scalar state (pinnedPrefix/lastActualTokens/subAgentTasks/…) wins; its
   * `appended` messages concatenate onto the base array.
   */
  private static assembleDelta(base: Record<string, unknown>, delta: Record<string, unknown>): Record<string, unknown> | null {
    const baseData = (base.data ?? null) as Record<string, unknown> | null;
    const deltaData = (delta.data ?? null) as Record<string, unknown> | null;
    if (!baseData || !deltaData) return null;
    const baseMsgs = Array.isArray(baseData.messages) ? baseData.messages : null;
    const appended = Array.isArray(deltaData.appended) ? deltaData.appended : null;
    if (baseMsgs === null || appended === null) return null;
    // Cross-check the count the writer stamped: a corrupt/truncated base or appended array would
    // otherwise assemble a silently wrong message list (missing/extra turns at the base seam).
    // A mismatch means a broken link — treat as corrupt and refuse. Missing count (legacy/hand-
    // edited) is not validated.
    const claimed = delta.messageCount;
    if (typeof claimed === 'number' && baseMsgs.length + appended.length !== claimed) return null;
    const data: Record<string, unknown> = { ...deltaData, messages: [...baseMsgs, ...appended] };
    delete data.appended;
    return { ...delta, format: 'full', data };
  }

  /**
   * Reconstruct any snapshot record to FULL form by walking its delta chain to the base full
   * and reassembling forward. Full-form and legacy (no `format`) records pass through as-is.
   * Returns null when any link is broken (missing/corrupt base, malformed shape) or the chain
   * is longer than MAX_CHAIN_DEPTH / non-decreasing in offset (the base always precedes its
   * delta in the file, so a cyclic or garbage baseOffset can never loop or jump sideways).
   */
  static reconstructSnapshotRecord(path: string, rec: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!rec || rec.format !== 'delta') return rec;
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      const chain: Array<Record<string, unknown>> = [rec]; // latest first, base last
      let cur = rec;
      let below = Number.POSITIVE_INFINITY;
      while (cur.format === 'delta') {
        if (chain.length > MAX_CHAIN_DEPTH) return null;
        const off =
          typeof cur.baseOffset === 'number' && Number.isInteger(cur.baseOffset)
            ? cur.baseOffset
            : -1;
        if (off < 0 || off >= size || off >= below) return null;
        const baseRec = readSnapshotLineFd(fd, size, off);
        if (!baseRec) return null;
        chain.push(baseRec);
        cur = baseRec;
        below = off;
      }
      let full = chain[chain.length - 1]!; // the base full
      for (let i = chain.length - 2; i >= 0; i--) {
        const next = SessionLog.assembleDelta(full, chain[i]!);
        if (!next) return null;
        full = next;
      }
      return full;
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * All `context_snapshot` records of a file in FILE ORDER, deltas reconstructed to full form.
   * A delta's base is always an EARLIER line, so one forward pass resolves every chain
   * in-memory — no re-reads. Snapshots whose chain cannot be resolved (missing/corrupt base)
   * are skipped; readers fall back to the nearest resolvable turn, as before.
   */
  static loadSnapshotRecords(path: string): Array<{ record: Record<string, unknown>; offset: number }> {
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch {
      return [];
    }
    const out: Array<{ record: Record<string, unknown>; offset: number }> = [];
    const byOffset = new Map<number, Record<string, unknown>>(); // offset → full-form record
    let start = 0;
    for (let i = 0; i <= buf.length; i++) {
      if (i < buf.length && buf[i] !== NL) continue;
      const lineOffset = start;
      const rec = parseSnapshotLine(buf.subarray(start, i));
      start = i + 1;
      if (!rec) continue;
      if (rec.format === 'delta') {
        const base = typeof rec.baseOffset === 'number' ? byOffset.get(rec.baseOffset) : undefined;
        const full = base ? SessionLog.assembleDelta(base, rec) : null;
        if (!full) continue; // broken chain — skipped; readers use the nearest resolvable turn
        byOffset.set(lineOffset, full);
        out.push({ record: full, offset: lineOffset });
      } else {
        byOffset.set(lineOffset, rec);
        out.push({ record: rec, offset: lineOffset });
      }
    }
    return out;
  }

  /** Directory holding this workspace's session logs (honors SHADOW_SESSION_DIR). */
  static sessionsDir(workspaceRoot: string): string {
    return resolveSessionsDir(workspaceRoot).dir;
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
