/**
 * P3-01 — focus-owner router: the approval / question DIALOG owner (old onKey §1).
 *
 * The dialog claims the whole keystream while an approval/question gate is pending. Extracted
 * verbatim (behavior-preserving) from the old if-chain; every ref/action goes through `KeyEnv`.
 */
import { shellCommandOf } from '../format.js';
import { recommendedIndex } from '../questions.js';
import { raiseAutonomy } from '../../safety/permissions.js';
import type { ContextName } from '../keybindings/types.js';
import { queuedTaskKind } from './common.js';
import { dialogArmMs } from './reserved.js';
import type { FocusOwnerHandler, InkKey, KeyEnv } from './types.js';

function handleDialog(env: KeyEnv, ch: string, key: InkKey): boolean {
  const g = env.igateRef.current;
  if (!g) return true;
  const pending = env.pendingRef.current!;
  const kind = pending.kind;
  // Enter with composer text means "send my follow-up", never "approve whatever dialog
  // happened to open over my typing". Queue before resolving the gate so the loop's promise
  // continuation cannot outrun us; explicitly deny the pending action, then steer model work.
  if (key.return && env.inputRef.current.trim()) {
    const task = env.inputRef.current.trim();
    const taskKind = queuedTaskKind(env, task);
    env.setQueued([...env.queuedTasksRef.current, { text: task, kind: taskKind }]);
    env.historyRef.current.push(task);
    env.histIdxRef.current = env.historyRef.current.length;
    env.setLine('');
    env.dialogTypeaheadRef.current = false;
    // P1A-15: an Enter that lands inside the arm window was almost certainly the user
    // finishing their sentence just as the dialog popped — NOT a decision on a dialog they
    // have not seen. Do not g.respond('deny') an unseen gate; steer instead (the steer's
    // abort resolves the pending gate through settleWithAbort), so the message is queued and
    // model work redirected without a phantom denial the user never chose.
    if (Date.now() - env.dialogShownAtRef.current < dialogArmMs()) {
      env.loopRef.current?.requestSteer();
      env.pushLine({ text: '  ↪ pending message — steering (dialog not yet seen)', dimColor: true });
      return true;
    }
    g.respond('deny');
    const steered = taskKind === 'steer' ? (env.loopRef.current?.requestSteer() ?? false) : false;
    env.pushLine({
      text: steered
        ? '  ↪ pending message — current action denied; steering now'
        : '  ↪ pending input — current action denied; queued in order',
      dimColor: true,
    });
    return true;
  }
  // ── Type-ahead guard ──────────────────────────────────────────────────────────────────
  // "Type your next message while the agent works" is an advertised workflow, and the gate
  // can open MID-SENTENCE. Every keystroke already in flight was then routed straight into
  // the dialog as a decision: typing "also fix the failing test" while a run_shell gate
  // opened hit (f)=approve-for-prefix on `rm -rf` — a session-wide grant — and (a)=raise
  // autonomy, with the tool running and the dialog gone before the user saw it.
  //
  // A key can only be a decision if it was pressed AFTER the dialog was on screen. Anything
  // sooner is text the user was already typing, so it goes to the composer where they aimed
  // it. The window only has to cover in-flight input: reading a dialog and reacting takes far
  // longer than this, so no deliberate keypress is ever swallowed.
  const printable = Boolean(ch && !key.ctrl && !key.meta && !key.escape && !key.return && ch >= ' ');
  if (Date.now() - env.dialogShownAtRef.current < dialogArmMs()) {
    if (printable) {
      env.dialogTypeaheadRef.current = true;
      env.insertPastable(ch); // keep the user's sentence intact
    }
    return true;
  }
  // Latch the diversion for the whole burst. A fixed time window alone failed whenever the
  // gate appeared near the start of a sentence: the early letters went to the composer and
  // a later `y`/`a`/`f` became a privilege decision. Printable input can no longer decide
  // until a non-printable key explicitly re-focuses the dialog; that first key is consumed.
  if (env.dialogTypeaheadRef.current) {
    if (printable) env.insertPastable(ch);
    else env.dialogTypeaheadRef.current = false;
    return true;
  }
  // Any key during a question dialog means a human is handling it → CANCEL the idle
  // auto-answer for good (not merely restart it). Done BEFORE the resolver routing so bound
  // keys (enter/arrows/escape) count as engagement too.
  if (kind === 'user_question' && env.autoAnswerEnabled && !env.autoAnswerEngagedRef.current) {
    env.autoAnswerEngagedRef.current = true;
    env.autoAnswerSecsRef.current = null;
    env.setAutoAnswerSecs(null);
  }
  // Route bound approval/question keys through the keybinding resolver FIRST, so
  // ~/.shadow/keybindings.json can rebind y/n/s/f/a (Confirmation) and question-dialog
  // nav (QuestionDialog). Unbound keys (number-jump, space-toggle, Tab) and any key the
  // user has unbound fall through to the legacy handling below — defaults never strand you.
  const dialogCtx: ContextName[] = kind === 'user_question' ? ['QuestionDialog', 'Global'] : ['Confirmation', 'Global'];
  if (env.kbConsume(ch, key, dialogCtx)) return true;
  if (kind === 'user_question' && pending.questions?.length) {
    const qs = pending.questions;
    const idx = Math.min(env.questionIndexRef.current, qs.length - 1);
    const q = qs[idx];
    if (!q) return true;
    const cursor = env.questionCursorRef.current[idx] ?? recommendedIndex(q);
    // ↑/↓ move the option cursor. Single-select follows it (radio); multi just moves.
    if (key.upArrow) {
      const pos = Math.max(0, cursor - 1);
      env.setQuestionCursor(idx, pos);
      if (!q.multiSelect) env.chooseAtQuestion(idx, pos);
      return true;
    }
    if (key.downArrow) {
      const pos = Math.min(q.options.length - 1, cursor + 1);
      env.setQuestionCursor(idx, pos);
      if (!q.multiSelect) env.chooseAtQuestion(idx, pos);
      return true;
    }
    // ←/→ (and Tab) switch between questions in a multi-question dialog.
    if (key.leftArrow) {
      env.setQuestionIndex(Math.max(0, idx - 1));
      return true;
    }
    if (key.rightArrow || key.tab) {
      env.setQuestionIndex(Math.min(qs.length - 1, idx + 1));
      return true;
    }
    // Space toggles the highlighted option (multi-select).
    if (ch === ' ' && q.multiSelect) {
      env.chooseAtQuestion(idx, cursor);
      return true;
    }
    // Number keys jump straight to an option.
    if (ch >= '1' && ch <= '9') {
      const pos = Number(ch) - 1;
      if (q.options[pos]) {
        env.setQuestionCursor(idx, pos);
        env.chooseAtQuestion(idx, pos);
      }
      return true;
    }
    if (key.return) {
      env.confirmQuestion();
      return true;
    }
    if (key.escape) g.respond('deny');
    return true;
  }
  // F07-09: an acknowledge-only dialog (catastrophic denylist) offers NO approve verbs —
  // the loop hard-blocks the call regardless. Every key is an acknowledgement; we answer
  // 'deny' (the loop discards the decision anyway) so no grant can mint from this dialog.
  if (pending.acknowledgeOnly) {
    g.respond('deny');
    return true;
  }
  if (ch === 'y' || (key.return && kind !== 'user_question')) g.respond('approve');
  else if (ch === 'n' || key.escape) g.respond('deny');
  else if (ch === 's' && kind === 'permission') g.respond({ approveForSession: true });
  else if (ch === 'f' && kind === 'permission' && pending.call.name === 'run_shell') {
    const cmd = shellCommandOf(pending.call.input) ?? '';
    const prefix = cmd.split(/\s+/).slice(0, 2).join(' ');
    g.respond({ approveForPrefix: prefix || cmd.slice(0, 24) });
  } else if (ch === 'a' && kind !== 'plan_enter') {
    // raiseAutonomy, NOT cycleAutonomy: the cycle WRAPS full→manual, so pressing "(a)lways"
    // on the one dialog a full-autonomy session ever sees (a denylisted call) both ran the
    // catastrophic call AND flipped the session to ask-about-everything. replGate.ts:33 got
    // this right; the TUI kept the cycling version. Shift+Tab is still the cycle.
    const next = raiseAutonomy(env.autonomyRef.current);
    env.setAutonomy(next);
    g.respond({ setAutonomy: next });
  }
  return true;
}

export const dialogOwner: FocusOwnerHandler = {
  id: 'dialog',
  active: (env) => env.pendingRef.current !== null,
  handle: handleDialog,
};
