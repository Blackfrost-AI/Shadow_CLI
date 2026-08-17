import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FOCUS_OWNERS, dispatchKey } from '../src/tui/keys/router.js';
import { runTransportsAndReserved } from '../src/tui/keys/reserved.js';
import { dialogOwner } from '../src/tui/keys/dialogOwner.js';
import { pickerOwner } from '../src/tui/keys/pickerOwner.js';
import { searchOwner } from '../src/tui/keys/searchOwner.js';
import { vimOwner } from '../src/tui/keys/vimOwner.js';
import { composerOwner } from '../src/tui/keys/composerOwner.js';
import type { FocusOwnerHandler, InkKey, KeyEnv } from '../src/tui/keys/types.js';

/**
 * P3-01 — acceptance suite for the focus-owner router (replaces the 900-line ordered if-chain).
 *
 * The old chain's bug class was "a branch above swallowed a key it never claimed" (TUI_4.0_PLAN
 * §115: 11 of 38 verified findings, incl. 1 blocker + 4 highs). The router makes precedence
 * DATA — the FOCUS_OWNERS table — and every swallowed-key fix gets a regression pin here, so the
 * class cannot silently come back: if an owner moves, a hoist is re-ordered, or a fall-through
 * is deleted, a pin below names the missing site. Byte-level behavior equivalence is witnessed
 * by the existing TUI suites (type-ahead, paste-vs-modal, composer-keys, vim mode, picker,
 * search) — this file pins the STRUCTURE those behaviors depend on.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const TUI = read('../src/tui.tsx');
const ROUTER = read('../src/tui/keys/router.ts');
const RESERVED = read('../src/tui/keys/reserved.ts');
const DIALOG = read('../src/tui/keys/dialogOwner.ts');
const PICKER = read('../src/tui/keys/pickerOwner.ts');
const SEARCH = read('../src/tui/keys/searchOwner.ts');
const VIM = read('../src/tui/keys/vimOwner.ts');
const COMPOSER = read('../src/tui/keys/composerOwner.ts');

const key = (over: Partial<InkKey> = {}): InkKey => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, pageDown: false, pageUp: false,
  ...over,
});

// The owners all read state through refs, so a factory ref keeps the env minimal.
const ref = <T>(v: T) => ({ current: v }) as any;

/** Minimal KeyEnv for active()/dispatch probes: default state, no-op actions. */
function fakeEnv(over: Partial<Record<string, unknown>> = {}): KeyEnv {
  const base: Record<string, any> = {
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
    inputRef: ref(''), cursorRef: ref(0), goalColRef: ref(null), historyRef: ref([]), histIdxRef: ref(-1),
    draftRef: ref(''), menuIndexRef: ref(0), killRingRef: ref(''), undoRef: ref([]),
    pastesRef: ref([]), attachmentsRef: ref([]), autonomyRef: ref('suggest'),
    argCtxRef: ref(null), customCommandsRef: ref([]), tableRef: ref(null), handleTableInputRef: ref(null),
    runningRef: ref(false), controllerRef: ref(null), loopRef: ref(null), queuedTasksRef: ref([]),
    compactingRef: ref(false), compactAbortRef: ref(null),
    streamBufRef: ref(''), thinkBufRef: ref(''), thinkStartedAtRef: ref(null),
    pendingStreamRef: ref(null), pendingThinkRef: ref(null),
    answerOpenRef: ref(false), padCarryRef: ref(false), routeInFlightRef: ref(false),
    modelSwitchingRef: ref(false), asyncCommandRef: ref(false),
    cfg: {}, autoAnswerEnabled: false, composerInnerWidth: () => 72,
    exit() {}, pushLine() {}, setQueued() {}, setLine() {}, setComposer() {}, setCursor() {},
    setMenuIndex() {}, setPickerOpen() {}, setPickerIndex() {}, setVimMode() {},
    setQuestionCursor() {}, setQuestionIndex() {}, setAutoAnswerSecs() {}, setAutonomy() {},
    insertPastable() {}, setStreamNow() {}, setThinkNow() {}, applyEdit() {}, moveCaret() {},
    pushUndo() {}, handleMouse() {}, openExternalEditor() {}, applySearch() {},
    kbConsume: () => false, chooseAtQuestion() {}, confirmQuestion() {}, selectModel() {},
    runSlash() {}, startTurn() {}, ensureFileList: () => [],
    slashMatches: () => [], findSlashCommand: () => undefined,
    classifySlash: () => ({ kind: 'message' }), slashDispatchName: (c: { name: string }) => c.name,
    modelRows: () => [], sanitizeAssistantText: (t: string) => t,
  };
  return Object.assign(base, over) as unknown as KeyEnv;
}

