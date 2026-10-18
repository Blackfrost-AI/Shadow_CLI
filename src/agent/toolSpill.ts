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

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * permissions and is cleaned up with it — a spill is a debugging aid, not an archive.
 */
export function spillDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.shadow', 'sessions', 'spill');
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

  const dir = opts.dir ?? spillDir(opts.workspaceRoot);
  const path = join(dir, safeName(opts.toolName, opts.toolCallId));
  const headLen = Math.floor(opts.maxChars * HEAD_FRACTION);
  const omitted = body.length - headLen;

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
    // mkdirSync/writeFileSync modes are umask-filtered; enforce explicitly so a permissive umask
    // cannot leave tool output world-readable.
    try {
      chmodSync(dir, 0o700);
      chmodSync(path, 0o600);
    } catch {
      /* permission tightening is best-effort; the write already succeeded */
    }
  } catch {
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