import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDefaultBindings } from '../src/tui/keybindings/defaultBindings.js';
import { parseChord } from '../src/tui/keybindings/parser.js';
import { resolveAction } from '../src/tui/keybindings/resolver.js';
import { fromInkKey, type InkKeyLike } from '../src/tui/keybindings/match.js';
import { dispatchKey } from '../src/tui/keys/router.js';
import type { Chord, ContextName, ParsedBinding } from '../src/tui/keybindings/types.js';
import type { InkKey, KeyEnv } from '../src/tui/keys/types.js';

/**
 * 1.3 — one-key model switch. The picker existed behind /model only; this pins the default
 * Ctrl+X M chord, its registered handler (with the mid-turn block), and the emacs-style
 * Ctrl+P/Ctrl+N picker navigation — plus a dispatch-path suite that presses the chord for real,
 * because the data table alone once pinned a chord the reserved Ctrl-X arming starved (the
 * prefix never reached the resolver, so M arrived at the composer as plain text).
 */
const TUI = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
const PICKER = readFileSync(new URL('../src/tui/keys/pickerOwner.ts', import.meta.url), 'utf8');

test('ctrl+x m is a default Chat binding for chat:openModelPicker', () => {
  const { bindings, warnings } = buildDefaultBindings();
  assert.deepEqual(warnings, [], 'default bindings parse cleanly');
  const hit = bindings.find((b) => b.context === 'Chat' && b.action === 'chat:openModelPicker');
  assert.ok(hit, 'the one-key model switch is advertised as a default binding');
  assert.equal(hit!.chord.length, 2, 'it is the two-keystroke ctrl+x m chord');
});

test('the ctrl+x m chord syntax parses as exactly two keystrokes', () => {
  const chord = parseChord('ctrl+x m');
  assert.ok(chord && chord.length === 2, 'parses at all');
  assert.deepEqual(chord![0], { key: 'x', ctrl: true, shift: false, meta: false });
  assert.deepEqual(chord![1], { key: 'm', ctrl: false, shift: false, meta: false });
});

test('chat:openModelPicker has a registered handler that refuses mid-turn', () => {
  const start = TUI.indexOf("kbRegister('chat:openModelPicker'");
  assert.notEqual(start, -1, 'handler is registered in the TUI');
  // While the picker has focus it captures EVERY key — if it could open mid-turn, Esc would
  // close the picker instead of interrupting the running turn. The block is a safety pin.
  const body = TUI.slice(start, start + 700);
  assert.match(body, /runningRef\.current/, 'the handler checks the running turn');
});

test('the picker keeps emacs-style ctrl+p/ctrl+n navigation (omp muscle memory)', () => {
  assert.match(PICKER, /key\.ctrl && ch === 'p'/, 'ctrl+p steps up');
  assert.match(PICKER, /key\.ctrl && ch === 'n'/, 'ctrl+n steps down');
});

// ── Dispatch path: the chord is pressed, not just declared ──────────────────
//
// The tests above pin the DATA TABLE; the ones below press the keys through dispatchKey with a
// REAL resolver (resolveAction over the default bindings, the same contract
// useKeybindings.consume implements). That is the level where the arming starvation lived: the
// table said `ctrl+x m` while the keystroke path typed `m` into the draft.

const key = (over: Partial<InkKey> = {}): InkKey => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, pageDown: false, pageUp: false,
  ...over,
});
const ref = <T>(v: T) => ({ current: v });

/** A real keybinding engine over the default table: resolve + registered-handler dispatch. */
function realKb(bindings: readonly ParsedBinding[] = buildDefaultBindings().bindings) {
  const pending: Chord = [];
  const handlers = new Map<string, () => void>();
  const fired: string[] = [];
  const register = (action: string): void => {
    handlers.set(action, () => { fired.push(action); });
  };
  const consume = (input: string, k: InkKeyLike, contexts: readonly ContextName[]): boolean => {
    const r = resolveAction(fromInkKey(input, k), contexts, bindings, pending);
    if (r.type === 'match') {
      pending.length = 0;
      const h = handlers.get(r.action);
      if (h) { h(); return true; }
      return false; // matched but unregistered → fall through (the unmigrated-action rule)
    }
    if (r.type === 'chord_started') { pending.length = 0; pending.push(...r.pending); return true; }
    if (r.type === 'chord_cancelled') { pending.length = 0; return false; }
    return false;
  };
  return { consume, fired, register };
}

