/**
 * P3-01 — focus-owner router: the COMPOSER owner (old onKey §3 … §10).
 *
 * The always-active fall-through owner: everything no modal/mode claimed lands here, in the
 * exact layer order of the old if-chain — Esc interrupt → keybinding resolver → slash-menu
 * overlay → Tab autonomy ring → word/line editing → caret movement → ↑/↓ (multi-row drafts +
 * history) → backspace → submit → printable insert.
 */
import {
  cursorOnFirstRow,
  cursorOnLastRow,
  cursorToRowCol,
  deleteCharRight,
  deleteWordLeft,
  deleteWordRight,
  dropConsumedPastes,
  expandPastes,
  killToLineEnd,
  killToLineStart,
  lineEnd,
  lineStart,
  moveCursorVertical,
  nextGrapheme,
  prevGrapheme,
  stripSgrMouse,
  wordLeft,
  wordRight,
} from '../composer.js';
import { atMentionToken, rankFileCandidates } from '../fileMentions.js';
import { leadsWithBlock, stripTrailingNewlines } from '../streamCommit.js';
import { C } from '../theme.js';
import { cycleAutonomy } from '../../safety/permissions.js';
import type { ContextName } from '../keybindings/types.js';
import type { SlashMenuItem } from '../../tui.js';
import { queuedTaskKind } from './common.js';
import type { FocusOwnerHandler, InkKey, KeyEnv } from './types.js';

