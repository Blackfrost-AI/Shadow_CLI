import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChord, parseKeystroke, keystrokeToString } from '../src/tui/keybindings/parser.js';
import { eventToKeystroke, fromInkKey, chordEquals, chordStartsWith } from '../src/tui/keybindings/match.js';
import { resolveAction, resolveKeystroke } from '../src/tui/keybindings/resolver.js';
import { buildDefaultBindings } from '../src/tui/keybindings/defaultBindings.js';
import { checkReserved, isHardcoded } from '../src/tui/keybindings/reserved.js';
import type { KeyEvent, ParsedBinding } from '../src/tui/keybindings/types.js';

const ev = (e: Partial<KeyEvent>): KeyEvent => ({ input: '', ctrl: false, shift: false, meta: false, ...e });

test('parser: modifiers + special keys + single char', () => {
  assert.deepEqual(parseKeystroke('ctrl+k'), { key: 'k', ctrl: true, shift: false, meta: false });
  assert.deepEqual(parseKeystroke('Ctrl+Shift+K'), { key: 'k', ctrl: true, shift: true, meta: false });
  assert.deepEqual(parseKeystroke('opt+tab'), { key: 'tab', ctrl: false, shift: false, meta: true });
  assert.deepEqual(parseKeystroke('pgup'), { key: 'pageup', ctrl: false, shift: false, meta: false });
  assert.equal(parseKeystroke('ctrl+foobar'), null); // unknown multi-char key
  assert.equal(parseKeystroke(''), null);
});

test('parser: chord splits on whitespace; space is a key', () => {
  assert.equal(parseChord('ctrl+x ctrl+k')!.length, 2);
  assert.equal(parseChord('space')![0]!.key, 'space');
  assert.equal(parseChord('ctrl+x   ctrl+k')!.length, 2); // collapsed whitespace
  assert.equal(parseChord(''), null);
});

test('parser: round-trip canonical string', () => {
  assert.equal(keystrokeToString(parseKeystroke('shift+ctrl+k')!), 'ctrl+shift+k');
});

test('match: eventToKeystroke normalizes arrows/specials/letters', () => {
  assert.equal(eventToKeystroke(ev({ upArrow: true })).key, 'up');
  assert.equal(eventToKeystroke(ev({ return: true })).key, 'enter');
  assert.equal(eventToKeystroke(ev({ tab: true, shift: true })).key, 'tab');
  assert.equal(eventToKeystroke(ev({ input: 'o', ctrl: true })).key, 'o');
  assert.equal(eventToKeystroke(ev({ input: 'A', shift: true })).key, 'a');
  assert.equal(eventToKeystroke(ev({ input: ' ' })).key, 'space');
});

test('match: C0 control bytes map to letter+ctrl (Ink delivers Ctrl+T as \\x14)', () => {
  // Real terminal: Ctrl+A=0x01 … Ctrl+Z=0x1a. Without this map, key='\x14' never matches `ctrl+t`.
  const t = eventToKeystroke(fromInkKey('\x14', { ctrl: true }));
  assert.deepEqual(t, { key: 't', ctrl: true, shift: false, meta: false });
  // Some terminals omit the ctrl flag and only send the control byte.
  const o = eventToKeystroke(fromInkKey('\x0f', {}));
  assert.deepEqual(o, { key: 'o', ctrl: true, shift: false, meta: false });
  // Defaults bind ctrl+t → transcript:toggleTaskList — must match the C0 form too.
  const { bindings } = buildDefaultBindings();
  for (const ink of [
    fromInkKey('\x14', { ctrl: true }),
    fromInkKey('\x14', {}),
    fromInkKey('t', { ctrl: true }),
  ]) {
    const r = resolveAction(ink, ['Transcript', 'Chat', 'Global'], bindings, []);
    assert.equal(r.type, 'match', `expected match for ${JSON.stringify(ink)}`);
    if (r.type === 'match') assert.equal(r.action, 'transcript:toggleTaskList');
  }
});

