import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PlanModeState } from '../src/agent/planMode.js';
import { UNMIGRATED_ACTIONS } from '../src/tui/keybindings/defaultBindings.js';

/**
 * 1.2 — Plan mode must be toggleable at RUNTIME (Shift+Tab / /plan), not only via the
 * --plan-mode launch flag. The machinery (PlanModeState, bus `plan_mode` event, HUD chip)
 * already existed; these pins lock the three new surfaces (keybinding handler, raw-byte
 * fallback, slash command) and the state-machine semantics, so the toggle cannot silently rot.
 */
const TUI = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
const COMPOSER = readFileSync(new URL('../src/tui/keys/composerOwner.ts', import.meta.url), 'utf8');
const SLASH = readFileSync(new URL('../src/tui/slash.ts', import.meta.url), 'utf8');

test('chat:cycleMode has a registered handler in the TUI', () => {
  // The default Chat binding 'shift+tab' → 'chat:cycleMode' shipped declared-but-unwired — the
  // key fell through to the bare-Tab ring. Registering the handler is what makes it real.
  assert.match(TUI, /kbRegister\('chat:cycleMode'/);
});

test('chat:cycleMode is no longer listed as unmigrated', () => {
  assert.ok(
    !UNMIGRATED_ACTIONS.has('chat:cycleMode'),
    'a registered handler means the loader\'s unmigrated warning would be a lie',
  );
});

test('the raw Shift+Tab fallback runs BEFORE the bare-Tab ring', () => {
  // Terminals that deliver Shift+Tab without Ink's shift flag never match the binding — the
  // raw-byte branch must catch them, and it must run first or `key.tab` would swallow the key
  // into the autonomy ring.
  const fallback = COMPOSER.indexOf('SHIFT_TAB.test(env.rawKeyRef.current)');
  const ring = COMPOSER.indexOf('if (key.tab)');
  assert.notEqual(fallback, -1, 'raw Shift+Tab branch exists in the composer owner');
  assert.notEqual(ring, -1, 'the bare-Tab ring still exists');
  assert.ok(fallback < ring, 'the Shift+Tab branch must precede the bare-Tab ring');
});

test('/plan is advertised, dispatched, and live-safe mid-turn', () => {
  assert.ok(SLASH.includes("name: '/plan'"), 'advertised in SLASH_COMMANDS');
  assert.ok(SLASH.includes("case '/plan':"), 'dispatched by runSlash');
  assert.match(COMPOSER, /SLASH_WHILE_RUNNING = new Set\([^)]*'\/plan'[^)]*\)/, 'runs live while a turn executes');
});

test('PlanModeState.enter/exit toggle and preserve a recorded plan', () => {
  const pm = new PlanModeState(false);
  assert.equal(pm.active, false);
  pm.recordPlan('Demo', '/tmp/demo.md');
  pm.exit();
  assert.equal(pm.active, false);
  pm.enter();
  assert.equal(pm.active, true);
  assert.equal(pm.snapshot().title, 'Demo', 'the recorded plan survives the toggle');
  pm.exit();
  assert.equal(pm.active, false);
  assert.equal(pm.snapshot().title, 'Demo');
});

test('PlanModeState notifies listeners on every toggle (bus → HUD)', () => {
  const pm = new PlanModeState(false);
  const seen: string[] = [];
  const off = pm.onUpdate((s) => seen.push(s.mode));
  pm.enter();
  pm.exit();
  off();
  pm.enter(); // unsubscribed: must not notify
  assert.deepEqual(seen, ['planning', 'implement']);
});

test('plan mode toggles the system-prompt block with the state', () => {
  const pm = new PlanModeState(false);
  assert.equal(pm.block(), '');
  pm.enter();
  assert.match(pm.block(), /## Plan mode/);
  pm.exit();
  assert.equal(pm.block(), '');
});
