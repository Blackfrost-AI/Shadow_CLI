import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToastQueue, toastLines, ToastCell, MAX_VISIBLE, DEFAULT_TTL, COALESCE_MS, type Toast } from '../src/app/toast.js';

/** Drive a queue with a fake clock so TTL and coalescing are exact rather than flaky. */
function clocked() {
  let now = 1_000_000;
  return {
    queue: new ToastQueue(),
    advance: (ms: number) => {
      now += ms;
      return now;
    },
    now: () => now,
  };
}

const toast = (over: Partial<Toast> = {}): Toast => ({
  key: 'k',
  level: 'info',
  text: 'hello',
  at: 0,
  repeats: 1,
  ttl: 10,
  ...over,
});

test('a raised toast is live immediately and carries its level and text', () => {
  const c = clocked();
  c.queue.raise({ key: 'a', level: 'ok', text: 'worker finished', now: c.now() });
  const live = c.queue.live(c.now());
  assert.equal(live.length, 1);
  assert.equal(live[0]!.level, 'ok');
  assert.equal(live[0]!.text, 'worker finished');
  assert.equal(live[0]!.repeats, 1);
});

test('a toast expires after its TTL, so notices never become permanent furniture', () => {
  const c = clocked();
  c.queue.raise({ key: 'a', level: 'info', text: 'hello', now: c.now() });
  assert.equal(c.queue.live(c.now() + DEFAULT_TTL - 1).length, 1, 'still live just before TTL');
  assert.equal(c.queue.live(c.now() + DEFAULT_TTL + 1).length, 0, 'gone after TTL');
});

test('at most MAX_VISIBLE toasts render, and the oldest is the one dropped', () => {
  const c = clocked();
  for (let i = 0; i < MAX_VISIBLE + 3; i++) {
    c.queue.raise({ key: `k${i}`, level: 'info', text: `t${i}`, now: c.now() });
    c.advance(10);
  }
  const live = c.queue.live(c.now());
  assert.equal(live.length, MAX_VISIBLE);
  // Documented order is oldest-first, so the newest toast sits last, nearest the status bar, and
  // the stale one is what gets dropped.
  assert.equal(live[live.length - 1]!.text, `t${MAX_VISIBLE + 2}`);
  assert.ok(
    !live.some((t) => t.text === 't0'),
    'the oldest toast must be evicted rather than queued forever',
  );
});

test('repeat raises inside the coalesce window collapse into one row with a count', () => {
  const c = clocked();
  c.queue.raise({ key: 'agent:x', level: 'info', text: 'agent started', now: c.now() });
  c.advance(COALESCE_MS - 100);
  c.queue.raise({ key: 'agent:x', level: 'info', text: 'agent started', now: c.now() });
  const live = c.queue.live(c.now());
  assert.equal(live.length, 1, 'a burst must not stack rows');
  assert.equal(live[0]!.repeats, 2, 'the burst must be visible as a count');
});

test('a repeat outside the coalesce window is a fresh toast, not a resurrected one', () => {
  const c = clocked();
  c.queue.raise({ key: 'k', level: 'info', text: 'x', now: c.now() });
  c.advance(COALESCE_MS + DEFAULT_TTL + 1);
  c.queue.raise({ key: 'k', level: 'info', text: 'x', now: c.now() });
  const live = c.queue.live(c.now());
  assert.equal(live.length, 1);
  assert.equal(live[0]!.repeats, 1, 'a stale entry must not be revived with its old count');
});

test('distinct keys coexist up to the cap', () => {
  const c = clocked();
  c.queue.raise({ key: 'a', level: 'info', text: 'one', now: c.now() });
  c.queue.raise({ key: 'b', level: 'ok', text: 'two', now: c.now() });
  assert.equal(c.queue.live(c.now()).length, 2);
});