// ── 1. Owner-table snapshot: precedence is DATA ─────────────────────────────

test('owner-table snapshot pins the dispatch order explicitly (precedence is DATA)', () => {
  // The order is asserted LITERAL-BY-LITERAL — never serialized from the table — so any reorder,
  // insertion, or deletion is a loud test failure, and the fix requires a deliberate review of
  // this file (the table can never drift and quietly take its snapshot with it).
  assert.equal(FOCUS_OWNERS.length, 5, 'exactly five owners');
  assert.equal(FOCUS_OWNERS[0]!.id, 'dialog');
  assert.equal(FOCUS_OWNERS[1]!.id, 'picker');
  assert.equal(FOCUS_OWNERS[2]!.id, 'search');
  assert.equal(FOCUS_OWNERS[3]!.id, 'vim');
  assert.equal(FOCUS_OWNERS[4]!.id, 'composer');
  // The table entries are the owner modules themselves (not wrappers or re-instantiations).
  assert.equal(FOCUS_OWNERS[0], dialogOwner);
  assert.equal(FOCUS_OWNERS[1], pickerOwner);
  assert.equal(FOCUS_OWNERS[2], searchOwner);
  assert.equal(FOCUS_OWNERS[3], vimOwner);
  assert.equal(FOCUS_OWNERS[4], composerOwner);
  // And the source table is the same literal order, so a code edit and this pin cannot diverge
  // silently: router.ts must list them in the pinned order, one per line.
  const iDialog = ROUTER.indexOf('dialogOwner,');
  const iPicker = ROUTER.indexOf('pickerOwner,');
  const iSearch = ROUTER.indexOf('searchOwner,');
  const iVim = ROUTER.indexOf('vimOwner,');
  const iComposer = ROUTER.indexOf('composerOwner,');
  for (const i of [iDialog, iPicker, iSearch, iVim, iComposer]) assert.ok(i >= 0, 'all five owners listed in router.ts');
  assert.ok(iDialog < iPicker && iPicker < iSearch && iSearch < iVim && iVim < iComposer, 'router.ts lists dialog → picker → search → vim → composer');
});

test('dispatch walks the table in order: first active owner wins, false falls through', () => {
  const calls: string[] = [];
  const probe = (id: FocusOwnerHandler['id'], active: boolean, consumes: boolean): FocusOwnerHandler => ({
    id,
    active: () => { calls.push(`active:${id}`); return active; },
    handle: () => { calls.push(`handle:${id}`); return consumes; },
  });
  const env = fakeEnv();
  const ch = 'x', k = key();
  const saved = FOCUS_OWNERS.slice();
  try {
    // Inactive owners are skipped entirely (never even probed for handle).
    (FOCUS_OWNERS as FocusOwnerHandler[]).splice(0, FOCUS_OWNERS.length,
      probe('dialog', false, true), probe('picker', false, true), probe('search', false, true),
      probe('vim', false, true), probe('composer', true, true));
    dispatchKey(env, ch, k);
    assert.deepEqual(calls,
      ['active:dialog', 'active:picker', 'active:search', 'active:vim', 'active:composer', 'handle:composer'],
      'inactive owners are skipped; the always-active composer is the fall-through terminus');

    // A returning-false owner lets the key fall through to the next (vim's structural keys).
    calls.length = 0;
    (FOCUS_OWNERS as FocusOwnerHandler[]).splice(0, FOCUS_OWNERS.length,
      probe('dialog', false, true), probe('picker', false, true), probe('search', false, true),
      probe('vim', true, false), probe('composer', true, true));
    dispatchKey(env, ch, k);
    assert.deepEqual(calls,
      ['active:dialog', 'active:picker', 'active:search', 'active:vim', 'handle:vim', 'active:composer', 'handle:composer'],
      'vim returning false hands the key to the composer; nothing after a consumer runs');

    // A consuming owner stops the walk.
    calls.length = 0;
    (FOCUS_OWNERS as FocusOwnerHandler[]).splice(0, FOCUS_OWNERS.length,
      probe('dialog', true, true), probe('picker', true, true), probe('search', true, true),
      probe('vim', true, true), probe('composer', true, true));
    dispatchKey(env, ch, k);
    assert.deepEqual(calls, ['active:dialog', 'handle:dialog'], 'first active consumer wins, walk stops');
  } finally {
    (FOCUS_OWNERS as FocusOwnerHandler[]).splice(0, FOCUS_OWNERS.length, ...saved);
  }
});

