import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget } from '../src/agent/budget.js';

/**
 * m-14 security fix (review V2): provider-reported usage is UNTRUSTED input.
 * A hostile endpoint (the "different provider" the operator opted into via an
 * openai-compat advisor) can return negative token counts so the accumulators
 * go negative and `total >= max` never trips — erasing every token and cost
 * cap. recordUsage must reject non-finite values and clamp negatives to zero.
 */
test('negative provider-reported usage is clamped to zero — caps cannot be erased (m-14 V2)', () => {
  const prices = { 'evil-compat': { input: 3, output: 15 } };
  const b = new Budget({ maxIterations: 100, maxTotalTokens: 1000, maxCostUSD: 1 }, 'evil-compat', prices, Date.now());

  // Accrue real spend first, then try to erase it with negative usage:
  b.recordUsage({ inputTokens: 400, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 }, Date.now());
  let snap = b.snapshot(Date.now());
  assert.ok(snap.totalTokens >= 800, 'real usage accrues');

  // Hostile endpoint returns negative usage in every chunk:
  b.recordUsage({ inputTokens: -1_000_000, outputTokens: -1_000_000, cacheReadTokens: -5, cacheWriteTokens: -5 }, Date.now());
  b.recordUsage({ inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY, cacheReadTokens: 0, cacheWriteTokens: 0 }, Date.now());

  snap = b.snapshot(Date.now());
  // The negative/NaN injection must NOT move the accumulators below what was really spent:
  assert.ok(snap.totalTokens >= 800, 'negative usage cannot drag totals below real accrued spend');
  assert.ok(snap.costUSD > 0, 'cost cannot be erased to zero or negative');
});

 test('NaN and Infinity usage are treated as zero, not as free unbounded tokens (m-14 V2b)', () => {
  const prices = { m: { input: 3, output: 15 } };
  const b = new Budget({ maxIterations: 100, maxTotalTokens: 1000 }, 'm', prices, Date.now());
  b.recordUsage({ inputTokens: Number.NaN, outputTokens: Number.NaN, cacheReadTokens: undefined, cacheWriteTokens: undefined } as never, Date.now());
  const snap = b.snapshot(Date.now());
  assert.equal(snap.totalTokens, 0, 'NaN never accrues');
  b.recordUsage({ inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 }, Date.now());
  assert.equal(b.snapshot(Date.now()).totalTokens, 0, 'Infinity is treated as hostile, not as free tokens');
});
