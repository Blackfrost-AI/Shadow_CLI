import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFORT_LEVELS,
  cycleEffort,
  effortDescription,
  effortDirective,
  effortSymbol,
  normalizeEffort,
  effortOrDefault,
  DEFAULT_EFFORT,
} from '../src/agent/effort.js';

test('cycleEffort walks the ring and wraps max → low', () => {
  assert.equal(cycleEffort('low'), 'medium');
  assert.equal(cycleEffort('medium'), 'high');
  assert.equal(cycleEffort('high'), 'xhigh');
  assert.equal(cycleEffort('xhigh'), 'max');
  assert.equal(cycleEffort('max'), 'low');
});

test('normalizeEffort is case-insensitive and rejects junk', () => {
  assert.equal(normalizeEffort('HIGH'), 'high');
  assert.equal(normalizeEffort('  Max '), 'max');
  assert.equal(normalizeEffort('nope'), null);
  assert.equal(normalizeEffort(undefined), null);
  assert.equal(effortOrDefault('nope'), DEFAULT_EFFORT);
  assert.equal(effortOrDefault('low'), 'low');
});

test('effortSymbol returns a glyph for every level', () => {
  for (const l of EFFORT_LEVELS) {
    assert.ok(effortSymbol(l).length > 0);
  }
});

test('effortDescription is non-empty and distinct per level', () => {
  const descs = new Set(EFFORT_LEVELS.map(effortDescription));
  assert.equal(descs.size, EFFORT_LEVELS.length);
});

test('effortDirective is model-agnostic: names the level, explains the style, and tells non-native models to honour it', () => {
  const d = effortDirective('xhigh');
  assert.match(d, /Operating effort: xhigh/);
  // The whole point: models WITHOUT a native effort param must be told to act on it.
  assert.match(d, /models that do not.*this directive IS the signal/i);
  // It must scale guidance (don't burn max effort on a typo).
  assert.match(d, /Scale to the task/i);
  // And it must not contradict faithful reporting.
  assert.match(d, /Report outcomes faithfully/);
});

test('effortDirective differs across levels', () => {
  assert.notEqual(effortDirective('low'), effortDirective('max'));
});