test('composer is the always-active fall-through; vim falls through for INSERT and structural keys', () => {
  const env = fakeEnv();
  assert.equal(composerOwner.active(env, 'a', key()), true, 'composer claims every frame');
  // INSERT mode: the composer handles the key verbatim.
  const envVimInsert = fakeEnv({ vimEnabledRef: ref(true), vimModeRef: ref('insert') });
  assert.equal(vimOwner.active(envVimInsert, 'a', key()), true);
  assert.equal(vimOwner.handle(envVimInsert, 'a', key()), false, 'INSERT keys fall through to the composer');
  // NORMAL mode: a structural key (Enter) falls through; a motion (l) is consumed.
  const envVimNormal = fakeEnv({ vimEnabledRef: ref(true), vimModeRef: ref('normal'), inputRef: ref('ab'), cursorRef: ref(0) });
  assert.equal(vimOwner.handle(envVimNormal, '', key({ return: true })), false, 'Enter is structural — composer keeps it');
  assert.equal(vimOwner.handle(envVimNormal, 'l', key()), true, 'NORMAL motion is consumed by vim');
  // And the source pins the fall-through contract at both sites.
  assert.match(VIM, /INSERT: the composer handles the key/);
  assert.match(VIM, /structural key — the composer keeps it/);
});

test('the Ctrl-R search WAKE resolves at the search slot — above vim, below dialog/picker', () => {
  // Search-open ownership AND the wake chord are both encoded in the search owner's predicate, so
  // Ctrl-R opens search at the search slot's precedence (above vim — a focus owner is consulted
  // before a mode) — the old §2.9-before-§2.92 ordering, now DATA.
  const env = fakeEnv({
    vimEnabledRef: ref(true), vimModeRef: ref('normal'),
    historyRef: ref(['echo hi']), inputRef: ref('draft'),
  });
  assert.equal(searchOwner.active(env, 'r', key({ ctrl: true })), true, 'wake chord claims the keystream');
  assert.equal(vimOwner.active(env, 'r', key({ ctrl: true })), true, 'vim would also be active…');
  // …but search precedes vim in the table, so dispatch reaches search first.
  let opened = false;
  const env2 = fakeEnv({
    vimEnabledRef: ref(true), vimModeRef: ref('normal'),
    historyRef: ref(['echo hi']), inputRef: ref('draft'),
    applySearch: (st: unknown) => { opened = st !== null; },
  });
  dispatchKey(env2, 'r', key({ ctrl: true }));
  assert.equal(opened, true, 'dispatch opened search, not a vim NORMAL-mode chord');
  // Wake preconditions stay honest: no history or a running turn keeps the key for vim/composer.
  assert.equal(searchOwner.active(fakeEnv({ historyRef: ref([]) }), 'r', key({ ctrl: true })), false, 'empty history: no wake');
  assert.equal(searchOwner.active(fakeEnv({ historyRef: ref(['x']), runningRef: ref(true) }), 'r', key({ ctrl: true })), false, 'mid-turn: no wake');
  assert.match(SEARCH, /key\.ctrl && ch === 'r' && env\.historyRef\.current\.length > 0 && !env\.runningRef\.current/);
});

// ── 2. Reserved chords + transports resolve BEFORE routing (P1A-14 shape) ───

test('router source: transports/reserved run first, then the owner walk', () => {
  const iTransports = ROUTER.indexOf('runTransportsAndReserved(env, ch, key)');
  const iWalk = ROUTER.indexOf('for (const owner of FOCUS_OWNERS)');
  assert.ok(iTransports >= 0 && iWalk >= 0, 'dispatchKey has both stages');
  assert.ok(iTransports < iWalk, 'transports and reserved chords resolve BEFORE owner routing');
});

