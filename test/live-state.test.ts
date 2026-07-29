import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Context } from '../src/agent/context.js';
import { Budget } from '../src/agent/budget.js';
import { PlanModeState } from '../src/agent/planMode.js';

/** Sequence D — state that must track the LIVE session, not the moment of construction. */

const PRICES = { cheap: { input: 1, output: 1 }, dear: { input: 1000, output: 1000 } };

test('D1: Context.setBudget moves the compaction threshold for a live session', () => {
  const ctx = new Context({ contextBudget: 200_000, triggerRatio: 0.9, keepLastTurns: 6 });
  assert.equal(ctx.budget(), 200_000);
  ctx.setBudget(32_000);
  assert.equal(ctx.budget(), 32_000, 'switching onto a small local serve must move the trigger');
  // Nonsense is ignored rather than wedging compaction at 0 (which would compact every turn).
  ctx.setBudget(0);
  ctx.setBudget(Number.NaN);
  ctx.setBudget(-1);
  assert.equal(ctx.budget(), 32_000);
});

test('D1: the /model clamp actually tells the Context, not just the HUD', () => {
  const src = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  const i = src.indexOf('opts.cfg.contextBudget = nextPolicy.contextBudget;');
  assert.ok(i > 0, 'the clamp site exists');
  assert.match(
    src.slice(i, i + 900),
    /context\.setPolicy\(nextPolicy, true\)/,
    'without this the complete live policy stays frozen at construction (including stale provider usage)',
  );
});

test('D2: /clear exits plan mode for REAL, not just in React state', () => {
  const src = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  const i = src.indexOf("setPlanMode({ mode: 'implement' }); // drop any stale plan title");
  assert.ok(i > 0, 'the /clear reset exists');
  assert.match(
    src.slice(Math.max(0, i - 600), i),
    /opts\.planMode\?\.exit\(\)/,
    'setPlanMode alone changed the BADGE while PlanModeState stayed active — plan.block() kept ' +
      'entering the system prompt and every write was denied with no on-screen explanation',
  );
});

test('D2: PlanModeState.exit really deactivates it', () => {
  const pm = new PlanModeState();
  pm.enter();
  assert.equal(pm.active, true);
  assert.match(pm.block(), /.+/, 'an active plan injects a system block');
  pm.exit();
  assert.equal(pm.active, false);
  assert.equal(pm.block(), '', 'and an exited one injects nothing');
});

test('D5: Budget.setModel re-prices for the model actually in use', () => {
  const b = new Budget({ maxIterations: 10 }, 'cheap', PRICES as never, 0);
  b.recordUsage({ inputTokens: 1_000_000, outputTokens: 0 }, 0);
  const afterCheap = b.snapshot(0).costUSD;
  assert.ok(Math.abs(afterCheap - 1) < 1e-9, `1M tokens at $1/M = $1, got ${afterCheap}`);
  // A /model switch or an automatic fallback mid-run.
  b.setModel('dear');
  b.recordUsage({ inputTokens: 1_000_000, outputTokens: 0 }, 0);
  const afterDear = b.snapshot(0).costUSD;
  assert.ok(afterDear - afterCheap > 900, `the second million must cost the DEAR rate, delta was ${afterDear - afterCheap}`);
  // An empty model id is ignored rather than silently zeroing the price table lookup.
  b.setModel('');
  b.recordUsage({ inputTokens: 1_000_000, outputTokens: 0 }, 0);
  assert.ok(b.snapshot(0).costUSD - afterDear > 900, 'still priced as dear');
});

test('D3/D4: compaction and its token count are interruptible and bounded', () => {
  const ctx = readFileSync(new URL('../src/agent/context.ts', import.meta.url), 'utf8');
  assert.match(ctx, /signal\?: AbortSignal/, 'maybeSummarize accepts a signal');
  assert.match(ctx, /if \(signal\?\.aborted\) return false;/, 'and checks it before starting');
  assert.match(ctx, /signal, \/\/ D3/, 'and passes it to provider.send — the round trip ESC must stop');
  assert.match(ctx, /if \(real > this\.lastActualTokens\) this\.lastActualTokens = real;/,
    'a count must never RATCHET the recorded size down and un-trigger compaction');
  assert.match(ctx, /system: countCtx\?\.system/, 'the count includes system…');
  assert.match(ctx, /tools: countCtx\?\.tools/, '…and tools, so it matches the real request');
  const anth = readFileSync(new URL('../src/provider/anthropic.ts', import.meta.url), 'utf8');
  assert.match(anth, /AbortSignal\.timeout\(10_000\)/, 'countTokens is bounded');
});
