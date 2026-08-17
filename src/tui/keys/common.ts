/**
 * P3-01 — focus-owner router: helpers shared by more than one owner.
 */
import type { QueuedTask } from '../../tui.js';
import type { KeyEnv } from './types.js';

/** Human messages steer the active agent; commands and scheduled wakeups wait for turn-end.
 *  A path-like "/Users/…" is a message, not a command (classifySlash says 'message'). */
export function queuedTaskKind(env: KeyEnv, task: string): QueuedTask['kind'] {
  if (!task.startsWith('/')) return 'steer';
  return env.classifySlash(task).kind === 'message' ? 'steer' : 'deferred';
}

/**
 * F03-05 follow-up — text coalesced with its Enter. Ink dispatches a merged stdin read as ONE
 * keypress event whose `input` is the whole chunk, so `<text>\r` never becomes `key.return`: the
 * composer inserted the text plus a PHANTOM trailing newline (§10's clean step maps \r→\n) and no
 * submit ever fired — any command typed fast enough to share a stdin read with its Enter (tmux/
 * SSH write batching, macro players, a busy frame) silently no-op'd. `/goal` was the founder
 * report. Recognizes exactly that shape and nothing else:
 *
 * Returns the text when `raw` is <printable text><one trailing BARE \r>, else null.
 *  - Every C0/DEL byte excludes a chunk, so ESC-led sequences (mouse, DSR replies, cursor keys,
 *    bracketed-paste markers) and multi-line text never match — they keep their specialized paths.
 *  - ONLY the bare \r counts: that is the one byte a typed Enter produces in raw mode. A trailing
 *    `\n` or `\r\n` is the signature of an UNBRACKETED paste (terminals send CRLF/LF for pasted
 *    newlines; nobody types CRLF) — those must insert as literal text exactly like a bracketed
 *    paste would, never submit (founder, 2026-08-17).
 *  - The caller replays the text and then a synthetic Enter: byte-for-byte the behavior of the
 *    same input arriving as two separate reads.
 *  - The caller MUST gate on `pastingRef` — a bracketed-paste body chunk that happens to end in
 *    \r is literal content, not a submit.
 */
export function batchedTextReturn(raw: string): string | null {
  const m = /^([^\x00-\x1f\x7f]+)\r$/.exec(raw);
  return m ? m[1] : null;
}