test('onKey is a thin router: no legacy chord or owner logic left inline', () => {
  // The old inline chain is fully extracted; anything left inline is a regression to the if-chain.
  assert.doesNotMatch(TUI, /key\.ctrl && ch === 'c'/, 'Ctrl-C two-stage lives in keys/reserved.ts');
  assert.doesNotMatch(TUI, /key\.ctrl && ch === 'x'/, 'Ctrl-X arming lives in keys/reserved.ts');
  assert.doesNotMatch(TUI, /PASTE_START|PASTE_END/, 'paste marker constants live in keys/reserved.ts');
  assert.doesNotMatch(TUI, /\x1b\[20[01]~/, 'no raw paste-marker bytes left inline either');
  assert.doesNotMatch(TUI, /pickerOpenRef\.current && /, 'picker branch lives in keys/pickerOwner.ts');
  assert.match(TUI, /dispatchKey\(env, ch, key\)/, 'onKey dispatches through the router');
  assert.match(TUI, /import \{ dispatchKey \} from '\.\/tui\/keys\/router\.js'/, 'router is the imported dispatch entry');
});

test('onKey stays under the 150-line P3-01 completion criterion', () => {
  // The criterion is about the KEY HANDLER, not the env literal it builds — measure the callback
  // from its opening line to the matching useCallback close, brace-balanced.
  const start = TUI.indexOf('const onKey = useCallback(');
  assert.ok(start >= 0, 'onKey exists');
  let depth = 0, end = -1, began = false;
  for (let i = start; i < TUI.length; i++) {
    const c = TUI[i];
    if (c === '{') { depth++; began = true; } else if (c === '}') { depth--; }
    if (began && depth === 0) { end = i; break; }
  }
  assert.ok(end > start, 'balanced braces found');
  const lines = TUI.slice(start, end + 1).split('\n').length;
  assert.ok(lines < 150, `onKey must stay under 150 lines — now ${lines}`);
});

// ── 3. The swallowed-key battery — the 11 TUI_4.0 findings stay fixed ───────
// Each pin locks the fix at its NEW home under src/tui/keys/, so a future extraction or reorder
// that resurrects the swallow fails loudly. Ordering pins use source offsets, not regexes.

test('swallow #1: Ctrl-C stays alive over dialog + picker (reserved ABOVE owners)', () => {
  // The fix is the hoist: the Ctrl-C two-stage runs in runTransportsAndReserved, which dispatch
  // calls BEFORE the owner walk. Both modal owners consume every key they see — so if ^C were an
  // owner concern again, it would be dead for the life of either modal, exactly the old blocker.
  assert.match(RESERVED, /if \(key\.ctrl && ch === 'c'\) \{/);
  assert.match(DIALOG, /active: \(env\) => env\.pendingRef\.current !== null/);
  assert.match(PICKER, /active: \(env\) => env\.pickerOpenRef\.current/);
  // Behavioral witness: with a dialog open, first ^C arms the latch and prints the hint — the
  // dialog never sees the key.
  const lines: { text: string }[] = [];
  const env = fakeEnv({
    pendingRef: ref({ call: { name: 'Bash' }, kind: 'confirmation' }),
    ctrlCArmedRef: ref(false),
    pushLine: (l: { text: string }) => lines.push(l),
  });
  dispatchKey(env, 'c', key({ ctrl: true }));
  assert.equal(env.ctrlCArmedRef.current, true, '^C armed the exit latch while a dialog was open');
  assert.ok(lines.some((l) => l.text.includes('press Ctrl-C again')), 'and printed the two-stage hint');
  // Second ^C quits (same hoist), still over the modal.
  let exited = false;
  env.exit = () => { exited = true; };
  dispatchKey(env, 'c', key({ ctrl: true }));
  assert.equal(exited, true, 'second ^C quits even with the dialog open');
});

test('swallow #2: Ctrl-D exit stays alive over modals, BELOW paste assembly', () => {
  // Above owners (exit hatch survives modals — same rationale as ^C), below paste (a literal
  // \x04 inside a bracketed paste can never arm the latch or quit mid-paste). Source offsets pin
  // both orderings in keys/reserved.ts.
  assert.match(RESERVED, /if \(key\.ctrl && ch === 'd' && env\.inputRef\.current\.length === 0\) \{/);
  const iPaste = RESERVED.indexOf('const chp =');
  const iCtrlD = RESERVED.indexOf("if (key.ctrl && ch === 'd' && env.inputRef.current.length === 0)");
  assert.ok(iPaste >= 0 && iCtrlD >= 0, 'both blocks present in reserved.ts');
  assert.ok(iPaste < iCtrlD, 'paste assembly runs BEFORE the Ctrl-D two-stage (\\x04 in a paste cannot arm)');
  const iCtrlC = RESERVED.indexOf("if (key.ctrl && ch === 'c')");
  assert.ok(iCtrlC >= 0 && iCtrlC < iCtrlD, 'Ctrl-C precedes Ctrl-D (shared-latch disarm order unchanged)');
  // Behavioral witness: ^D on an empty composer arms while a picker is open.
  const env = fakeEnv({ pickerOpenRef: ref(true), inputRef: ref(''), ctrlCArmedRef: ref(false) });
  const consumed = runTransportsAndReserved(env, 'd', key({ ctrl: true }));
  assert.equal(consumed, true);
  assert.equal(env.ctrlCArmedRef.current, true, '^D armed over an open picker');
  // …but with text in the draft the key is NOT reserved (forward-delete stays the composer's).
  const env2 = fakeEnv({ inputRef: ref('hi') });
  assert.equal(runTransportsAndReserved(env2, 'd', key({ ctrl: true })), false, 'non-empty draft: composer keeps ^D');
});

test('swallow #3: search Esc-abort beats vim (search slot precedes vim in the table)', () => {
  // While search is open, Esc restores the saved draft and closes search — the vim owner never
  // re-interprets it as a mode switch. The ordering is the table itself (pinned above), and the
  // search owner's open-state Esc handling is locked here.
  assert.match(SEARCH, /key\.escape/, 'search owner handles Esc while open');
  let applied: unknown = 'sentinel';
  const env = fakeEnv({
    searchRef: ref({ query: 'ec', index: 0, saved: 'draft text' }),
    vimEnabledRef: ref(true), vimModeRef: ref('insert'), inputRef: ref('ec…'),
    applySearch: (st: unknown) => { applied = st; },
  });
  assert.equal(searchOwner.active(env, '', key({ escape: true })), true);
  searchOwner.handle(env, '', key({ escape: true }));
  assert.equal(applied, null, 'Esc closed search (applySearch(null)) before vim could see the key');
});

test('swallow #4: Shift+Tab is not swallowed by the slash menu (explicit !shift guard)', () => {
  // Most terminals cannot distinguish Shift+Tab from Tab, so the menu's select key must not claim
  // a shifted press — the guard is the fix, and it lives in the composer owner now.
  assert.match(COMPOSER, /key\.tab && !key\.shift/, 'menu selection requires Tab WITHOUT shift');
  // The guard must sit at the menu's autocomplete site, not merely exist somewhere: the menu-open
  // block precedes both guarded tab checks.
  const iMenu = COMPOSER.indexOf('if (menu.length > 0)');
  const iGuard = COMPOSER.indexOf('key.tab && !key.shift');
  assert.ok(iMenu >= 0 && iGuard > iMenu, 'the !shift guard lives inside the open-menu block');
  // Behavioral witness: with the slash menu OPEN, Shift+Tab must fall through the menu (no
  // autocomplete) and reach the autonomy ring — before the guard, the menu swallowed it and the
  // ring was unreachable for as long as the menu was open.
  let autocompleted: string | null = null;
  let ringReached = false;
  const env = fakeEnv({
    inputRef: ref('/he'), cursorRef: ref(3), autonomyRef: ref('manual'),
    slashMatches: () => [{ name: '/help', desc: 'show help' }],
    setLine: (v: string) => { autocompleted = v; },
    setAutonomy: () => { ringReached = true; },
  });
  dispatchKey(env, '', key({ tab: true, shift: true }));
  assert.equal(autocompleted, null, 'Shift+Tab did NOT autocomplete the menu selection');
  assert.equal(ringReached, true, 'Shift+Tab reached the autonomy ring with the menu open');
});

test('swallow #5: idle Esc pushes undo BEFORE clearing the draft', () => {
  // The old swallow: clear-then-push made undo restore an empty draft. The fix's shape — pushUndo
  // first — is locked in the composer owner's Esc branch.
  const iEsc = COMPOSER.indexOf('if (key.escape)');
  const iPush = COMPOSER.indexOf('env.pushUndo()', iEsc);
  assert.ok(iEsc >= 0 && iPush > iEsc, 'pushUndo() appears in the Esc branch');
  const iClear = COMPOSER.indexOf("env.setLine('')", iEsc);
  assert.ok(iClear > iPush, 'the draft clears only AFTER the undo snapshot');
});

test('swallow #6: /table Enter routes to the table handler, not the mention picker', () => {
  // While a round-table is open, Enter must reach handleTableInput; BOTH menu sources are
  // suppressed for the table so neither can trap the key: the @-mention lookup AND the
  // slash-command menu (typing the documented exit `/table done` matched the slash menu, so Enter
  // re-dispatched `/table` through runSlash instead of reaching the table handler).
  assert.match(COMPOSER, /env\.handleTableInputRef\.current\?\.\(task\)/, 'submit routes to the table handler');
  assert.match(COMPOSER, /env\.tableRef\.current \? null : atMentionToken\(/, 'mention lookup is suppressed while a table is open');
  assert.match(COMPOSER, /env\.tableRef\.current\s*\?\s*\[\]/, 'slash menu is suppressed while a table is open');
  // Behavioral witness: with a table open AND a slash match pending, Enter reaches the table
  // handler with the typed text and never re-dispatches through the slash menu.
  const tableCalls: string[] = [];
  let slashRan = false;
  const env = fakeEnv({
    tableRef: ref({ seats: [] }),
    handleTableInputRef: ref((raw: string) => { tableCalls.push(raw); }),
    inputRef: ref('/table done'), cursorRef: ref(11),
    slashMatches: () => [{ name: '/table', desc: 'round table' }],
    runSlash: () => { slashRan = true; },
  });
  dispatchKey(env, '', key({ return: true }));
  assert.deepEqual(tableCalls, ['/table done'], 'Enter reached the table handler with the typed text');
  assert.equal(slashRan, false, 'Enter did NOT re-dispatch /table through the slash menu');
});

test('swallow #7 (B2): the dialog type-ahead guard ignores in-flight keys as decisions', () => {
  // A key arriving within dialogArmMs of the gate opening is rerouted, never a decision. Both the
  // window check and the arm-ms seam live on the dialog/reserved side of the router now.
  assert.match(DIALOG, /Date\.now\(\) - env\.dialogShownAtRef\.current < dialogArmMs\(\)/);
  assert.match(DIALOG, /import \{ dialogArmMs \} from '\.\/reserved\.js'/);
});

test('swallow #8 (P1A-14): bracketed paste is a transport above the owners — a paste can never decide', () => {
  // The markers are consumed in runTransportsAndReserved (before any owner), the completed paste
  // goes through insertPastable, and nothing under keys/ re-implements marker handling.
  assert.match(RESERVED, /const PASTE_START = '\\x1b\[200~'/);
  assert.match(RESERVED, /const PASTE_END = '\\x1b\[201~'/);
  assert.match(RESERVED, /env\.insertPastable\(content\.replace\(\/\\r\\n\?\/g, '\\n'\)\)/);
  for (const [name, src] of [['dialog', DIALOG], ['picker', PICKER], ['search', SEARCH], ['vim', VIM], ['composer', COMPOSER]] as const) {
    assert.doesNotMatch(src, /\x1b\[20[01]~|PASTE_(?:START|END)/, `${name} owner must not see paste markers`);
  }
  // Behavioral witness A: a whole one-chunk paste with a dialog open inserts via insertPastable
  // and never touches the decision path; \r\n normalizes to \n.
  let insertedA = '';
  const envA = fakeEnv({
    pendingRef: ref({ call: { name: 'Bash' }, kind: 'confirmation' }),
    igateRef: ref({ respond: () => { throw new Error('a paste must never respond to a dialog'); } }),
    insertPastable: (t: string) => { insertedA = t; },
  });
  runTransportsAndReserved(envA, '\x1b[200~yes\r\ny\x1b[201~', key());
  assert.equal(insertedA, 'yes\ny', 'one-chunk paste inserted atomically, \\r\\n normalized');

  // Behavioral witness B: a two-chunk paste. The start marker opens assembly (pastingRef set,
  // content buffered, NOTHING inserted yet) and the end marker drains it (pastingRef cleared,
  // buffer reset, single atomic insert). The multi-chunk shape is the one that stranded
  // pastingRef set → permanent input lockout before P1A-14, so the drain is asserted explicitly.
  let insertedB = '';
  const envB = fakeEnv({ insertPastable: (t: string) => { insertedB += t; } });
  runTransportsAndReserved(envB, '\x1b[200~yes', key());
  assert.equal(envB.pastingRef.current, true, 'start marker opened paste assembly');
  assert.equal(envB.pasteBufRef.current, 'yes', 'content buffered pending the end marker');
  assert.equal(insertedB, '', 'nothing inserts until the paste completes');
  runTransportsAndReserved(envB, 'more\x1b[201~', key());
  assert.equal(insertedB, 'yesmore', 'the completed paste inserted atomically');
  assert.equal(envB.pastingRef.current, false, 'end marker drained paste state');
  assert.equal(envB.pasteBufRef.current, '', 'paste buffer reset');
});

test('swallow #9 (F03-03): ModelPicker bindings are consumed where picker keys actually arrive', () => {
  // The dead bottom-of-onKey push is gone (pinned in keybinding-liveness), and the live consume
  // sits at the TOP of the picker owner — before inline navigation, so user bindings win.
  assert.match(PICKER, /const pickerCtx: ContextName\[\] = \['ModelPicker', 'Global'\];/);
  const iCtx = PICKER.indexOf("const pickerCtx: ContextName[] = ['ModelPicker', 'Global'];");
  const iConsume = PICKER.indexOf('env.kbConsume(ch, key, pickerCtx)');
  assert.ok(iCtx >= 0 && iConsume > iCtx, 'the consume call follows the context assembly');
});

test('swallow #10: the SGR-mouse branch routes to the click handler, not an unconditional swallow', () => {
  // Pre-3.5.2 the mouse branch returned before the click handler could run — dead code. The fix
  // calls handleMouse FIRST and only then consumes the report.
  const iMouse = RESERVED.indexOf('hasSgrMouse(ch)');
  const iHandler = RESERVED.indexOf('env.handleMouse(ch)');
  const iReturn = RESERVED.indexOf('return true', iMouse);
  assert.ok(iMouse >= 0 && iHandler > iMouse, 'handleMouse runs inside the mouse branch');
  assert.ok(iHandler < iReturn, 'the report is consumed only AFTER the click handler had a chance');
});

test('swallow #11: an armed Ctrl-X keeps Ctrl-E out of the move-to-end binding', () => {
  // Ctrl-E with an armed Ctrl-X opens the editor; the composer's Ctrl-E move-to-end never sees
  // it, because the arming machinery resolves in runTransportsAndReserved before routing.
  const iArm = RESERVED.indexOf('if (env.ctrlXArmedRef.current)');
  const iOpen = RESERVED.indexOf('env.openExternalEditor()');
  assert.ok(iArm >= 0 && iOpen > iArm, 'armed Ctrl-X resolves Ctrl-E in reserved.ts');
  let opened = false;
  const env = fakeEnv({ ctrlXArmedRef: ref(true), openExternalEditor: () => { opened = true; } });
  const consumed = runTransportsAndReserved(env, 'e', key({ ctrl: true }));
  assert.equal(consumed, true);
  assert.equal(opened, true, 'armed Ctrl-E opened the editor');
  assert.equal(env.ctrlXArmedRef.current, false, 'and disarmed the latch');
  // A non-Ctrl-E key after arming falls through to normal handling (latch cleared, key free).
  const env2 = fakeEnv({ ctrlXArmedRef: ref(true) });
  assert.equal(runTransportsAndReserved(env2, 'a', key()), false, 'the key after a lonely Ctrl-X is not eaten');
  assert.equal(env2.ctrlXArmedRef.current, false, 'latch cleared for the fall-through key');
});

test('exit-latch disarm: any non-exit key clears an armed Ctrl-C/Ctrl-D latch', () => {
  // The shared latch must not linger — an old press must never make a later one quit.
  const env = fakeEnv({ ctrlCArmedRef: ref(true) });
  runTransportsAndReserved(env, 'a', key());
  assert.equal(env.ctrlCArmedRef.current, false, 'typing a char disarms the latch');
  // A second exit press does NOT disarm (it proceeds to quit).
  const env2 = fakeEnv({ ctrlCArmedRef: ref(true), inputRef: ref('') });
  runTransportsAndReserved(env2, 'd', key({ ctrl: true }));
  assert.equal(env2.ctrlCArmedRef.current, true, '^D while armed stays armed (quit path)');
});