test('match: chordEquals / chordStartsWith', () => {
  const cx = parseChord('ctrl+x')!;
  const cxck = parseChord('ctrl+x ctrl+k')!;
  assert.equal(chordStartsWith(cxck, cx), true);
  assert.equal(chordStartsWith(cx, cxck), false);
  assert.equal(chordEquals(cxck, cx), false);
  assert.equal(chordEquals(cx, parseChord('ctrl+x')!), true);
});

const B: ParsedBinding[] = [
  { context: 'Global', chord: parseChord('ctrl+l')!, action: 'app:redraw' },
  { context: 'Chat', chord: parseChord('enter')!, action: 'chat:submit' },
  { context: 'Chat', chord: parseChord('ctrl+x ctrl+k')!, action: 'chat:killAgents' },
  { context: 'Transcript', chord: parseChord('ctrl+o')!, action: 'transcript:toggleFoldLatest' },
];

test('resolver: exact single-key match', () => {
  const r = resolveKeystroke(parseKeystroke('ctrl+l')!, ['Global', 'Chat'], B, []);
  assert.equal(r.type, 'match');
  if (r.type === 'match') assert.equal(r.action, 'app:redraw');
});

test('resolver: unbound key → none', () => {
  const r = resolveKeystroke(parseKeystroke('ctrl+q')!, ['Global', 'Chat'], B, []);
  assert.equal(r.type, 'none');
});

test('resolver: chord prefix starts a wait and does NOT fire the single-key shadow', () => {
  // ctrl+x is a prefix of ctrl+x ctrl+k → chord_started, even though no single ctrl+x binding exists.
  const r1 = resolveKeystroke(parseKeystroke('ctrl+x')!, ['Global', 'Chat'], B, []);
  assert.equal(r1.type, 'chord_started');
  // completing the chord matches
  const r2 = resolveKeystroke(parseKeystroke('ctrl+k')!, ['Global', 'Chat'], B, (r1.type === 'chord_started' ? r1.pending : []));
  assert.equal(r2.type, 'match');
  if (r2.type === 'match') assert.equal(r2.action, 'chat:killAgents');
});

test('resolver: wrong second key cancels the chord', () => {
  const r1 = resolveKeystroke(parseKeystroke('ctrl+x')!, ['Global', 'Chat'], B, []);
  const pending = r1.type === 'chord_started' ? r1.pending : [];
  const r2 = resolveKeystroke(parseKeystroke('q')!, ['Global', 'Chat'], B, pending);
  assert.equal(r2.type, 'chord_cancelled');
});

test('resolver: context priority — most-specific wins over Global', () => {
  // enter is bound in Chat; with Chat first it matches chat:submit.
  const r = resolveKeystroke(parseKeystroke('enter')!, ['Chat', 'Global'], B, []);
  assert.equal(r.type, 'match');
  if (r.type === 'match') assert.equal(r.action, 'chat:submit');
});

test('resolver: higher-priority exact binding beats lower-priority chord prefix', () => {
  // Chat binds `up` exactly; Global binds a `up up` chord. Pressing `up` once must
  // fire Chat's exact binding, NOT start Global's chord (which would swallow the key).
  const B2: ParsedBinding[] = [
    { context: 'Chat', chord: parseChord('up')!, action: 'chat:historyPrevious' },
    { context: 'Global', chord: parseChord('up up')!, action: 'transcript:scrollUp' },
  ];
  const r = resolveKeystroke(parseKeystroke('up')!, ['Chat', 'Global'], B2, []);
  assert.equal(r.type, 'match');
  if (r.type === 'match') assert.equal(r.action, 'chat:historyPrevious');
});

test('resolver: same-context longer chord still shadows the single-key prefix', () => {
  // Within ONE context, ctrl+x ctrl+k must shadow a ctrl+x exact (the classic rule).
  const B2: ParsedBinding[] = [
    { context: 'Global', chord: parseChord('ctrl+x')!, action: 'global:x' },
    { context: 'Global', chord: parseChord('ctrl+x ctrl+k')!, action: 'global:kill' },
  ];
  const r = resolveKeystroke(parseKeystroke('ctrl+x')!, ['Global'], B2, []);
  assert.equal(r.type, 'chord_started');
});

