import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { KEYBINDING_ACTIONS, REGISTERED_NON_DEFAULT_ACTIONS, UNMIGRATED_ACTIONS } from '../src/tui/keybindings/defaultBindings.js';
import { mergeKeybindings } from '../src/tui/keybindings/loader.js';

/**
 * B6 — bindings the config docs advertise that do not exist, or cannot take effect.
 *
 * Two distinct failures, both silent:
 *   1. `app:redraw` is the id loader.ts uses as ITS OWN documented example
 *      (`{"ctrl+l": "app:redraw"}`), but Global was `{}` and nothing registered the id — so a
 *      user copying the doc's example got a binding that parsed, warned about nothing, and
 *      never fired.
 *   2. Fourteen more ids are listed and rebindable, but dispatched by KEY in the legacy inline
 *      handler — so rebinding them silently does nothing.
 */
const TUI = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
const registered = new Set(Array.from(TUI.matchAll(/kbRegister\('([^']+)'/g)).map((m) => m[1]!));

test('every advertised action is either registered or explicitly marked unmigrated', () => {
  const orphans = KEYBINDING_ACTIONS.filter((a) => !registered.has(a) && !UNMIGRATED_ACTIONS.has(a));
  assert.deepEqual(orphans, [], `advertised but neither registered nor declared unmigrated: ${orphans.join(', ')}`);
});

test("the loader's own documented example actually works", () => {
  const loader = readFileSync(new URL('../src/tui/keybindings/loader.ts', import.meta.url), 'utf8');
  const example = loader.match(/"([a-z+]+)":\s*"(app:[A-Za-z]+)"/);
  assert.ok(example, 'the doc comment still shows a copy-pasteable example');
  const action = example![2]!;
  assert.ok(registered.has(action), `${action} is documented as an example but never registered`);
  // Deliberately NOT a default: app:redraw re-flushes the whole transcript (O(transcript)), so
  // it is opt-in only. The doc example is a USER config, which is exactly the opt-in case — the
  // handler existing is what makes it work.
  assert.ok(!KEYBINDING_ACTIONS.includes(action), 'and must stay off the default map');
});

test('UNMIGRATED_ACTIONS names only ids that really are unregistered', () => {
  // If someone migrates one and forgets to delete it here, the warning becomes a lie.
  const stale = [...UNMIGRATED_ACTIONS].filter((a) => registered.has(a));
  assert.deepEqual(stale, [], `these ARE registered now — drop them from UNMIGRATED_ACTIONS: ${stale.join(', ')}`);
});

test('rebinding an unmigrated action produces a warning instead of failing silently', () => {
  const loader = readFileSync(new URL('../src/tui/keybindings/loader.ts', import.meta.url), 'utf8');
  assert.match(loader, /UNMIGRATED_ACTIONS\.has\(action\)/, 'the loader checks');
  assert.match(loader, /will not take effect/, 'and says so in plain language');
});

test('reserved.ts describes ctrl+d truthfully', () => {
  const reserved = readFileSync(new URL('../src/tui/keybindings/reserved.ts', import.meta.url), 'utf8');
  // It claimed "hardcoded as quit" — there has never been a ctrl+d quit handler. The composer
  // binds it to forward-delete, which is the real reason it is unrebindable.
  assert.doesNotMatch(reserved, /ctrl\+d is hardcoded as quit/);
  assert.match(reserved, /forward-delete/, 'the stated reason must match the actual handler');
  // P3-01: the reserved-chord handler moved out of tui.tsx into src/tui/keys/reserved.ts.
  const keysReserved = readFileSync(new URL('../src/tui/keys/reserved.ts', import.meta.url), 'utf8');
  assert.match(keysReserved, /key\.ctrl && ch === 'd'/, 'and that handler exists');
});

// ── F03-03: context reachability + dead-context cleanup ─────────────────────

/**
 * The old code pushed 'ModelPicker' onto kbContexts at the BOTTOM of onKey — but the picker
 * branch returns long before that assembly, so ModelPicker bindings could never fire (a dead
 * context). The fix consumes each context where its branch actually runs. These pins lock the
 * consume site of EVERY context that has default bindings, so a context can never silently go
 * dead again: if a branch moves or a consume call is deleted, the pin names the missing site.
 */
test('F03-03: every context with default bindings is consumed inside its own onKey branch', () => {
  // P3-01: the branches moved out of tui.tsx into src/tui/keys/ owner modules; the pins follow
  // the code and now name the exact module each context must be consumed in.
  const composer = readFileSync(new URL('../src/tui/keys/composerOwner.ts', import.meta.url), 'utf8');
  const dialog = readFileSync(new URL('../src/tui/keys/dialogOwner.ts', import.meta.url), 'utf8');
  const picker = readFileSync(new URL('../src/tui/keys/pickerOwner.ts', import.meta.url), 'utf8');
  // Chat + Transcript + Global ride the composer owner's kbContexts assembly.
  assert.match(composer, /kbContexts\.push\('Transcript', 'Chat', 'Global'\)/, 'composer branch consumes Transcript/Chat/Global');
  assert.match(composer, /kbContexts\.push\('Autocomplete'\)/, 'autocomplete consumes its context');
  // Confirmation + QuestionDialog are consumed inside the dialog branch (they return early).
  assert.match(
    dialog,
    /const dialogCtx: ContextName\[\] = kind === 'user_question' \? \['QuestionDialog', 'Global'\] : \['Confirmation', 'Global'\];/,
    'dialog branch consumes Confirmation/QuestionDialog',
  );
  assert.match(dialog, /kbConsume\(ch, key, dialogCtx\)/, 'and actually routes keys through it');
  // ModelPicker is consumed inside the picker branch (it also returns early — the bottom push was dead).
  assert.match(picker, /const pickerCtx: ContextName\[\] = \['ModelPicker', 'Global'\];/, 'picker branch assembles its context');
  assert.match(picker, /kbConsume\(ch, key, pickerCtx\)/, 'and routes keys through it before inline navigation');
});

test('F03-03: the dead kbContexts.push for ModelPicker is gone', () => {
  // It sat after an early-return branch and could never execute — the exact failure shape that
  // made ModelPicker bindings unreachable. If this pattern reappears — in tui.tsx or anywhere
  // under src/tui/keys/ (P3-01's owner modules) — a context is being registered somewhere its
  // keys never arrive.
  // Recursive + .ts/.tsx: the guard claims "anywhere under src/tui/keys/", so a subdirectory or
  // a .tsx module (the codebase's React convention) must not be able to hide the pattern. The
  // argument scan tolerates nested parens (push(f(x), 'ModelPicker')) via a BOUNDED lazy class —
  // an unbounded (?:[^()]*|\([^()]*\))* alternation backtracks catastrophically on these files.
  const keysDir = new URL('../src/tui/keys/', import.meta.url);
  const keys = readdirSync(keysDir, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => readFileSync(new URL(f, keysDir), 'utf8'))
    .join('\n');
  const deadPush = /kbContexts\.push\([\s\S]{0,120}?'ModelPicker'/;
  assert.doesNotMatch(TUI, deadPush);
  assert.doesNotMatch(keys, deadPush);
});

test('F03-03: REGISTERED_NON_DEFAULT_ACTIONS are really registered in the TUI', () => {
  // The loader trusts this list to build KNOWN_ACTION_IDS; if an entry is not actually
  // kbRegister'd, the loader accepts bindings for an action nothing dispatches.
  const stale = REGISTERED_NON_DEFAULT_ACTIONS.filter((a) => !registered.has(a));
  assert.deepEqual(stale, [], `listed as registered but never kbRegister'd: ${stale.join(', ')}`);
});

test('F03-03: a typo\'d action id warns instead of parsing into a dead binding', () => {
  const out = mergeKeybindings([{ context: 'Chat', bindings: { 'ctrl+g': 'chat:submitt' } }]);
  const w = out.warnings.find((x) => x.kind === 'unknown_action' && x.message.includes('chat:submitt'));
  assert.ok(w, `expected an unknown_action warning for the typo — got: ${out.warnings.map((x) => x.message).join(' | ')}`);
});

test('F03-03: inert unbinds warn instead of looking effective', () => {
  // Unbinding a chord whose default action is still dispatched BY KEY changes nothing — say so.
  const inert = mergeKeybindings([{ context: 'Chat', bindings: { enter: null } }]);
  assert.ok(
    inert.warnings.some((x) => x.kind === 'unmigrated' && /has no effect/.test(x.message)),
    `expected an unmigrated "has no effect" warning — got: ${inert.warnings.map((x) => x.message).join(' | ')}`,
  );
  // Unbinding a chord with no default at all unbinds nothing — say that too.
  const ghost = mergeKeybindings([{ context: 'Chat', bindings: { 'ctrl+g': null } }]);
  assert.ok(
    ghost.warnings.some((x) => x.kind === 'unknown_action' && /unbinds nothing/.test(x.message)),
    `expected an "unbinds nothing" warning — got: ${ghost.warnings.map((x) => x.message).join(' | ')}`,
  );
});

test('F03-03: known action ids still parse without warnings', () => {
  // The new warnings must not over-fire: a real, registered action bound to a fresh chord is clean.
  const out = mergeKeybindings([{ context: 'Global', bindings: { 'ctrl+l': 'app:redraw' } }]);
  assert.deepEqual(out.warnings, [], `clean config must warn about nothing — got: ${out.warnings.map((x) => x.message).join(' | ')}`);
});
