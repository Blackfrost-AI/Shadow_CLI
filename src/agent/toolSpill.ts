/**
 * Tool-result spill — oversized output goes to a private session file, not the void.
 *
 * Adapted from DeepSeek Harness (`deepseek-ai/deepseek-harness`), MIT License, which spills
 * oversized tool output to a session-scoped file and hands the model a locator. Copyright (c)
 * DeepSeek. See THIRD_PARTY_NOTICES.md.
 *
 * WHY TRUNCATION ALONE IS WRONG
 * -----------------------------
 * Shadow already clamped tool output to `maxToolResultChars` and appended "…(truncated, N
 * characters omitted)". That is lossy and unrecoverable: a `grep` with 40k hits, or a build log
 * whose only diagnostic is on line 9,000, leaves the model with a preview and no way to get the
 * rest. It re-runs the command, or it guesses — and for a security session, re-running a detonation
 * or a scan is both slow and a side effect.
 *
 * Spilling fixes the loss without growing the context: the full body lands in a private file under
 * the session directory (0700 dir, 0600 file), the model gets a head preview plus a one-line
 * locator it can `read_file`/`grep`. The original body is preserved on any failure, so a spill that
 * cannot be written degrades to exactly today's truncation rather than to silence.
 *
 * WHAT THIS MUST NOT DO
 * ---------------------
 * It must never make output *smaller than the cap* spill, never write outside the session dir, and
 * never throw into the tool path — a full disk should cost a preview, not a turn.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SessionLog } from '../state/session.js';
import { safeSessionId } from '../state/retention.js';

export interface SpillResult {
  /** Text to hand the model: a head preview plus a locator line. */
  text: string;
  /** Absolute path of the spilled file, when the write succeeded. */
  path?: string;
  /** True when the full body was persisted and can be read back. */
  spilled: boolean;
}

/** How much of the head to keep inline, as a fraction of the cap. */
const HEAD_FRACTION = 0.6;

/**
 * Directory for spill files. Deliberately inside the session tree so it inherits the session's
 * permissions and is archived with it (retention MOVES `spill/` beside the checkpoint tree on
 * archival; it never deletes — every locator in an archived log must stay resolvable).
 *
 * With a `sessionId` the directory is SESSION-SCOPED: `<sessionsDir>/<id>/spill/` — sessionsDir
 * honors SHADOW_SESSION_DIR, so relocated logs get relocated spills. Without one (legacy callers,
 * tests) the historical workspace-global path is kept; old locators stay readable, no forced move.
 * An unsafe id falls back to the legacy path rather than joining a traversal into the filesystem.
 */
export function spillDir(workspaceRoot: string, sessionId?: string): string {
  const legacy = join(workspaceRoot, '.shadow', 'sessions', 'spill');
  if (sessionId === undefined || !safeSessionId(sessionId)) return legacy;
  return join(SessionLog.sessionsDir(workspaceRoot), sessionId, 'spill');
}

/**
 * Locator text for a reclaimed tool_result body (11.6.0 information survival). The prefix is the
 * legacy sentinel's opening text WITHOUT the closing bracket, so `isReclaimedContent` in
 * context.ts recognizes both the legacy exact sentinels and every locator variant.
 */
export function clearedContentLocator(fullOutputPath: string): string {
  return `[Old tool result content cleared — full output: ${fullOutputPath}]`;
}

/** Locator variant of the degraded-truncation tombstone (summarizer unavailable). */
export function droppedContentLocator(fullOutputPath: string): string {
  return `[Tool result dropped — summarizer unavailable; full output: ${fullOutputPath}]`;
}

/**
 * Persist a body being RECLAIMED from context (microcompaction / degraded truncation) and return
 * the workspace-relative locator path for the sentinel, or null when the write failed. Never
 * throws — compaction must survive a full disk. Never overwrites an existing full-body spill
 * (B2): identical content reuses the file (idempotent re-clear), different content takes a
 * collision-suffixed name.
 */
export function spillReclaimedBody(opts: {
  workspaceRoot: string;
  sessionId?: string;
  toolName: string;
  toolCallId: string;
  body: string;
}): string | null {
  try {
    const dir = spillDir(opts.workspaceRoot, opts.sessionId);
    const path = persistSpillBody(dir, safeName(opts.toolName, opts.toolCallId), opts.body);
    if (!path) return null;
    const rel = relative(opts.workspaceRoot, path);
    // SHADOW_SESSION_DIR can relocate the session tree outside the workspace — a `../`-relative
    // locator would be unresolvable by read_file from the workspace root. Fall back to absolute.
    return rel.startsWith('..') ? path : rel;
  } catch {
    return null;
  }
}