test('resolver: last binding for a chord wins (user override simulation)', () => {
  const withOverride: ParsedBinding[] = [
    ...B,
    { context: 'Global', chord: parseChord('ctrl+l')!, action: 'user:redraw' },
  ];
  const r = resolveKeystroke(parseKeystroke('ctrl+l')!, ['Global', 'Chat'], withOverride, []);
  assert.equal(r.type, 'match');
  if (r.type === 'match') assert.equal(r.action, 'user:redraw');
});

test('resolver: null action disables (explicit unbind) → none, no dispatch', () => {
  const unbound: ParsedBinding[] = [...B, { context: 'Global', chord: parseChord('ctrl+l')!, action: null }];
  const r = resolveKeystroke(parseKeystroke('ctrl+l')!, ['Global', 'Chat'], unbound, []);
  assert.equal(r.type, 'none');
});

test('resolver: full event path via resolveAction', () => {
  const r = resolveAction(fromInkKey('l', { ctrl: true }), ['Global', 'Chat'], B, []);
  assert.equal(r.type, 'match');
});

test('defaults: parse cleanly and contain expected actions', () => {
  const { bindings, warnings } = buildDefaultBindings();
  assert.equal(warnings.length, 0);
  const actions = new Set(bindings.map((b) => b.action));
  assert.ok(actions.has('chat:submit'));
  assert.ok(actions.has('transcript:toggleFoldLatest'));
  assert.ok(actions.has('transcript:toggleFoldOne'));
  // Confirmation + QuestionDialog ship defaults and are now wired into the live handler.
  assert.ok(actions.has('confirm:yes'));
  assert.ok(actions.has('question:confirm'));
  // MessageActions was removed — per-message nav needed the owned viewport that collapse-to-stock
  // dropped — so none of its actions may linger in the defaults.
  assert.ok(!actions.has('message:copy'));
  assert.ok(!actions.has('message:next'));
  // confirm:previous/confirm:next were dead (plain approval has no list to navigate): removed.
  assert.ok(!actions.has('confirm:previous'));
  assert.ok(!actions.has('confirm:next'));
  // toggleFoldOne must bind to a key the terminal can actually distinguish from ctrl+o.
  // ctrl+shift+o was dead (same 0x0F byte as ctrl+o); it binds to meta+o (Alt/Option+O).
  const foldOne = bindings.find((b) => b.action === 'transcript:toggleFoldOne');
  assert.ok(foldOne && foldOne.chord.length === 1, 'toggleFoldOne is a single-chord binding');
  assert.deepEqual(
    { key: foldOne!.chord[0]!.key, ctrl: foldOne!.chord[0]!.ctrl, shift: foldOne!.chord[0]!.shift, meta: foldOne!.chord[0]!.meta },
    { key: 'o', ctrl: false, shift: false, meta: true },
    'toggleFoldOne is meta+o (distinguishable), not the dead ctrl+shift+o',
  );
  // app:redraw (ctrl+l) was intentionally REMOVED — it re-flushed the whole
  // transcript on every press (O(transcript) perf footgun). It must NOT be a default.
  assert.ok(!actions.has('app:redraw'));
  // ctrl+c must NOT be a default (reserved/hardcoded).
  assert.ok(!bindings.some((b) => b.chord.length === 1 && b.chord[0]!.ctrl && b.chord[0]!.key === 'c'));
});

test('reserved: hardcoded keys reject, terminal shortcuts warn', () => {
  assert.equal(isHardcoded(parseKeystroke('ctrl+c')!), true);
  assert.equal(isHardcoded(parseKeystroke('ctrl+d')!), true);
  assert.equal(isHardcoded(parseKeystroke('ctrl+m')!), true);
  assert.equal(isHardcoded(parseKeystroke('ctrl+l')!), false);
  const z = checkReserved(parseKeystroke('ctrl+z')!);
  assert.equal(z.reserved, true);
  assert.equal(z.severity, 'warn');
  const l = checkReserved(parseKeystroke('ctrl+l')!);
  assert.equal(l.reserved, false);
});
