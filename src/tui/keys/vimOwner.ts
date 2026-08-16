/**
 * P3-01 — focus-owner router: the VIM modal-editing owner (old onKey §2.92).
 *
 * A MODE that reinterprets keys, consulted after the real focus owners (dialog/picker/search)
 * and before the composer. ESC enters NORMAL mode; in NORMAL, keys are motions/operators (never
 * text) and are consumed; STRUCTURAL keys (Enter=submit, Tab, arrows, paging, Ctrl/Meta chords)
 * keep their composer handlers, so the owner returns FALSE for them and routing falls through
 * to the composer. INSERT is the default composer (all keys fall through except Esc).
 */
import { vimNormalKey, type VimMode } from '../vim.js';
import type { FocusOwnerHandler, InkKey, KeyEnv } from './types.js';

function handleVim(env: KeyEnv, ch: string, key: InkKey): boolean {
  if (key.escape) {
    env.vimPendingRef.current = '';
    env.vimCountRef.current = 0; // Esc cancels a half-typed count, like vim
    if (env.vimModeRef.current !== 'normal') env.setVimMode('normal');
    // Vim NORMAL keeps the caret on a char, not past the end of the line.
    const clamped = Math.min(env.cursorRef.current, Math.max(0, env.inputRef.current.length - 1));
    if (clamped !== env.cursorRef.current) {
      env.cursorRef.current = clamped;
      env.setCursor(clamped);
    }
    return true;
  }
  if (env.vimModeRef.current !== 'normal') return false; // INSERT: the composer handles the key
  if (key.backspace || key.delete) {
    // Backspace moves left (vim), it does not delete.
    const next = Math.max(0, env.cursorRef.current - 1);
    env.cursorRef.current = next;
    env.setCursor(next);
    return true;
  }
  // Enter (submit), Tab, arrows, paging, and Ctrl/Meta chords keep their handlers.
  const structural =
    key.return || key.tab || key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown;
  if (!structural && ch) {
    // Ink batches fast typing / paste into one `ch`, so step through it key by key.
    // If an edit switches to INSERT mid-batch, the rest is inserted literally.
    // j/k need the live composer width to land on the right wrapped visual row.
    const vimInner = env.composerInnerWidth();
    let text = env.inputRef.current;
    let cur = env.cursorRef.current;
    let pend = env.vimPendingRef.current;
    let find = env.vimFindRef.current;
    let cnt = env.vimCountRef.current;
    let reg = env.vimRegRef.current;
    let mode: VimMode = env.vimModeRef.current;
    for (const c of ch) {
      if (mode === 'insert') {
        text = text.slice(0, cur) + c + text.slice(cur);
        cur += c.length;
        continue;
      }
      const r = vimNormalKey(text, cur, pend, c, vimInner, { lastFind: find, count: cnt, register: reg });
      text = r.input;
      cur = r.cursor;
      pend = r.pendingOp;
      mode = r.mode;
      find = r.lastFind;
      cnt = r.count;
      reg = r.register;
    }
    env.vimPendingRef.current = pend;
    env.vimFindRef.current = find;
    env.vimCountRef.current = cnt;
    env.vimRegRef.current = reg;
    // F03-06: route edits through applyEdit so vim kills (x/D/dd/cc, operator motions)
    // are undoable with Ctrl+Z like every other composer edit. A cursor-only change
    // ('a', j/k, plain motions) must NOT push an undo frame — moveCaret is enough.
    if (text !== env.inputRef.current) env.applyEdit({ text, cursor: cur, killed: '' });
    else if (cur !== env.cursorRef.current) env.moveCaret(cur);
    if (mode !== env.vimModeRef.current) env.setVimMode(mode);
    return true; // consume every non-structural key in NORMAL (unknown keys never insert)
  }
  if (!structural) return true; // swallow any other non-structural key in NORMAL
  return false; // structural key — the composer keeps it
}

export const vimOwner: FocusOwnerHandler = {
  id: 'vim',
  active: (env) => env.vimEnabledRef.current && !env.runningRef.current,
  handle: handleVim,
};
