import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HELD_BYTES,
  splitStreamToolIntent,
  splitStreamToolIntentCapped,
} from '../src/tui/streamIntent.js';

// P1A-11 — the streaming hot path must be BOUNDED: an envelope marker that never closes must not
// grow the per-token intent rescan quadratically. These tests pin the boundary behavior of the
// pure helpers extracted from tui.tsx (and shared by the Ink shell) without booting React.

test('splitStreamToolIntent splits a textual tool envelope from visible prose', () => {
  const r = splitStreamToolIntent('Answer.\n<tool_call>{"name":"run_shell","arguments":{"command":"echo');
  assert.equal(r.visible, 'Answer.\n');
  assert.equal(r.held, '<tool_call>{"name":"run_shell","arguments":{"command":"echo');
});

test('splitStreamToolIntent holds the textual-call: prefix and patch marker', () => {
  const a = splitStreamToolIntent('Visible.\ncall:run_shell{"command":"echo');
  assert.equal(a.visible, 'Visible.\n');
  assert.ok(a.held.startsWith('call:run_shell'));
  const b = splitStreamToolIntent('note\n*** Begin Patch');
  assert.equal(b.visible, 'note\n');
  assert.equal(b.held, '*** Begin Patch');
});

test('splitStreamToolIntent releases ordinary prose as fully visible', () => {
  const r = splitStreamToolIntent('Just ordinary text, no envelope here.');
  assert.equal(r.visible, 'Just ordinary text, no envelope here.');
  assert.equal(r.held, '');
});

test('splitStreamToolIntentCapped does not cap a resolvable held suffix within budget', () => {
  const text = 'pre\n<tool_call>{"name":"run_shell","arguments":{"command":"echo hi"}}</tool_call>';
  const r = splitStreamToolIntentCapped(text, 128);
  assert.equal(r.visible, 'pre\n');
  assert.equal(r.held, '<tool_call>{"name":"run_shell","arguments":{"command":"echo hi"}}</tool_call>');
});

test('splitStreamToolIntentCapped caps an unresolvable held suffix and releases oldest bytes', () => {
  // A marker that never closes: held grows unbounded without the cap. With a tiny budget the
  // OLDEST held bytes are released back to visible, so visible+held === original text (nothing
  // is dropped) while held stays within budget.
  const open = 'pre\n<tool_call>{"name":"run_shell","arguments":{"command":"echo ';
  const tail = 'x'.repeat(1000) + '}}';
  const text = open + tail;
  const budget = 128;
  const r = splitStreamToolIntentCapped(text, budget);
  assert.ok(r.held.length <= budget, `held must stay within budget, got ${r.held.length}`);
  // No bytes are lost: visible + held reproduces the whole input (cap only relocates overflow).
  assert.equal(r.visible + r.held, text);
  assert.ok(r.visible.length > open.length, 'overflow of the held suffix must have been released as visible');
});

test('splitStreamToolIntentCapped default budget is MAX_HELD_BYTES', () => {
  const text = 'pre\n<tool_call>{"name":"run_shell","arguments":{"command":"echo ' + 'y'.repeat(MAX_HELD_BYTES + 5000);
  const r = splitStreamToolIntentCapped(text);
  assert.ok(r.held.length <= MAX_HELD_BYTES);
  assert.equal(r.visible + r.held, text);
});

// NOTE (P1A-11 close-out, 2026-08-09): the StreamingIntentSplitter class tests were removed with
// the class itself — it was never wired (it could not bound the real quadratic case: a non-tool
// ```python fence passes through it as visible). The stateless bound is pinned instead by
// test/tui-stream-load.test.ts (held cap here + clampLiveRest retained-remainder cap).
