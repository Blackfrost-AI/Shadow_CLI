/**
 * P3-01 — focus-owner router: transports and reserved chords.
 *
 * These resolve BEFORE owner routing, by contract: a transport (mouse report, DSR reply,
 * bracketed paste) is never a decision, and the exit chords must survive every modal. The
 * ordering inside `runTransportsAndReserved` is the exact order of the old if-chain head —
 * it is part of the contract and is exercised by the byte-level suites (paste-vs-modal,
 * DSR-batched-with-text, ^D-in-paste, Ctrl-X arming).
 */
import { hasSgrMouse } from '../composer.js';
import type { InkKey, KeyEnv } from './types.js';

// Bracketed-paste markers (DECSET 2004, enabled at mount). The terminal wraps every paste in
// these, and Ink hands the raw CSI through in `ch` — the same transport the SGR mouse reports
// ride on — so the key handler can treat the whole paste as ONE atomic insert.
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** Cursor-position report (DSR reply): `ESC[n;mR`, ESC optional (a chunk-leading ESC is stripped
 *  by Ink). Matched against the WHOLE raw chunk, not the trimmed last-sequence. */
export const DSR_REPLY_EXACT = /^\x1b?\[\d+;\d+R$/;

/** How long a freshly-opened approval dialog ignores keystrokes as decisions (dialog owner).
 *
 * Sized to swallow only IN-FLIGHT input. Sustained fast typing is ~125 ms/key, so this covers the
 * couple of keys already travelling when the gate opens; a deliberate answer requires reading the
 * dialog first, which is several hundred milliseconds of human reaction time on top. Raising it
 * much further would start eating real answers, and lowering it reopens the leak.
 *
 * `SHADOW_DIALOG_ARM_MS` overrides it. Tests set 0 because a driver presses the key in the same
 * tick the dialog opens — a timing no human can produce, and the one case where "was this key
 * already in flight?" has no meaningful answer. Setting it to 0 in a real session re-opens the
 * type-ahead approval hole, so it is a test seam, not a preference.
 *
 * Read per-use, not once at module load: ESM hoists imports above a test file's env assignment, so
 * a module-level constant would always capture the default and the seam would silently not work.
 */
export function dialogArmMs(): number {
  const n = Number(process.env.SHADOW_DIALOG_ARM_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 275;
}

/** True when the key was consumed by a transport or reserved chord (routing must stop). */
export function runTransportsAndReserved(env: KeyEnv, ch: string, key: InkKey): boolean {
  // TRANSPORT: SGR mouse — mouse-tracking CSI (\x1b[< … ) never reaches the Esc/abort or
  // composer-typing paths — a report is not typed text. It IS routed to the click-to-caret
  // handler first (which returns for everything it doesn't use). Before 3.5.2 this branch
  // returned unconditionally, which made the click handler further down dead code: mouse mode
  // did nothing but eat the wheel.
  if (ch && hasSgrMouse(ch)) {
    env.handleMouse(ch);
    return true;
  }
  // TRANSPORT: cursor-position report (the answer to our own click DSR, already consumed by the
  // raw tap). Ink would otherwise insert it as the literal text `[38;1R`. Matched against the
  // WHOLE raw chunk (not the trimmed last-sequence in rawKeyRef) so a report batched with typed
  // text swallows ONLY a pure report chunk — never the text typed alongside it (review finding).
  if (DSR_REPLY_EXACT.test(env.rawChunkRef.current)) return true;

  // RESERVED: exit-latch disarm. Any key other than a second exit press (Ctrl-C, or Ctrl-D while
  // the composer is empty) disarms the "press again to quit" latch, so an old press never lingers
  // to make a later one quit unexpectedly. The latch is SHARED between the two exit paths: ^C then
  // ^D on an empty draft quits, and vice versa — both are the same advertised "press twice" exit.
  if (
    env.ctrlCArmedRef.current &&
    !(key.ctrl && (ch === 'c' || (ch === 'd' && env.inputRef.current.length === 0)))
  ) {
    env.ctrlCArmedRef.current = false;
  }

  // RESERVED CHORD — Ctrl-C is dispatched before ANY focus owner claims the keystream.
  //
  // It used to sit below the dialog and picker branches, both of which `return` on every key,
  // so Ctrl-C was dead for the entire life of an approval dialog, a question dialog, or the
  // model picker — on frames whose own hint row still advertises "Ctrl-C ×2 quits". A modal
  // you cannot escape is the worst possible place to lose the escape hatch, and the type-ahead
  // guard would otherwise widen the dead zone rather than narrow it.
  //
  // Two-stage always, so a stray press can never kill the session: the first press arms (and,
  // if a turn is running, interrupts it and drops the queue); a second quits. Esc remains the
  // dedicated interrupt that KEEPS the session.
  //
  // ORDERING NOTE (P3-01): unlike Ctrl-D below — which deliberately sits BELOW the paste
  // machinery so a literal \x04 in a paste can never arm the latch — Ctrl-C sits ABOVE it, so a
  // lone \x03 keypress arriving mid-paste arms the latch. This asymmetry is INHERITED verbatim
  // from the old if-chain (^C has always preceded paste; ^D was deliberately hoisted below it in
  // F03-05). Keeping it here preserves the no-behavior-change contract of the extraction; if the
  // mid-paste-\x03 case is ever deemed worth changing, do it as its own release with its own
  // byte-level pins — not inside this refactor.
  if (key.ctrl && ch === 'c') {
    if (env.ctrlCArmedRef.current) {
      env.exit();
      return true;
    }
    env.ctrlCArmedRef.current = true;
    if (env.runningRef.current) {
      env.controllerRef.current?.abort();
      if (env.queuedTasksRef.current.length > 0) env.setQueued([]);
    }
    env.pushLine({ text: '  ^C — press Ctrl-C again to quit (Esc just interrupts)', dimColor: true });
    return true;
  }

  // RESERVED CHORD — EXTERNAL EDITOR: Ctrl-X arms, then Ctrl-E opens $EDITOR on the draft
  // (F08-10). Resolved above the composer so the armed Ctrl-E isn't swallowed by the
  // move-to-end binding. Idle-only: the editor blocks the event loop, so never while a turn
  // runs or a modal is open.
  if (env.ctrlXArmedRef.current) {
    env.ctrlXArmedRef.current = false;
    if (key.ctrl && ch === 'e') {
      env.openExternalEditor();
      return true;
    }
    // Ctrl-X was not followed by Ctrl-E — fall through and handle this key normally.
  }
  if (
    key.ctrl &&
    ch === 'x' &&
    !env.runningRef.current &&
    !env.pendingRef.current &&
    !env.pickerOpenRef.current &&
    !env.searchRef.current
  ) {
    env.ctrlXArmedRef.current = true;
    return true;
  }

  // TRANSPORT: BRACKETED PASTE is a TRANSPORT, not a focus owner (P1A-14, F03-01). It is
  // resolved ABOVE the dialog/picker owners, because a paste is never a decision: before this
  // hoist, a paste into an open approval dialog had its \x1b[200~ start marker swallowed by the
  // dialog branch's unconditional return, and the paste CONTENT then flowed into the decision
  // path chunk-by-chunk — a newline arriving as its own chunk parsed as key.return and could
  // APPROVE the pending call, and a multi-chunk paste whose end marker landed after the dialog
  // closed stranded pastingRef set → permanent input lockout. Now the markers are consumed here
  // first; the completed paste is inserted by insertPastable, which routes to the composer draft
  // regardless of which owner has focus (the same place type-ahead sends keys during a dialog),
  // so a paste can never resolve a modal and can never strand paste state across a modal edge.
  //
  // Ink mangles the raw stream two ways this block undoes (see use-input.js): a chunk-LEADING
  // \x1b is stripped, so the start marker arrives as '[200~' (inner markers keep their ESC) —
  // restore it before matching; and a chunk that IS a named key ('\r'→return, '\t'→tab) arrives
  // with input '' and only the flag set — mid-paste those are literal bytes, re-materialize them.
  const chp = ch && (ch.startsWith('[200~') || ch.startsWith('[201~')) ? `\x1b${ch}` : ch;
  if (env.pastingRef.current) {
    const piece = chp || (key.return ? '\n' : key.tab ? '\t' : '');
    if (!piece) return true; // unrepresentable key mid-paste (arrows etc.) — drop
    const endIdx = piece.indexOf(PASTE_END);
    if (endIdx < 0) {
      env.pasteBufRef.current += piece;
      // Runaway guard: no end marker after 8 MB means the marker was lost (or a
      // hostile stream) — bail out of paste mode rather than buffer forever.
      if (env.pasteBufRef.current.length > 8 * 1024 * 1024) {
        env.pastingRef.current = false;
        env.pasteBufRef.current = '';
      }
      return true;
    }
    const content = env.pasteBufRef.current + piece.slice(0, endIdx);
    env.pastingRef.current = false;
    env.pasteBufRef.current = '';
    env.insertPastable(content.replace(/\r\n?/g, '\n'));
    return true;
  }
  if (chp && chp.includes(PASTE_START)) {
    const startIdx = chp.indexOf(PASTE_START);
    // Text typed in the same stdin read BEFORE the paste began inserts normally first.
    const prefix = chp.slice(0, startIdx);
    if (prefix) env.insertPastable(prefix.replace(/\r\n?/g, '\n'));
    const after = chp.slice(startIdx + PASTE_START.length);
    const endIdx = after.indexOf(PASTE_END);
    if (endIdx >= 0) {
      // Whole paste in one chunk — the common case.
      env.insertPastable(after.slice(0, endIdx).replace(/\r\n?/g, '\n'));
    } else {
      env.pastingRef.current = true;
      env.pasteBufRef.current = after;
    }
    return true;
  }

  // RESERVED CHORD — Ctrl+D on an EMPTY composer (F03-05) — the shell's EOF convention and the
  // second advertised exit path ('Exit: Ctrl+C twice (or Ctrl+D on an empty composer)'). Shares
  // Ctrl-C's two-stage latch: the first press arms (and interrupts a running turn exactly like
  // ^C), a second consecutive press quits, any other key disarms. Sits BELOW the paste machinery
  // so a literal \x04 inside a bracketed paste can never arm the latch (or quit the app
  // mid-paste), and ABOVE the owners so the exit hatch survives modals — the same hoist
  // rationale as Ctrl-C. With a non-empty draft the key keeps its forward-delete meaning (the
  // composer owner's editing layer).
  if (key.ctrl && ch === 'd' && env.inputRef.current.length === 0) {
    if (env.ctrlCArmedRef.current) {
      env.exit();
      return true;
    }
    env.ctrlCArmedRef.current = true;
    if (env.runningRef.current) {
      env.controllerRef.current?.abort();
      if (env.queuedTasksRef.current.length > 0) env.setQueued([]);
    }
    env.pushLine({ text: '  ^D — press Ctrl+D again to quit (Esc just interrupts)', dimColor: true });
    return true;
  }

  return false;
}
