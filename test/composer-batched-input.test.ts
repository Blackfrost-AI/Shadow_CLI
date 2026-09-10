import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchKey } from '../src/tui/keys/router.js';
import type { InkKey, KeyEnv } from '../src/tui/keys/types.js';

const key = (over: Partial<InkKey> = {}): InkKey => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, pageDown: false, pageUp: false, ...over,
});

function envWithDraft(text: string, cur = text.length) {
  const st = { text, cur };
  const env = {
    rawChunkRef: { current: '' }, rawKeyRef: { current: '' },
    ctrlCArmedRef: { current: false }, ctrlXArmedRef: { current: false },
    pastingRef: { current: false }, pasteBufRef: { current: '' },
    pendingRef: { current: null }, igateRef: { current: null }, dialogShownAtRef: { current: 0 },
    dialogTypeaheadRef: { current: false }, autoAnswerEngagedRef: { current: false }, autoAnswerSecsRef: { current: null },
    questionIndexRef: { current: 0 }, questionCursorRef: { current: {} },
    pickerOpenRef: { current: false }, pickerIndexRef: { current: 0 }, searchRef: { current: null },
    vimEnabledRef: { current: false }, vimModeRef: { current: 'insert' }, vimPendingRef: { current: '' },
    vimCountRef: { current: 0 }, vimFindRef: { current: null }, vimRegRef: { current: '' },
    inputRef: { get current() { return st.text; } },
    cursorRef: { get current() { return st.cur; } },
    goalColRef: { current: null }, historyRef: { current: [] as string[] }, histIdxRef: { current: -1 },
    draftRef: { current: '' }, menuIndexRef: { current: 0 }, killRingRef: { current: '' }, undoRef: { current: [] },
    pastesRef: { current: [] }, attachmentsRef: { current: [] }, autonomyRef: { current: 'suggest' },
    argCtxRef: { current: null }, customCommandsRef: { current: [] }, tableRef: { current: null }, handleTableInputRef: { current: null },
    runningRef: { current: false }, controllerRef: { current: null }, loopRef: { current: null }, queuedTasksRef: { current: [] },
    compactingRef: { current: false }, compactAbortRef: { current: null },
    streamBufRef: { current: '' }, thinkBufRef: { current: '' }, thinkStartedAtRef: { current: null },
    pendingStreamRef: { current: null }, pendingThinkRef: { current: null },
    answerOpenRef: { current: false }, padCarryRef: { current: false }, routeInFlightRef: { current: false },
    modelSwitchingRef: { current: false }, asyncCommandRef: { current: false },
    cfg: {}, autoAnswerEnabled: false, composerInnerWidth: () => 72,
    exit() {}, pushLine() {}, setQueued() {}, setLine() {},
    setComposer(t: string, c: number) { st.text = t; st.cur = c; },
    setCursor(c: number) { st.cur = c; },
    setMenuIndex() {}, setPickerOpen() {}, setPickerIndex() {}, setVimMode() {},
    setQuestionCursor() {}, setQuestionIndex() {}, setAutoAnswerSecs() {}, setAutonomy() {},
    insertPastable(t: string) { st.text = st.text.slice(0, st.cur) + t + st.text.slice(st.cur); st.cur += t.length; },
    setStreamNow() {}, setThinkNow() {},
    applyEdit(e: { text: string; cursor: number }) { st.text = e.text; st.cur = e.cursor; },
    moveCaret(c: number) { st.cur = c; },
    pushUndo() {}, handleMouse() {}, openExternalEditor() {}, applySearch() {},
    kbConsume: () => false, chooseAtQuestion() {}, confirmQuestion() {}, selectModel() {},
    runSlash() {}, startTurn() {}, ensureFileList: () => [],
    slashMatches: () => [], findSlashCommand: () => undefined,
    classifySlash: () => ({ kind: 'message' }), slashDispatchName: (c: { name: string }) => c.name,
    modelRows: () => [], sanitizeAssistantText: (t: string) => t,
  };
  return { env: env as unknown as KeyEnv, st };
}