function safeName(toolName: string, toolCallId: string): string {
  // Tool names and call ids reach a filesystem path; strip anything that could traverse. Dots are
  // collapsed too, so no component can ever read as `.` or `..` even before joining.
  const clean = (s: string): string =>
    s
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]+/, '')
      .slice(0, 80) || 'x';
  return `${clean(toolName)}-${clean(toolCallId)}.txt`;
}

/**
 * Spill `body` if it exceeds `maxChars`, else return it untouched.
 *
 * Returns the original body unchanged (and `spilled: false`) in every failure case — a spill is an
 * optimization and must never be able to break a tool result.
 */
export function spillIfOversized(
  body: string,
  opts: {
    maxChars: number;
    toolName: string;
    toolCallId: string;
    workspaceRoot: string;
    /** Session id for the session-scoped spill dir (derived from the session log by callers). */
    sessionId?: string;
    /** Override for tests; defaults to spillDir(). */
    dir?: string;
    /**
     * Truncator for the inline head. Callers that deal in untrusted envelopes pass
     * `envelopeSafeSlice` so a preview can never end mid-envelope (an unclosed
     * `<<<UNTRUSTED_CONTENT_BEGIN>>>` would make later text look trusted). Defaults to a plain cut.
     */
    slice?: (s: string, n: number) => string;
  },
): SpillResult {
  const cut = opts.slice ?? ((s: string, n: number) => s.slice(0, n));
  if (!Number.isFinite(opts.maxChars) || opts.maxChars <= 0 || body.length <= opts.maxChars) {
    return { text: body, spilled: false };
  }

  const dir = opts.dir ?? spillDir(opts.workspaceRoot, opts.sessionId);
  const headLen = Math.floor(opts.maxChars * HEAD_FRACTION);
  const omitted = body.length - headLen;

  let path: string | null;
  try {
    path = persistSpillBody(dir, safeName(opts.toolName, opts.toolCallId), body);
  } catch {
    path = null;
  }
  if (!path) {
    // Could not spill (read-only workspace, full disk, permissions). Fall back to a plain
    // truncation so the model still gets a bounded result instead of an error.
    const head = cut(body, opts.maxChars);
    return {
      text: `${head}\n…(truncated, ${body.length - opts.maxChars} characters omitted; couldn't save the full output)`,
      spilled: false,
    };
  }

  const head = cut(body, headLen);
  return {
    text:
      `${head}\n…(${omitted} more characters — full output saved to ${path}; ` +
      `read it with read_file or grep it there)` ,
    path,
    spilled: true,
  };
}

/**
 * Write `body` under `dir/name` WITHOUT ever clobbering an existing spill (B2 — deterministic
 * safeName filenames mean a re-clear would otherwise persist sentinel text over the original
 * full body). `wx` fails on existence: identical content reuses the file (idempotent), different
 * content takes the next free `-2`, `-3`, … suffix. Returns the written/reused absolute path, or
 * null when nothing could be persisted. Throws only on unexpected non-EEXIST write errors.
 */
function persistSpillBody(dir: string, name: string, body: string): string | null {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  const base = name.endsWith('.txt') ? name.slice(0, -4) : name;
  let candidate = join(dir, name);
  for (let n = 1; ; n++) {
    try {
      writeFileSync(candidate, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      // writeFileSync mode is umask-filtered; enforce explicitly so a permissive umask cannot
      // leave tool output world-readable.
      try {
        chmodSync(candidate, 0o600);
      } catch {
        /* permission tightening is best-effort; the write already succeeded */
      }
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // The file exists. Identical body → reuse it (a re-spill of the same output is idempotent);
      // different body → NEVER overwrite, try the next collision-suffixed name.
      try {
        if (readFileSync(candidate, 'utf8') === body) return candidate;
      } catch {
        /* unreadable existing file — treat as occupied, never overwrite */
      }
      if (n >= 100) return null; // pathological collision storm → honest failure, caller degrades
      candidate = join(dir, `${base}-${n + 1}.txt`);
    }
  }
}