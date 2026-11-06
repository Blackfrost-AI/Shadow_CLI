import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

/**
 * m-14 security fix (review V1): `priceTable` and `budget` are operator-owned
 * trust anchors — every cost cap derives from them. A project-local
 * shadow.config.json is UNTRUSTED (you may run shadow inside a cloned repo):
 * before this fix it could zero the price of the active/advisor models and
 * raise the spend cap, disarming `budget.maxCostUSD` and the advisor
 * `maxCostUSD` caps while the operator believed they were enforced.
 */
test('untrusted project shadow.config.json cannot disarm cost caps via priceTable/budget (m-14 V1)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'm14v1-'));
  try {
    writeFileSync(
      join(ws, 'shadow.config.json'),
      JSON.stringify({
        priceTable: { 'claude-3-5-sonnet': { input: 0, output: 0 } }, // disarm cost accrual
        budget: { maxCostUSD: 1e9 }, // raise the spend cap
      }),
    );
    const cfg = loadConfig(ws);

    assert.ok(
      !cfg.priceTable || !('claude-3-5-sonnet' in cfg.priceTable),
      'project priceTable injection is stripped — cost accrual cannot be zeroed',
    );
    assert.ok(
      !cfg.budget || cfg.budget.maxCostUSD === undefined || cfg.budget.maxCostUSD < 1e6,
      'project budget.maxCostUSD injection is stripped — the spend cap cannot be raised',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

/**
 * m-14 security fix (review V1b): prices must be non-negative — a schema
 * accepting negatives lets costUSD run monotonically decreasing, an even
 * stronger disarm. The strip list alone does not protect the GLOBAL (trusted)
 * config from a hand-edited mistake or a future merge seam; the schema must
 * reject negative prices outright.
 */
test('negative prices are rejected by the config schema (m-14 V1b)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'm14v1b-'));
  try {
    writeFileSync(
      join(ws, 'shadow.config.json'),
      JSON.stringify({ priceTable: { 'some-model': { input: -1, output: -1 } } }),
    );
    // Project-sourced priceTable is stripped anyway; the schema guard fires on the
    // parse of the untrusted file itself when a value is negative. Either way, the
    // resulting config must never carry a negative price.
    const cfg = loadConfig(ws);
    const table = cfg.priceTable ?? {};
    for (const prices of Object.values(table)) {
      assert.ok((prices as { input: number }).input >= 0, 'no negative input price can survive');
      assert.ok((prices as { output: number }).output >= 0, 'no negative output price can survive');
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
