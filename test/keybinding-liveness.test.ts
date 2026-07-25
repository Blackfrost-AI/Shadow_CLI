import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KEYBINDING_ACTIONS, UNMIGRATED_ACTIONS } from '../src/tui/keybindings/defaultBindings.js';

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
  assert.match(TUI, /key\.ctrl && ch === 'd'/, 'and that handler exists');
});
