/**
 * P3-01 — focus-owner router: helpers shared by more than one owner.
 */
import {
  deleteCharRight,
  lineEnd,
  lineStart,
  nextGrapheme,
  prevGrapheme,
  splitKeyChunk,
  stripSgrMouse,
  wordLeft,
  wordRight,
} from '../composer.js';
import type { QueuedTask } from '../../tui.js';
import type { KeyEnv } from './types.js';

// ── Key SHAPES the `key` object cannot describe ──────────────────────────────────────────────
// Matched against the RAW stdin chunk, so the leading ESC is required — without it `OH` would
// make a typed capital H read as Home. Shared by the composer's editing layer and the paste
// transport, which both have to recognise these in a chunk Ink only partly parsed.
export const HOME_KEYS = /^\x1b(\[1~|\[7~|\[H|OH)$/;
export const END_KEYS = /^\x1b(\[4~|\[8~|\[F|OF)$/;
export const FORWARD_DELETE = /^\x1b\[3(;\d+)?~$/;
/**
 * Shift+Enter, in the encodings terminals actually send once configured. Out of the box
 * Terminal.app, iTerm2 and the VS Code terminal all send a BARE `\r` for Shift+Enter —
 * indistinguishable from Enter — so a `key.shift` test can never be true; a terminal configured
 * for CSI-u (kitty/foot/WezTerm natively; iTerm2 + VS Code via `/terminal-setup`) sends
 * `ESC [ 13 ; 2 u`, and xterm's modifyOtherKeys sends `ESC [ 27 ; 2 ; 13 ~`.
 */
export const SHIFT_ENTER = /^\x1b\[(?:13;(\d+)u|27;(\d+);13~)$/;

/** Arrow keys in every encoding terminals send, including the modified `\x1b[1;5C` forms. */
const ARROW_SEQ = /^\x1b(?:\[|O)(?:1;(\d+))?([ABCD])$/;

/**
 * Apply one key sequence that arrived GLUED TO typed text in the same stdin read (see
 * `splitKeyChunk`). Only keys a composer can act on are applied; anything else is CONSUMED rather
 * than typed, because its bytes are not what the user wrote — an unrecognised sequence used to be
 * inserted literally once the control-byte strip removed its ESC.
 *
 * Up/Down are left alone on purpose: they drive history recall and vertical caret movement through
 * a longer chain of branches, and a merged read containing one is vanishingly rare.
 */
export function applyChunkSequence(env: KeyEnv, seq: string, shiftEnter: RegExp): void {
  const text = env.inputRef.current;
  const cur = env.cursorRef.current;
  if (shiftEnter.test(seq)) {
    env.setComposer(text.slice(0, cur) + '\n' + text.slice(cur), cur + 1);
    env.setMenuIndex(0);
    return;
  }
  if (HOME_KEYS.test(seq)) {
    env.moveCaret(lineStart(text, cur));
    return;
  }
  if (END_KEYS.test(seq)) {
    env.moveCaret(lineEnd(text, cur));
    return;
  }
  if (FORWARD_DELETE.test(seq)) {
    env.applyEdit(deleteCharRight(text, cur));
    return;
  }
  if (seq === '\x7f') {
    env.applyEdit(deleteCharRight(text, prevGrapheme(text, cur)));
    return;
  }
  const arrow = ARROW_SEQ.exec(seq);
  if (!arrow) return; // an unbound key: consuming it beats typing its bytes into the draft
  const mod = Number(arrow[1] ?? '1');
  const word = mod === 3 || mod === 4 || mod === 5 || mod === 6 || mod === 8; // alt/ctrl variants
  const dir = arrow[2]!;
  if (dir === 'D') env.moveCaret(word ? wordLeft(text, cur) : prevGrapheme(text, cur));
  else if (dir === 'C') env.moveCaret(word ? wordRight(text, cur) : nextGrapheme(text, cur));
}

/** The control-byte / mouse-fragment filter every insert path shares. */
export const sanitizeTyped = (t: string): string =>
  stripSgrMouse(t).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

/**
 * Insert one raw stdin chunk into the draft: printable runs go in as TEXT, and any key sequence
 * glued to them is APPLIED (see `splitKeyChunk` for why a chunk can hold both).
 *
 * Returns true when the chunk contained at least one key sequence — i.e. when the split path, not
 * the plain-insert path, handled it.
 *
 * Shared with the paste transport: text that shares a read with a paste marker belongs to the
 * DRAFT, and it may carry a key with it (`"[201~ab[D` — replayed typing right after a
 * paste), which used to be discarded wholesale.
 */
export function insertChunk(env: KeyEnv, chunk: string, shiftEnter: RegExp): boolean {
  const parts = env.pastingRef.current ? [] : splitKeyChunk(chunk);
  if (parts.length === 0) {
    const clean = sanitizeTyped(chunk);
    if (clean) env.insertPastable(clean);
    return false;
  }
  for (const part of parts) {
    if ('text' in part) {
      const clean = sanitizeTyped(part.text);
      if (clean) env.insertPastable(clean);
    } else {
      applyChunkSequence(env, part.seq, shiftEnter);
    }
  }
  return true;
}

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

/**
 * Prompt history is kept for the whole process and every entry is retained so ↑ can reach it and a
 * recalled chip can be re-resolved. Nothing ever trimmed it: a long session accumulated every prompt
 * ever typed, and `prunePastes`/`pasteChipReferenced` rescan the whole array on each large paste.
 * The cap is far past what ↑ can practically reach, so it bounds memory without changing behaviour
 * for any realistic scroll-back.
 */
export const HISTORY_MAX = 500;

/** Push one submitted prompt and leave the caret index at the end (the only two things every site did). */
export function pushHistory(env: KeyEnv, entry: string): void {
  const h = env.historyRef.current;
  h.push(entry);
  if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
  env.histIdxRef.current = h.length;
}
