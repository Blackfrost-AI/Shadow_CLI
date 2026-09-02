import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatchKey } from '../src/tui/keys/router.js';
import { resolveAction } from '../src/tui/keybindings/resolver.js';
import { fromInkKey, type InkKeyLike } from '../src/tui/keybindings/match.js';
import { buildDefaultBindings } from '../src/tui/keybindings/defaultBindings.js';
import { expandPastes } from '../src/tui/composer.js';
import type { Chord, ContextName } from '../src/tui/keybindings/types.js';
import type { InkKey, KeyEnv } from '../src/tui/keys/types.js';

/**
 * F02-06 follow-up — the paste registry is a SESSION registry. Submitting a chip must leave its
 * entry resolvable, because ↑ recalls the chip text verbatim and a re-run that could not resolve
 * it sent the LITERAL `[Pasted text #N …]` placeholder to the model. The submit paths (composer
 * owner §8 and the queue drain) once dropped the "spent" entries; these pins drive the real
 * dispatch path so the drop can never come back quietly.
 */
const TUI = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
const COMPOSER_OWNER = readFileSync(new URL('../src/tui/keys/composerOwner.ts', import.meta.url), 'utf8');

const key = (over: Partial<InkKey> = {}): InkKey => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, pageDown: false, pageUp: false,
  ...over,
});
const ref = <T>(v: T) => ({ current: v });

/** The real resolver over the default table, with NO handlers registered — so every discrete
 *  Chat action (enter, up) reads as "unmigrated" and falls through to the composer layers. */
function fallThroughKb() {
  const pending: Chord = [];
  return (input: string, k: InkKeyLike, contexts: readonly ContextName[]): boolean => {
    const r = resolveAction(fromInkKey(input, k), contexts, buildDefaultBindings().bindings, pending);
    if (r.type === 'chord_started') { pending.length = 0; pending.push(...r.pending); return true; }
    if (r.type === 'chord_cancelled') pending.length = 0;
    return false;
  };
}

/** Minimal KeyEnv over live refs, wired for the composer owner's submit and history paths. */
function pasteEnv() {
  const input = ref('');
  const cursor = ref(0);
  const started: string[] = [];
  const kbConsume = fallThroughKb();
  const env: KeyEnv = {
    rawChunkRef: ref(''), rawKeyRef: ref(''),
    ctrlCArmedRef: ref(false), ctrlXArmedRef: ref(false),
    pastingRef: ref(false), pasteBufRef: ref(''),
    pendingRef: ref(null), igateRef: ref(null), dialogShownAtRef: ref(0),
    dialogTypeaheadRef: ref(false), autoAnswerEngagedRef: ref(false), autoAnswerSecsRef: ref(null),
    questionIndexRef: ref(0), questionCursorRef: ref({}),
    pickerOpenRef: ref(false), pickerIndexRef: ref(0),
    searchRef: ref(null),
    vimEnabledRef: ref(false), vimModeRef: ref('insert'), vimPendingRef: ref(''),
    vimCountRef: ref(0), vimFindRef: ref(null), vimRegRef: ref(''),
    inputRef: input, cursorRef: cursor, goalColRef: ref(null),
    historyRef: ref([]), histIdxRef: ref(0), draftRef: ref(''), menuIndexRef: ref(0),
    killRingRef: ref(''), undoRef: ref([]),
    pastesRef: ref([{ id: 1, content: 'BIG PASTED BODY', lines: 5 }]),
    attachmentsRef: ref([]), autonomyRef: ref('manual'), argCtxRef: ref(null),
    customCommandsRef: ref([]), tableRef: ref(null), handleTableInputRef: ref(null),
    runningRef: ref(false), controllerRef: ref(null), loopRef: ref(null), queuedTasksRef: ref([]),
    compactingRef: ref(false), compactAbortRef: ref(null),
    streamBufRef: ref(''), thinkBufRef: ref(''), thinkStartedAtRef: ref(null),
    pendingStreamRef: ref(null), pendingThinkRef: ref(null),
    answerOpenRef: ref(false), padCarryRef: ref(false), routeInFlightRef: ref(false),
    modelSwitchingRef: ref(false), asyncCommandRef: ref(false),
    cfg: {}, autoAnswerEnabled: false, composerInnerWidth: () => 72,
    exit() {}, pushLine() {}, setQueued() {}, setCursor() {}, setMenuIndex() {},
    setPickerOpen() {}, setPickerIndex() {}, setVimMode() {}, setAutonomy() {},
    setQuestionCursor() {}, setQuestionIndex() {}, setAutoAnswerSecs() {},
    setStreamNow() {}, setThinkNow() {}, applyEdit() {}, moveCaret() {}, pushUndo() {},
    handleMouse() {}, openExternalEditor() {}, applySearch() {},
    kbConsume, chooseAtQuestion() {}, confirmQuestion() {}, selectModel() {},
    runSlash() {}, startTurn: (t: string) => { started.push(t); }, ensureFileList: () => [],
    slashMatches: () => [], findSlashCommand: () => undefined,
    classifySlash: () => ({ kind: 'message' }), slashDispatchName: (c: { name: string }) => c.name,
    modelRows: () => [], sanitizeAssistantText: (t: string) => t,
    setLine: (v: string) => { input.current = v; },
    setComposer: (v: string, c: number) => { input.current = v; cursor.current = c; },
    insertPastable: (t: string) => { input.current += t; cursor.current = input.current.length; },
  } as unknown as KeyEnv;
  return { env, started, input };
}

const CHIP = '[Pasted text #1 +5 lines]';
const SUBMITTED = `rerun: ${CHIP}`;

test('submitting a paste chip keeps it resolvable for a history re-run', () => {
  const { env, started, input } = pasteEnv();
  input.current = SUBMITTED;
  env.cursorRef.current = SUBMITTED.length;

  dispatchKey(env, '', key({ return: true }));
  assert.equal(started[0], 'rerun: BIG PASTED BODY', 'the first submit splices the stored content');
  assert.equal(env.pastesRef.current.length, 1, 'the registry RETAINS the submitted entry');
  assert.equal(env.historyRef.current[0], SUBMITTED, 'the chip text went to history verbatim');

  // ↑ recalls the entry: the composer reloads the chip text, which still renders as a chip.
  dispatchKey(env, '', key({ upArrow: true }));
  assert.equal(input.current, SUBMITTED, 'the recalled history entry carries the chip again');
  assert.equal(
    expandPastes(input.current, env.pastesRef.current),
    'rerun: BIG PASTED BODY',
    'expandPastes still resolves the recalled chip against the retained registry',
  );

  dispatchKey(env, '', key({ return: true }));
  assert.equal(started[1], 'rerun: BIG PASTED BODY',
    'the re-run splices the content — NOT the literal placeholder');
});

test('neither submit path drops consumed chips, and the cap-prune respects history', () => {
  // The drop is gone from BOTH sites (composer owner §8 and the queue drain).
  assert.doesNotMatch(COMPOSER_OWNER, /dropConsumedPastes/, 'composer owner keeps spent chips');
  assert.doesNotMatch(TUI, /dropConsumedPastes/, 'the queue drain keeps spent chips');
  // The session-registry contract (tui.tsx: "kept for the whole session so a history re-run
  // still resolves the chip") holds above PASTE_CAP too: the prune cites history entries, so a
  // recalled chip survives the cap instead of regressing to the literal placeholder.
  assert.match(
    TUI,
    /prunePastes\(pastesRef\.current, \[inputRef\.current, queuedText, \.\.\.historyRef\.current\]\)/,
    'the insert-site cap-prune keeps history-referenced entries',
  );
});