/** Minimal KeyEnv over live refs — the fields the reserved/composer owners touch on these keys. */
function makeEnv(kb: ReturnType<typeof realKb>, over: Record<string, unknown> = {}): KeyEnv {
  const input = ref('');
  const cursor = ref(0);
  const base: Record<string, unknown> = {
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
    killRingRef: ref(''), undoRef: ref([]), pastesRef: ref([]), attachmentsRef: ref([]),
    autonomyRef: ref('manual'), argCtxRef: ref(null), customCommandsRef: ref([]),
    tableRef: ref(null), handleTableInputRef: ref(null),
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
    kbConsume: kb.consume, chooseAtQuestion() {}, confirmQuestion() {}, selectModel() {},
    runSlash() {}, startTurn() {}, ensureFileList: () => [],
    slashMatches: () => [], findSlashCommand: () => undefined,
    classifySlash: () => ({ kind: 'message' }), slashDispatchName: (c: { name: string }) => c.name,
    modelRows: () => [], sanitizeAssistantText: (t: string) => t,
    setLine: (v: string) => { input.current = v; },
    setComposer: (v: string, c: number) => { input.current = v; cursor.current = c; },
    insertPastable: (t: string) => { input.current += t; cursor.current = input.current.length; },
  };
  return Object.assign(base, over) as unknown as KeyEnv;
}

test('ctrl+x then m drives the real dispatch path to chat:openModelPicker', () => {
  const kb = realKb();
  kb.register('chat:openModelPicker');
  const env = makeEnv(kb);
  dispatchKey(env, 'x', key({ ctrl: true })); // arming press — consumed by the reserved layer
  assert.equal(env.ctrlXArmedRef.current, true, 'Ctrl-X armed the editor escape as before');
  dispatchKey(env, 'm', key());
  assert.deepEqual(kb.fired, ['chat:openModelPicker'], 'the advertised chord fires via key dispatch');
  assert.equal(env.inputRef.current, '', 'M is not typed into the draft');
});

test('ctrl+x then c dispatches draft copy without inserting the chord into the draft', () => {
  const kb = realKb();
  kb.register('chat:copyDraft');
  const env = makeEnv(kb);
  env.inputRef.current = 'My original draft';
  dispatchKey(env, 'x', key({ ctrl: true }));
  dispatchKey(env, 'c', key());
  assert.deepEqual(kb.fired, ['chat:copyDraft']);
  assert.equal(env.inputRef.current, 'My original draft');
});

test('the external-editor escape survives the chord seeding, and leaves no stale chord behind', () => {
  const kb = realKb();
  kb.register('chat:openModelPicker');
  let opened = 0;
  const env = makeEnv(kb, { openExternalEditor: () => { opened += 1; } });
  dispatchKey(env, 'x', key({ ctrl: true }));
  dispatchKey(env, 'e', key({ ctrl: true }));
  assert.equal(opened, 1, 'ctrl+x ctrl+e still opens $EDITOR (F08-10 preserved)');
  assert.deepEqual(kb.fired, [], 'the editor chord dispatches no bound action');
  // The pending chord was cancelled with the editor press, not left armed: the next M is text.
  dispatchKey(env, 'm', key());
  assert.deepEqual(kb.fired, [], 'no stale ctrl+x chord hijacks the next keystroke');
  assert.equal(env.inputRef.current, 'm', 'the follow-up M lands in the draft as text');
});

test('a lonely ctrl+x does not eat the next unrelated action chord', () => {
  const kb = realKb();
  kb.register('transcript:toggleFoldLatest');
  const env = makeEnv(kb);
  dispatchKey(env, 'x', key({ ctrl: true }));
  dispatchKey(env, 'o', key({ ctrl: true }));
  assert.deepEqual(kb.fired, ['transcript:toggleFoldLatest'],
    'the cancelled chord clears the prefix, so ctrl+o still resolves');
});

test('a user rebinding of ctrl+x ctrl+e shadows the hardcoded editor escape', () => {
  const bindings: ParsedBinding[] = [
    ...buildDefaultBindings().bindings,
    { context: 'Chat' as ContextName, chord: parseChord('ctrl+x ctrl+e')!, action: 'chat:custom' },
  ];
  const kb = realKb(bindings);
  kb.register('chat:custom');
  let opened = 0;
  const env = makeEnv(kb, { openExternalEditor: () => { opened += 1; } });
  dispatchKey(env, 'x', key({ ctrl: true }));
  dispatchKey(env, 'e', key({ ctrl: true }));
  assert.deepEqual(kb.fired, ['chat:custom'], 'the user binding wins the chord');
  assert.equal(opened, 0, 'the hardcoded escape does not fire on top of it');
});