test('tick reports whether a repaint is needed, so idle frames are free', () => {
  const c = clocked();
  assert.equal(c.queue.tick(c.now()), false, 'empty queue never asks for a repaint');
  c.queue.raise({ key: 'k', level: 'info', text: 'x', now: c.now() });
  assert.equal(c.queue.tick(c.now()), false, 'a live toast that has not expired needs no repaint');
  assert.equal(c.queue.tick(c.now() + DEFAULT_TTL + 1), true, 'an expiring toast must trigger a repaint');
  assert.equal(c.queue.size, 0, 'expired toasts are dropped, not just hidden');
});

test('clear empties the queue (used on session reset)', () => {
  const c = clocked();
  c.queue.raise({ key: 'k', level: 'info', text: 'x', now: c.now() });
  assert.equal(c.queue.size, 1);
  c.queue.clear();
  assert.equal(c.queue.size, 0);
  assert.deepEqual(c.queue.live(c.now()), []);
});

test('an error toast renders in the error colour, not the info colour', () => {
  // Distinct colours are the only way a one-line notice signals severity at a glance.
  const err = toastLines([toast({ level: 'error', text: 'failed' })], 40);
  const info = toastLines([toast({ level: 'info', text: 'failed' })], 40);
  assert.equal(err.length, 1);
  assert.notEqual(err[0], info[0], 'error and info rows must not render identically');
});

test('each level renders a distinct badge glyph', () => {
  const seen = new Set(['info', 'ok', 'warn', 'error'].map((l) => toastLines([toast({ level: l as Toast['level'] })], 40)[0]));
  assert.equal(seen.size, 4, 'all four levels must be distinguishable');
});

test('a repeat count is rendered only when the toast actually repeated', () => {
  const once = toastLines([toast({ repeats: 1 })], 40)[0]!;
  const many = toastLines([toast({ repeats: 4 })], 40)[0]!;
  assert.ok(!once.includes('×4'));
  assert.ok(many.includes('×4'), `expected a count badge, got ${many}`);
});

test('long toast text is truncated to the row width and never wraps', () => {
  const long = 'x'.repeat(200);
  const lines = toastLines([toast({ text: long })], 20);
  assert.equal(lines.length, 1, 'a toast is always exactly one row');
  // Strip ANSI to measure what the terminal actually shows.
  const visible = lines[0]!.replace(/\u001b\[[0-9;]*m/g, '');
  assert.ok(visible.length <= 20, `row must fit 20 columns, got ${visible.length}`);
});

test('multi-line toast text is flattened so it cannot break the footer layout', () => {
  const lines = toastLines([toast({ text: 'first\nsecond' })], 40);
  assert.equal(lines.length, 1);
  const visible = lines[0]!.replace(/\u001b\[[0-9;]*m/g, '');
  assert.ok(!visible.includes('\n'));
});

test('the cell renders nothing when the queue is empty, so the footer reserves no rows', () => {
  const cell = new ToastCell(() => []);
  assert.deepEqual(cell.render(80), []);
});

test('the cell renders one row per live toast', () => {
  const cell = new ToastCell(() => [toast({ key: 'a', text: 'one' }), toast({ key: 'b', text: 'two' })]);
  assert.equal(cell.render(80).length, 2);
});

test('a very narrow width still yields renderable rows rather than throwing', () => {
  const cell = new ToastCell(() => [toast({ text: 'a rather long message' })]);
  const rows = cell.render(3);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.length > 0);
});

test('toast text is sanitised: a concealed escape from a sub-agent name never reaches the terminal', () => {
  // Regression: sub-agent types and descriptions are model-supplied. A `ESC[8m` (conceal) in one
  // would hide the row's contents on screen while still occupying it. toastLines is the last choke
  // point before the terminal, so it must neutralise escapes regardless of caller discipline.
  const rows = toastLines([toast({ text: '\u001b[8mhidden\u001b[0m visible' })], 60);
  assert.equal(rows.length, 1);
  assert.ok(!rows[0]!.includes('\u001b[8m'), 'conceal sequence must be stripped');
  // SGR we add ourselves for colouring is fine; the untrusted one is not.
  assert.ok(rows[0]!.includes('visible'), 'the legitimate text must survive');
});
