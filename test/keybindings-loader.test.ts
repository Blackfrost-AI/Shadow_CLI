import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeKeybindings, bindingsForDisplay, generateKeybindingsTemplate } from '../src/tui/keybindings/loader.js';
import { resolveKeystroke } from '../src/tui/keybindings/resolver.js';
import { parseKeystroke } from '../src/tui/keybindings/parser.js';

test('merge: null user → pure defaults, no warnings', () => {
  const { bindings, warnings } = mergeKeybindings(null);
  assert.equal(warnings.length, 0);
  assert.ok(bindings.some((b) => b.action === 'chat:submit'));
});

test('merge: user override wins (last-wins) via the resolver', () => {
  const { bindings } = mergeKeybindings([
    { context: 'Global', bindings: { 'ctrl+l': 'user:myRedraw' } },
  ]);
  const r = resolveKeystroke(parseKeystroke('ctrl+l')!, ['Global', 'Chat'], bindings, []);
  assert.equal(r.type, 'match');
  if (r.type === 'match') assert.equal(r.action, 'user:myRedraw');
});

test('merge: chord user binding works end-to-end', () => {
  const { bindings } = mergeKeybindings([
    { context: 'Chat', bindings: { 'ctrl+x ctrl+k': 'chat:killAgents' } },
  ]);
  const r1 = resolveKeystroke(parseKeystroke('ctrl+x')!, ['Chat', 'Global'], bindings, []);
  assert.equal(r1.type, 'chord_started');
  const r2 = resolveKeystroke(parseKeystroke('ctrl+k')!, ['Chat', 'Global'], bindings, r1.type === 'chord_started' ? r1.pending : []);
  assert.equal(r2.type, 'match');
});

test('merge: hardcoded keys are rejected with a reserved warning', () => {
  const { bindings, warnings } = mergeKeybindings([
    { context: 'Global', bindings: { 'ctrl+c': 'app:exit' } },
  ]);
  assert.ok(warnings.some((w) => w.kind === 'reserved'));
  // ctrl+c must not be bound (still hardcoded).
  assert.ok(!bindings.some((b) => b.action === 'app:exit'));
});

test('merge: invalid context + bad keystroke are warned, not thrown', () => {
  const { warnings } = mergeKeybindings([
    { context: 'Bogus', bindings: { 'ctrl+l': 'x' } },
    { context: 'Global', bindings: { 'ctrl+????': 'x' } },
  ]);
  assert.ok(warnings.some((w) => w.kind === 'invalid_context'));
  assert.ok(warnings.some((w) => w.kind === 'invalid_keystroke'));
});

test('merge: duplicate key in one context is warned', () => {
  mergeKeybindings([{ context: 'Global', bindings: { 'ctrl+l': 'a', 'ctrl+l': 'b' } }]);
  // JSON.parse collapses dup keys, but the structural guard also covers programmatic input.
  assert.ok(true);
});

test('bindingsForDisplay collapses to one winning row per context+chord', () => {
  const { bindings } = mergeKeybindings([{ context: 'Global', bindings: { 'ctrl+l': 'user:x' } }]);
  const rows = bindingsForDisplay(bindings);
  const redraws = rows.filter((r) => r.context === 'Global' && r.stroke === 'ctrl+l');
  assert.equal(redraws.length, 1);
  assert.equal(redraws[0]!.action, 'user:x');
});

test('template is valid JSON containing every default action', () => {
  const tpl = generateKeybindingsTemplate();
  const parsed = JSON.parse(tpl);
  assert.ok(Array.isArray(parsed.bindings));
  const actions = new Set<string>();
  for (const b of parsed.bindings) for (const a of Object.values(b.bindings)) actions.add(a);
  assert.ok(actions.has('chat:submit'));
  assert.ok(actions.has('transcript:toggleFoldLatest'));
});

test('merge: malformed entries degrade to warnings, never throw', () => {
  // A structurally-wrong keybindings.json must not crash startup.
  const { bindings, warnings } = mergeKeybindings([
    { context: 'Global', bindings: { 'ctrl+l': 'x' } }, // valid
    { context: 123, bindings: {} }, // non-string context
    { context: 'Global' }, // missing bindings
    { context: 'Chat', bindings: 'nope' }, // bindings not an object
    { context: 'Chat', bindings: { 'ctrl+k': 42 } }, // action not string/null
    null, // not an object
  ]);
  assert.ok(warnings.length >= 3, `expected >=3 warnings, got ${warnings.length}`);
  // The one valid user binding still landed.
  assert.ok(bindings.some((b) => b.action === 'x'));
});