type Case = [label: string, chunk: string, wantText: string, wantCur: number];
const CASES: Case[] = [
  // Type text, then press a key — ONE stdin read. Ink dispatched a single keypress for the chunk
  // whose `key` object describes the FIRST token, so the trailing key was never routed: the
  // composer inserted its bytes as text ("abc[D") and the key was lost.
  ['text + Left arrow', 'abc\x1b[D', 'abc', 2],
  ['text + Right arrow (already at end)', 'ab\x1b[C', 'ab', 2],
  ['text + Backspace', 'abc\x7f', 'ab', 2],
  ['held Left (two sequences in one read)', 'abc\x1b[D\x1b[D', 'abc', 1],
  ['text + Home', 'abc\x1b[H', 'abc', 0],
  ['text + End after Home', 'abc\x1b[H\x1b[F', 'abc', 3],
  ['text + forward-delete', 'abc\x1b[D\x1b[3~', 'ab', 2],
  ['text + Option+Left (word motion)', 'foo bar\x1b[1;3D', 'foo bar', 4],
  ['text + Shift+Enter', 'ab\x1b[13;2u', 'ab\n', 3],
  // A key Ink did NOT recognise used to reach the insert branch with its escape stripped and its
  // parameter bytes typed as literal text. Consuming an unbound key beats rewriting it as text.
  ['unhandled sequence is consumed, not typed', '\x1b[D', '', 0],
];

test('a key coalesced with typed text in one stdin read is APPLIED, not typed as text', () => {
  for (const [label, chunk, wantText, wantCur] of CASES) {
    const { env, st } = envWithDraft('', 0);
    dispatchKey(env, chunk, key());
    assert.equal(st.text, wantText, `${label}: draft`);
    assert.equal(st.cur, wantCur, `${label}: caret`);
  }
});

test('a chunk of plain text is untouched by the sequence path', () => {
  const { env, st } = envWithDraft('', 0);
  dispatchKey(env, 'hello world', key());
  assert.equal(st.text, 'hello world');
  assert.equal(st.cur, 11);
});

test('a chunk flagged as a paste body is never routed through the sequence path', () => {
  // The paste flag gates the split for the same reason batchedTextReturn is gated: inside a paste
  // body those bytes are CONTENT. The bracketed-paste transport above normally claims such a chunk
  // outright (buffering it), so what this pins is that the composer adds no SECOND interpretation:
  // the DEL must not act as a deletion against the draft.
  const pasted = envWithDraft('XY', 2);
  pasted.env.pastingRef.current = true;
  dispatchKey(pasted.env, 'a\x7fb', key());
  assert.equal(pasted.st.text, 'XY', 'the pasted bytes never edit the draft');

  // With the flag clear (a real keystroke batch, not a paste) the very same bytes DO edit, and the
  // trailing DEL removes the character typed ahead of it in the same read.
  const typed = envWithDraft('XY', 2);
  dispatchKey(typed.env, 'a\x7fb', key());
  // Order is preserved: 'a' is typed, the DEL removes it, then 'b' is typed.
  assert.equal(typed.st.text, 'XYb', 'the DEL deletes the character typed before it in the read');
  assert.equal(typed.st.cur, 3);
});

test('text after a paste-end marker in the same read is kept, not dropped', () => {
  // `\x1b[200~pasted\x1b[201~tail`: the text BEFORE the start marker was already preserved (and
  // still is), but the remainder past the closing marker was discarded — so a keystroke the
  // terminal coalesced with the marker silently vanished. Both sides of a paste belong to the
  // draft; a key sequence riding along is applied, not typed.
  const { env, st } = envWithDraft('', 0);
  dispatchKey(env, '\x1b[200~pasted\x1b[201~tail', key());
  assert.equal(st.text, 'pastedtail', 'both sides of the paste survive');

  const withKey = envWithDraft('', 0);
  dispatchKey(withKey.env, '\x1b[200~body\x1b[201~ab\x1b[D', key());
  assert.equal(withKey.st.text, 'bodyab', 'the trailing text lands');
  assert.equal(withKey.st.cur, 5, 'and the coalesced Left arrow is applied to the caret');
});