// Keys Ink's `key` object has no field for (Home/End) or actively mis-reports (forward-delete,
// which it collapses onto the same key.delete as Backspace). Matched against the RAW stdin chunk
// (App.js emits it before parsing), so the leading ESC is required — without it `OH` would make a
// typed capital H read as Home.
const HOME_KEYS = /^\x1b(\[1~|\[7~|\[H|OH)$/;
const END_KEYS = /^\x1b(\[4~|\[8~|\[F|OF)$/;
const FORWARD_DELETE = /^\x1b\[3(;\d+)?~$/;
/**
 * Shift+Enter, in the encodings terminals actually send once configured (A3).
 *
 * Out of the box Terminal.app, iTerm2 and the VS Code terminal all send a BARE `\r` for
 * Shift+Enter — indistinguishable from Enter — so the `key.shift` test could never be true and
 * the composer spent the whole 3.x line advertising a binding that did not work. A terminal
 * configured for CSI-u (kitty/foot/WezTerm natively; iTerm2 + VS Code via `/terminal-setup`)
 * sends `ESC [ 13 ; 2 u`; xterm's modifyOtherKeys sends `ESC [ 27 ; 2 ; 13 ~`.
 */
const SHIFT_ENTER = /^\x1b\[(?:13;(\d+)u|27;(\d+);13~)$/;

/** Slash commands safe to run LIVE while a turn is executing; everything else queues. */
const SLASH_WHILE_RUNNING = new Set(['/help', '/cost', '/usage', '/context', '/connections', '/fast', '/effort', '/version', '/copy']);

function handleComposer(env: KeyEnv, ch: string, key: InkKey): boolean {
  // Goal-column memory: a RUN of ↑/↓ keeps aiming at the column the run started from; any other
  // key ends the run — the caret moved for a different reason, so the old goal is stale.
  if (!key.upArrow && !key.downArrow) env.goalColRef.current = null;

  // §3 — Esc, the interrupt key. While a turn runs, Esc stops it (and pending input then
  // flushes, so a steering message runs next). When idle, Esc cancels pending input,
  // else clears the composer. Session always survives — only Ctrl-C quits.
  if (key.escape) {
    if (env.compactingRef.current) {
      env.compactAbortRef.current?.abort();
      return true;
    }
    if (env.runningRef.current) {
      env.controllerRef.current?.abort();
      // Commit the streamed tail BEFORE the interrupt notice. The `stop` handler also commits
      // it, but `stop` arrives after this line has already been printed — so the partial answer
      // landed BELOW "⎋ interrupted" and read as a second, post-interrupt reply. Clearing the
      // buffer here makes this the sole commit; `stop` then finds it empty and no-ops.
      if (env.streamBufRef.current.trim()) {
        const display = env.sanitizeAssistantText(env.streamBufRef.current);
        if (display.trim()) {
          env.pushLine({
            kind: 'assistant',
            text: stripTrailingNewlines(display),
            color: C.fg,
            meta: 'assistant',
            tight: env.answerOpenRef.current && !env.padCarryRef.current && !leadsWithBlock(display),
          });
        }
      }
      // F05-06: full flush disarm, mirroring the stop-handler teardown. Esc commits the tail
      // HERE, but the 30ms coalescing flush could still be armed with the same tail — if it
      // fired after this commit, the live slot re-populated and the just-committed text
      // flashed a second time above "⎋ interrupted". Null the pending refs BEFORE setStreamNow
      // (it drops pending too, but the nulls make the disarm explicit), then force both live
      // slots empty. The later `stop` event finds the buffers empty and its commit is a no-op.
      env.streamBufRef.current = '';
      env.thinkBufRef.current = '';
      env.thinkStartedAtRef.current = null;
      env.pendingStreamRef.current = null;
      env.pendingThinkRef.current = null;
      env.setStreamNow('');
      env.setThinkNow('');
      env.answerOpenRef.current = false;
      env.padCarryRef.current = false;
      env.pushLine({ text: '  ⎋ interrupted', dimColor: true });
    } else if (env.queuedTasksRef.current.length > 0) {
      env.setQueued([]);
      env.pushLine({ text: '  queued input cleared', dimColor: true });
    } else if (env.inputRef.current !== '') {
      // Snapshot first: Esc-to-clear was the ONLY kill in the composer that Ctrl+Z could not
      // undo, so a mis-aimed Esc destroyed a long draft outright. Every other kill (word, line,
      // to-end) already pushes undo; this one silently did not.
      env.pushUndo();
      env.setLine('');
    }
    return true;
  }

  // §3.25 — Keybinding resolver: first dispatch for discrete action keys. Migrated here from
  // the old imperative chain: app:redraw (ctrl+l), transcript:toggleFoldLatest (ctrl+o),
  // transcript:toggleTaskList (ctrl+t), plus any user-defined chords. A match with a registered
  // handler consumes the key; everything else (incl. matched but not-yet-migrated actions, and
  // all char-level composer editing) falls through.
  const kbContexts: ContextName[] = [];
  // (A pending approval/question dialog and the model picker are separate owners and always
  // consume, so by here no modal is open — the resolver only sees the normal editing view.
  // Those owners consume their OWN contexts where they run: Confirmation/QuestionDialog in
  // the dialog owner, ModelPicker in the picker owner — F03-03 reachability.)
  if (env.slashMatches(env.inputRef.current, undefined, env.argCtxRef.current ?? undefined, env.customCommandsRef.current).length > 0) {
    kbContexts.push('Autocomplete');
  }
  kbContexts.push('Transcript', 'Chat', 'Global');
  if (env.kbConsume(ch, key, kbContexts)) return true;

  // §3.5 — Slash-command menu: while "/word" has matches it captures ↑/↓/Tab/Enter — including
  // mid-turn, so you can still pick a command while the model works.
  //
  // Suppressed while a round-table is active: the composer belongs to the TABLE then (it routes
  // to seats), and the menu claiming Enter made the feature inescapable — typing the documented
  // exit `/table done` matched the menu, so Enter re-dispatched `/table` through runSlash
  // instead of reaching handleTableInput, which answered with instructions to type the very
  // thing that had just been swallowed. Suppressing the menu lets Enter fall through to the
  // submit path, where the table router already parses `/table done` correctly.
  // F08-04: the key handler recomputes the menu from live refs (not the render `menu`), so the
  // @-mention picker must be recomputed here too or Tab/Enter can't accept a file candidate.
  const keyMentionTok = env.tableRef.current ? null : atMentionToken(env.inputRef.current, env.cursorRef.current);
  const keyMentionMenu: SlashMenuItem[] = keyMentionTok
    ? rankFileCandidates(env.ensureFileList(), keyMentionTok.partial, 8).map((p) => ({
        name: `@${p}`,
        desc: 'file',
        mention: { start: keyMentionTok.start, path: p },
      }))
    : [];
  const menu = keyMentionMenu.length
    ? keyMentionMenu
    : env.tableRef.current
    ? []
    : env.slashMatches(env.inputRef.current, undefined, env.argCtxRef.current ?? undefined, env.customCommandsRef.current);
  if (menu.length > 0) {
    const sel = Math.min(env.menuIndexRef.current, menu.length - 1);
    if (key.upArrow) {
      env.setMenuIndex(Math.max(0, sel - 1));
      return true;
    }
    if (key.downArrow) {
      env.setMenuIndex(Math.min(menu.length - 1, sel + 1));
      return true;
    }
    // Tab autocompletes; Shift+Tab must NOT. Without the guard the slash menu swallowed
    // Shift+Tab and autocompleted instead, so the autonomy ring was unreachable for as long as
    // the menu was open — the one moment a user is most likely to reach for it.
    // F08-04: an @-file candidate — Tab OR Enter inserts the path (replacing the @partial),
    // never runs a command. A trailing space closes the token so the picker dismisses.
    const acceptMention = (item: SlashMenuItem): void => {
      const m = item.mention!;
      const before = env.inputRef.current.slice(0, m.start);
      const after = env.inputRef.current.slice(env.cursorRef.current);
      const insert = `@${m.path} `;
      env.setComposer(before + insert + after, m.start + insert.length);
      env.setMenuIndex(0);
    };
    if ((key.tab && !key.shift) || key.return) {
      if (menu[sel]?.mention) {
        acceptMention(menu[sel]!);
        return true;
      }
    }
    if (key.tab && !key.shift) {
      if (menu[sel]!.hint) return true; // informational row — nothing to complete to
      env.setLine(menu[sel]!.name); // autocomplete to the selected command
      env.setMenuIndex(0);
      return true;
    }
    if (key.return) {
      const item = menu[sel]!;
      // Argument rows are HINTS until the user commits to one: right after "/cmd " (no
      // partial typed, no ↑/↓ navigation) Enter must submit the text as typed — never
      // auto-run the first completion ("/tasks " + Enter firing "clear" would be a
      // destructive surprise). A typed partial or an arrow press = explicit intent.
      const spIdx = env.inputRef.current.indexOf(' ');
      const argPartial = item.base && spIdx >= 0 ? env.inputRef.current.slice(spIdx + 1) : '';
      const argHintOnly = !!item.base && argPartial === '' && sel === 0 && env.menuIndexRef.current === 0;
      // `item.hint` is the other kind of hint: a row with no value at all ("no prior sessions
      // yet"). Running it would fire the bare command, which is not what the row says.
      if (!argHintOnly && !item.hint) {
        // An argument row ("/theme colorblind") resolves to its BASE command; runSlash slices
        // the arg off item.name by the base's name length, so the completed value flows through.
        const cmd = (item.base ? env.findSlashCommand(item.base) : item) ?? item;
        // Mid-turn, a command that isn't live-safe is QUEUED (runs when the turn ends); a
        // live-safe one (/help, /cost, …) and any command when idle runs immediately.
        if (env.runningRef.current && !SLASH_WHILE_RUNNING.has(env.slashDispatchName(cmd))) {
          env.setQueued([...env.queuedTasksRef.current, { text: item.name, kind: 'deferred' }]);
          env.setLine('');
          env.setMenuIndex(0);
        } else {
          env.runSlash(cmd, item.name);
        }
        return true;
      }
      // fall through: submit the composer text verbatim (§8 below)
    }
    // typing / backspace fall through below to re-filter the menu
  }

  // §4 — Tab / Shift+Tab: cycle the working mode (applies live to a running loop too).
  //    Ring (reference-client style): manual → auto-read → auto-edit → full → plan → (wraps).
  //    Plan mode is the last stop; leaving it restarts the ring at the most cautious level.
  if (key.tab) {
    const pm = env.planMode;
    if (pm?.active) {
      pm.exit(); // leave plan mode → back to the start of the autonomy ring
      env.setAutonomy('manual');
      env.loopRef.current?.setAutonomy('manual');
    } else if (pm && env.autonomyRef.current === 'full') {
      pm.enter(); // top of the autonomy ring → step into plan mode
    } else {
      const next = cycleAutonomy(env.autonomyRef.current);
      env.setAutonomy(next);
      env.loopRef.current?.setAutonomy(next);
    }
    return true;
  }

  // §4.5 — Word- and line-wise editing — the readline/macOS set every native text field has.
  // Ink gives us `key` flags plus the raw bytes (rawKeyRef) for the keys it can't express.
  // Sequence notes (macOS Terminal.app + iTerm2 defaults, and what Ink makes of them):
  //   Option+Delete  \x1b\x7f      → key.delete + key.meta      (the user's "delete faster")
  //   Option+←/→     \x1b[1;3D/C or \x1bb / \x1bf → arrow+meta, or input 'b'/'f' + meta
  //   Ctrl+←/→       \x1b[1;5D/C   → arrow + key.ctrl
  //   Home/End       \x1b[H \x1b[F \x1b[1~ \x1b[4~ \x1bOH \x1bOF → NO Ink field at all: raw only
  //   fwd-Delete     \x1b[3~       → Ink collapses onto key.delete (same as Backspace) — raw only
  const rawSeq = env.rawKeyRef.current;
  const editText = env.inputRef.current;
  const editCur = env.cursorRef.current;
  // Shift+Enter via CSI-u / modifyOtherKeys. Ink has no field for it and its parser does not
  // recognise the shape, so without this branch the literal text `[13;2u` was inserted into
  // the draft on any terminal properly configured to send it.
  if (SHIFT_ENTER.test(rawSeq)) {
    env.setComposer(editText.slice(0, editCur) + '\n' + editText.slice(editCur), editCur + 1);
    env.setMenuIndex(0);
    return true;
  }
  const isHome = HOME_KEYS.test(rawSeq);
  const isEnd = END_KEYS.test(rawSeq);
  const isForwardDelete = FORWARD_DELETE.test(rawSeq);
  // Delete word LEFT — Option/Alt+Delete, Ctrl+W, Ctrl+Backspace.
  if (((key.backspace || key.delete) && (key.meta || key.ctrl) && !isForwardDelete) || (key.ctrl && ch === 'w')) {
    env.applyEdit(deleteWordLeft(editText, editCur));
    return true;
  }
  // Delete word RIGHT — Option/Alt+D, or a modified forward-delete.
  if ((key.meta && (ch === 'd' || ch === 'D')) || (isForwardDelete && (key.meta || key.ctrl))) {
    env.applyEdit(deleteWordRight(editText, editCur));
    return true;
  }
  // Forward-delete (the key above the arrows / fn+Delete) and Ctrl+D on a non-empty draft.
  if (isForwardDelete || (key.ctrl && ch === 'd' && editText.length > 0)) {
    env.applyEdit(deleteCharRight(editText, editCur));
    return true;
  }
  // Word motion — Option/Alt or Ctrl with ←/→, and the emacs aliases Option+B / Option+F.
  if ((key.leftArrow || key.rightArrow) && (key.meta || key.ctrl)) {
    env.moveCaret(key.leftArrow ? wordLeft(editText, editCur) : wordRight(editText, editCur));
    return true;
  }
  if (key.meta && (ch === 'b' || ch === 'B')) {
    env.moveCaret(wordLeft(editText, editCur));
    return true;
  }
  if (key.meta && (ch === 'f' || ch === 'F')) {
    env.moveCaret(wordRight(editText, editCur));
    return true;
  }
  // Line ends — Ctrl+A / Ctrl+E and the Home / End keys.
  if (isHome || (key.ctrl && ch === 'a')) {
    env.moveCaret(lineStart(editText, editCur));
    return true;
  }
  if (isEnd || (key.ctrl && ch === 'e')) {
    env.moveCaret(lineEnd(editText, editCur));
    return true;
  }
  // Kills — Ctrl+K to end of line, Ctrl+U to start of line. Both feed the Ctrl+Y kill ring.
  if (key.ctrl && ch === 'k') {
    env.applyEdit(killToLineEnd(editText, editCur));
    return true;
  }
  if (key.ctrl && ch === 'u') {
    env.applyEdit(killToLineStart(editText, editCur));
    return true;
  }
  // Yank — paste back whatever the last kill removed.
  if (key.ctrl && ch === 'y') {
    const kill = env.killRingRef.current;
    if (kill) {
      env.pushUndo();
      env.setComposer(editText.slice(0, editCur) + kill + editText.slice(editCur), editCur + kill.length);
      env.setMenuIndex(0);
    }
    return true;
  }
  // Char motion — Ctrl+B / Ctrl+F (emacs), so a hand already on Ctrl doesn't have to move.
  // Grapheme-safe (F03-05): one press jumps a whole emoji/flag/combining cluster, exactly
  // like the arrow keys below — the old ±1 code-unit move parked the caret inside a
  // surrogate pair and the next insert split the cluster.
  if (key.ctrl && (ch === 'b' || ch === 'f')) {
    env.moveCaret(ch === 'b' ? prevGrapheme(editText, editCur) : nextGrapheme(editText, editCur));
    return true;
  }
  // Undo the last DESTRUCTIVE edit (word/line kills, history swaps) — Ctrl+Z or Ctrl+_.
  if ((key.ctrl && ch === 'z') || rawSeq === '\x1f' || ch === '\x1f') {
    const prev = env.undoRef.current.pop();
    if (prev) env.setComposer(prev.text, prev.cursor);
    return true;
  }

  // §5 — Caret movement within the (possibly multi-row) composer.
  // Inner width must match Composer paint (cols − gutter − page margins).
  const editInner = env.composerInnerWidth();
  if (key.leftArrow) {
    env.moveCaret(prevGrapheme(env.inputRef.current, env.cursorRef.current));
    return true;
  }
  if (key.rightArrow) {
    env.moveCaret(nextGrapheme(env.inputRef.current, env.cursorRef.current));
    return true;
  }

  // §6 — ↑/↓: multi-row drafts move the caret by visual row; history only at the edges
  // (first row + ↑, last row + ↓) or when the draft is a single visual row.
  if (key.upArrow) {
    const text = env.inputRef.current;
    if (!cursorOnFirstRow(text, env.cursorRef.current, editInner)) {
      const goal = env.goalColRef.current ?? cursorToRowCol(text, env.cursorRef.current, editInner).col;
      env.goalColRef.current = goal;
      const next = moveCursorVertical(text, env.cursorRef.current, -1, editInner, goal);
      env.cursorRef.current = next;
      env.setCursor(next);
      return true;
    }
    if (env.historyRef.current.length && env.histIdxRef.current > 0) {
      // Park an unsent draft before stepping off it, so ↑ out of habit can't destroy three
      // paragraphs of spec with no way back (↓ past the newest entry restores it — bash/
      // readline behavior). Only the FIRST step stashes; walking further up must not clobber it.
      if (env.histIdxRef.current === env.historyRef.current.length) env.draftRef.current = env.inputRef.current;
      env.histIdxRef.current -= 1;
      env.setLine(env.historyRef.current[env.histIdxRef.current] ?? '');
    }
    env.goalColRef.current = null; // a history step replaces the text — the goal is meaningless
    return true;
  }
  if (key.downArrow) {
    const text = env.inputRef.current;
    if (!cursorOnLastRow(text, env.cursorRef.current, editInner)) {
      const goal = env.goalColRef.current ?? cursorToRowCol(text, env.cursorRef.current, editInner).col;
      env.goalColRef.current = goal;
      const next = moveCursorVertical(text, env.cursorRef.current, 1, editInner, goal);
      env.cursorRef.current = next;
      env.setCursor(next);
      return true;
    }
    if (env.histIdxRef.current < env.historyRef.current.length) {
      env.histIdxRef.current += 1;
      // Past the newest entry we're back on the user's own unsent draft, not an empty box.
      env.setLine(
        env.histIdxRef.current === env.historyRef.current.length
          ? env.draftRef.current
          : (env.historyRef.current[env.histIdxRef.current] ?? ''),
      );
    }
    env.goalColRef.current = null; // a history step replaces the text — the goal is meaningless
    return true;
  }

  // §7 — Backspace: delete the visual character before the caret. (macOS Delete reports as
  //    key.delete; the real forward-delete key is separated out by raw sequence in §4.5.)
  //    Grapheme-safe: one press removes a whole emoji/flag/combining cluster, never half of it.
  if (key.backspace || key.delete) {
    const c = env.cursorRef.current;
    const s = env.inputRef.current;
    if (c > 0) env.setComposer(s.slice(0, prevGrapheme(s, c)) + s.slice(c), prevGrapheme(s, c));
    env.setMenuIndex(0);
    return true;
  }

  // §8 — Submit — or insert a newline (Shift+Enter / Alt+Enter / trailing `\`).
  if (key.return) {
    // `key.shift` alone is not enough: most terminals send a bare \r for Shift+Enter, and
    // the ones that don't send a CSI-u/modifyOtherKeys sequence Ink reports as neither.
    const shiftEnterRaw = SHIFT_ENTER.test(env.rawKeyRef.current);
    const wantNewline = key.shift || key.meta || shiftEnterRaw || env.inputRef.current.endsWith('\\');
    if (wantNewline) {
      const s = env.inputRef.current;
      const c = env.cursorRef.current;
      // Trailing `\` line-continuation: drop the backslash, insert `\n` at end.
      if (s.endsWith('\\') && !key.shift && !key.meta) {
        const next = s.slice(0, -1) + '\n';
        env.setComposer(next, next.length);
      } else {
        env.setComposer(s.slice(0, c) + '\n' + s.slice(c), c + 1);
      }
      return true;
    }
    const task = env.inputRef.current.trim();
    if (!task && !env.attachmentsRef.current.length) return true; // allow an image-only message
    if (env.modelSwitchingRef.current) {
      env.pushLine({ text: 'Model switch is still initializing — your draft is preserved.', dimColor: true });
      return true;
    }
    if (env.asyncCommandRef.current) {
      if (!task) return true;
      env.setQueued([...env.queuedTasksRef.current, { text: task, kind: queuedTaskKind(env, task) }]);
      env.historyRef.current.push(task);
      env.histIdxRef.current = env.historyRef.current.length;
      env.setLine('');
      env.pushLine({ text: '  queued — model capability check in progress', dimColor: true });
      return true;
    }
    // Collaboration Mode: while a round-table is active, the composer routes to seats instead of
    // starting a normal turn. `/table` START (no table yet) falls through to the slash dispatch below.
    if (env.tableRef.current) {
      if (!task) {
        env.setLine('');
        return true;
      }
      if (env.runningRef.current || env.routeInFlightRef.current) {
        env.pushLine({ text: 'A model is answering — wait for the baton to return, or Esc to interrupt.', dimColor: true });
        env.setLine('');
        return true;
      }
      env.historyRef.current.push(task);
      env.histIdxRef.current = env.historyRef.current.length;
      env.setLine('');
      if (env.vimEnabledRef.current) env.setVimMode('insert');
      env.handleTableInputRef.current?.(task);
      return true;
    }
    // Compaction is REWRITING the shared context — a turn started now would read it mid-rebuild.
    // Queue instead of racing; the queue flushes when compaction finishes.
    if (env.compactingRef.current) {
      env.setQueued([...env.queuedTasksRef.current, { text: task, kind: queuedTaskKind(env, task) }]);
      env.historyRef.current.push(task);
      env.histIdxRef.current = env.historyRef.current.length;
      env.setLine('');
      env.pushLine({ text: '  queued — compaction in progress (Esc cancels it)', dimColor: true });
      return true;
    }
    if (env.runningRef.current) {
      // Informational slash commands run live. State-changing commands remain deferred, but
      // a human message requests a model-only interrupt and resumes at the next safe history
      // boundary (an in-flight tool is allowed to settle first).
      if (task.startsWith('/')) {
        const cmdName = task.split(/\s+/)[0] ?? '';
        const cmd = env.findSlashCommand(cmdName);
        if (cmd && SLASH_WHILE_RUNNING.has(env.slashDispatchName(cmd))) {
          env.runSlash(cmd, task);
          return true;
        }
      }
      if (!task) return true; // image-only can't be queued (attachments flush with the next typed message)
      const kind = queuedTaskKind(env, task);
      // Queue FIRST: requestSteer may unwind the loop synchronously enough for finally to flush.
      env.setQueued([...env.queuedTasksRef.current, { text: task, kind }]);
      env.historyRef.current.push(task);
      env.histIdxRef.current = env.historyRef.current.length;
      env.setLine('');
      if (kind === 'steer') {
        // Ask the CURRENT loop every time. A queued message left over from an earlier loop must
        // not suppress steering a newer active loop. If no loop exists yet we are only waiting
        // for the process run lock: preserve A→B FIFO instead of aborting and silently dropping A.
        const steered = env.loopRef.current?.requestSteer() ?? false;
        env.pushLine({
          text: steered
            ? '  ↪ pending message — steering at the next safe boundary'
            : '  ↪ pending message — queued in order',
          dimColor: true,
        });
      }
      return true;
    }
    if (task.startsWith('/')) {
      const s = env.classifySlash(task, env.customCommandsRef.current);
      if (s.kind === 'command') {
        env.runSlash(s.cmd!, task);
        return true;
      }
      if (s.kind === 'typo') {
        const hint = s.suggestion ? ` Did you mean ${s.suggestion}?` : '';
        env.pushLine({ text: `Unknown command: ${task.split(/\s+/)[0]} —${hint} (type / for the list)`, color: C.red });
        env.setLine('');
        return true;
      }
      // 'message' — a path like /Users/… — fall through and send it to the agent
    }
    if (task === 'exit' || task === 'quit') {
      env.exit();
      return true;
    }
    env.historyRef.current.push(task);
    env.histIdxRef.current = env.historyRef.current.length;
    env.setLine('');
    if (env.vimEnabledRef.current) env.setVimMode('insert'); // next prompt starts ready to type
    env.startTurn(expandPastes(task, env.pastesRef.current));
    env.pastesRef.current = dropConsumedPastes(env.pastesRef.current, task); // F02-06: spent chips leave the registry
    return true;
  }

  // (Mouse clicks are routed to handleMouse in the router's transport layer — see reserved.ts.
  //  They used to be handled further down the chain, unreachably, behind the SGR early return.)

  // §10 — Printable input: insert at the caret (unbracketed pastes land here too).
  if (!key.ctrl && !key.meta && ch) {
    // Strip any accidental CSI mouse fragments glued to typed text, then normalize
    // carriage returns: terminals paste line ends as \r (not \n), which defeated the
    // paste-chip line count and rendered as invisible garbage in the composer. A lone
    // typed Enter arrives as key.return (handled above), so any \r here IS a paste.
    // Control bytes are dropped too: 0x1c–0x1f (Ctrl+\ ] ^ _) fall through every branch of
    // Ink's parser with NO flags set, so they used to splice an invisible C0 byte into the
    // draft — shifting every later caret index and riding out to the provider on submit.
    // Tab and newline survive; nothing else unprintable does.
    const clean = stripSgrMouse(ch).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (!clean) return true;
    env.insertPastable(clean);
    return true;
  }
  return false; // unbound control/meta chord — nothing claimed it
}

export const composerOwner: FocusOwnerHandler = {
  id: 'composer',
  active: () => true, // the fall-through owner is always active
  handle: handleComposer,
};
