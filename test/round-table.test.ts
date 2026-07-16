import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveHandle,
  buildSeats,
  resolveTableEntries,
  parseTableInput,
  seatTag,
  MIN_SEATS,
  MAX_SEATS,
} from '../src/tui/roundTable.js';
import type { ModelEntry } from '../src/config.js';

const m = (label: string, model: string, provider: ModelEntry['provider'] = 'openai', extra: Partial<ModelEntry> = {}): ModelEntry =>
  ({ label, model, provider, ...extra }) as ModelEntry;

test('deriveHandle: first alpha run, lowercased, unique', () => {
  const taken = new Set<string>();
  assert.equal(deriveHandle('GROK 4', taken), 'grok');
  taken.add('grok');
  assert.equal(deriveHandle('GLM-4.6', taken), 'glm');
  taken.add('glm');
  // collision → numbered suffix
  assert.equal(deriveHandle('Grok-fast', taken), 'grok2');
  // no alpha → falls back to 'model'
  assert.equal(deriveHandle('4.6', new Set()), 'model');
});

test('buildSeats: assigns handles + cycles colors, never green/orange', () => {
  const seats = buildSeats([m('Grok', 'grok-4'), m('GLM', 'glm-4.6'), m('Claude', 'opus')], ['#c1', '#c2']);
  assert.deepEqual(seats.map((s) => s.handle), ['grok', 'glm', 'claude']);
  assert.deepEqual(seats.map((s) => s.color), ['#c1', '#c2', '#c1']); // cycles
  assert.equal(seatTag(seats[0]!).model, 'openai/grok-4');
  assert.equal(seatTag(seats[0]!).handle, 'grok');
});

test('resolveTableEntries: exact then substring match, dedups, reports misses', () => {
  const models = [m('Grok 4', 'grok-4'), m('GLM', 'glm-4.6'), m('Disabled', 'x', 'openai', { disabled: true })];
  const r = resolveTableEntries(['grok', 'glm-4.6', 'nope'], models);
  assert.deepEqual(r.entries.map((e) => e.model), ['grok-4', 'glm-4.6']);
  assert.deepEqual(r.errors, ['nope']);
  // a disabled model is never matched
  assert.deepEqual(resolveTableEntries(['disabled'], models).errors, ['disabled']);
  // a repeated name does not add a duplicate seat
  assert.equal(resolveTableEntries(['grok', 'grok 4'], models).entries.length, 1);
});

test('parseTableInput: routes only whitelisted handles (the injection guard)', () => {
  const handles = ['grok', 'glm'];
  assert.deepEqual(parseTableInput('@grok why does it OOM?', handles), { kind: 'route', handle: 'grok', question: 'why does it OOM?' });
  // an @mention for a non-seat (e.g. an injected "@shell") never routes
  assert.deepEqual(parseTableInput('@shell rm -rf /', handles), { kind: 'unknownHandle', handle: 'shell' });
  // /pass forwards to a seat; unknown target is rejected
  assert.deepEqual(parseTableInput('/pass glm', handles), { kind: 'pass', handle: 'glm' });
  assert.deepEqual(parseTableInput('/pass nobody', handles), { kind: 'unknownHandle', handle: 'nobody' });
  // end commands
  assert.deepEqual(parseTableInput('/table done', handles), { kind: 'done' });
  assert.deepEqual(parseTableInput('/table', handles), { kind: 'done' });
  assert.deepEqual(parseTableInput('/table end', handles), { kind: 'done' });
  // plain text is a note (M1 hints rather than appending a bare human turn)
  assert.deepEqual(parseTableInput('just thinking out loud', handles), { kind: 'note' });
  // @handle with no question still routes (empty question)
  assert.deepEqual(parseTableInput('@grok', handles), { kind: 'route', handle: 'grok', question: '' });
  // case-insensitive handle
  assert.equal(parseTableInput('@GROK hi', handles).kind, 'route');
});

test('seat count bounds are sane', () => {
  assert.ok(MIN_SEATS === 2 && MAX_SEATS === 4 && MIN_SEATS < MAX_SEATS);
});
