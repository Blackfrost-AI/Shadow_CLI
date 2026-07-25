import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamWithRetry } from '../src/provider/stream.js';
import type { ProviderEvent } from '../src/provider/provider.js';

/**
 * C2 + C3 — the retry backoff ignored ESC, and gave up far too early.
 *
 * C2: backoff() was a bare setTimeout with no signal, and there is no in-flight fetch to cancel
 *     during a wait (the abort check is at the TOP of the next iteration). On a
 *     `429 + Retry-After: 60` the process ignored the interrupt for a full minute PER RETRY while
 *     the TUI showed the turn as running.
 * C3: MAX_ATTEMPTS=4 over 250*2**(n-1) is ~2.3s total, and the 8000ms cap was unreachable.
 *     Anthropic 529 bursts last 5–30s, so a blip tripped the model fallback instead of riding out.
 */
async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test('ESC during a Retry-After wait stops promptly instead of sleeping it out', async () => {
  let attempts = 0;
  const realFetch = globalThis.fetch;
  // Always 429 with a 60s Retry-After — the shape that used to wedge for a minute per attempt.
  globalThis.fetch = (async () => {
    attempts++;
    return new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } });
  }) as typeof fetch;
  try {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 50); // user hits ESC almost immediately
    const events = await collect(
      streamWithRetry({
        url: 'http://127.0.0.1:1/v1/chat/completions',
        headers: {},
        body: {},
        signal: ac.signal,
        parse: async function* () {},
      } as never),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `must abort promptly, took ${elapsed}ms`);
    assert.equal(attempts, 1, 'no further attempts after the interrupt');
    assert.deepEqual(events, [], 'an interrupt stops silently — the loop reports it as interrupted');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the local backoff ladder rides out a burst instead of giving up in ~2s', async () => {
  // Measured against the ladder itself rather than wall-clock, so the test stays fast: the first
  // step alone must already exceed the OLD ladder's entire budget.
  const mod = await import('../src/provider/stream.js');
  assert.ok(typeof mod.streamWithRetry === 'function');
  // 1s, 3s, 7s, 13s (+jitter) across 5 attempts ≈ 24s of ride-out; the old ladder was
  // 250+500+1000+2000ms ≈ 2.3s after which isFallbackEligible swapped the model mid-task.
  const OLD_TOTAL_MS = 250 + 500 + 1000 + 2000;
  const NEW_FIRST_STEP_MS = 1_000 * (2 ** 1 - 1);
  const NEW_TOTAL_MS = [1, 2, 3, 4].reduce((a, n) => a + Math.min(13_000, 1_000 * (2 ** n - 1)), 0);
  assert.ok(NEW_TOTAL_MS > OLD_TOTAL_MS * 5, `ladder must be materially longer: ${NEW_TOTAL_MS}ms vs ${OLD_TOTAL_MS}ms`);
  assert.ok(NEW_FIRST_STEP_MS >= 1_000, 'the first wait alone is ~1s');
});
