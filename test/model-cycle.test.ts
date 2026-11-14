// Regression contract for 11.7.0 model roles + Ctrl+P cycling (F5, OMP parity):
//   - cycleEntries: allowlist filtering, empty allowlist = all, unknown labels ignored
//   - nextCycleEntry: wrap-around, current-not-in-list, empty/single lists
//   - config.roles parsing; --models flag parsing
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cycleEntries, nextCycleEntry } from '../src/util/modelCycle.js';
import { loadConfig, type ShadowConfig } from '../src/config.js';
import { parseArgs } from '../src/cli/flags.js';

function cfgWith(models: Array<{ label: string; model: string }>): ShadowConfig {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-cycle-'));
  try {
    return loadConfig(dir, {
      models: models.map((m) => ({ label: m.label, provider: 'mock', model: m.model })),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const THREE = [
  { label: 'fast', model: 'm-fast' },
  { label: 'big', model: 'm-big' },
  { label: 'plan', model: 'm-plan' },
];

// ── cycleEntries ──────────────────────────────────────────────────────────────
test('cycleEntries: empty allowlist returns all configured models in order', () => {
  const cfg = cfgWith(THREE);
  assert.deepEqual(cycleEntries(cfg).map((e) => e.label), ['fast', 'big', 'plan']);
  assert.deepEqual(cycleEntries(cfg, []).map((e) => e.label), ['fast', 'big', 'plan']);
});

test('cycleEntries: allowlist filters and preserves config order', () => {
  const cfg = cfgWith(THREE);
  assert.deepEqual(cycleEntries(cfg, ['plan', 'fast']).map((e) => e.label), ['fast', 'plan']);
});

test('cycleEntries: allowlist matching is case-insensitive', () => {
  const cfg = cfgWith(THREE);
  assert.deepEqual(cycleEntries(cfg, ['FAST', 'Big']).map((e) => e.label), ['fast', 'big']);
});

test('cycleEntries: unknown allowlist labels are ignored', () => {
  const cfg = cfgWith(THREE);
  assert.deepEqual(cycleEntries(cfg, ['fast', 'nope']).map((e) => e.label), ['fast']);
  assert.deepEqual(cycleEntries(cfg, ['nope']), []);
});

// ── nextCycleEntry ────────────────────────────────────────────────────────────
test('nextCycleEntry advances and wraps', () => {
  const entries = cycleEntries(cfgWith(THREE));
  assert.equal(nextCycleEntry(entries, 'fast')?.label, 'big');
  assert.equal(nextCycleEntry(entries, 'big')?.label, 'plan');
  assert.equal(nextCycleEntry(entries, 'plan')?.label, 'fast'); // wrap
});

test('nextCycleEntry: current not in list returns first', () => {
  const entries = cycleEntries(cfgWith(THREE), ['fast', 'big']);
  assert.equal(nextCycleEntry(entries, 'plan')?.label, 'fast');
  assert.equal(nextCycleEntry(entries, '')?.label, 'fast');
});

test('nextCycleEntry: empty list returns undefined; single entry is a no-op', () => {
  assert.equal(nextCycleEntry([], 'fast'), undefined);
  const one = cycleEntries(cfgWith(THREE), ['big']);
  assert.equal(nextCycleEntry(one, 'big')?.label, 'big');
});

// ── config.roles ──────────────────────────────────────────────────────────────
test('config.roles defaults to empty and accepts named roles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-roles-'));
  try {
    assert.deepEqual(loadConfig(dir).roles, {});
    const cfg = loadConfig(dir, { roles: { smol: 'fast', plan: 'plan' } });
    assert.equal(cfg.roles.smol, 'fast');
    assert.equal(cfg.roles.plan, 'plan');
    assert.equal(cfg.roles.slow, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── --models flag ─────────────────────────────────────────────────────────────
test('--models parses a comma-separated allowlist', () => {
  const f = parseArgs(['--models', 'fast, big ,plan']);
  assert.deepEqual(f.models, ['fast', 'big', 'plan']);
});

test('--models trims and drops empties; absent flag is undefined', () => {
  assert.deepEqual(parseArgs(['--models', 'fast,,big,']).models, ['fast', 'big']);
  assert.equal(parseArgs([]).models, undefined);
});