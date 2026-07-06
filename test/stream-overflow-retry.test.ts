import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeTokenOverflow, shrinkMaxTokens } from '../src/provider/stream.js';

test('looksLikeTokenOverflow detects real over-budget 400 messages', () => {
  // The exact deepseek-r1 (via OpenRouter) message that used to be fatal.
  assert.ok(
    looksLikeTokenOverflow(
      "This endpoint's maximum context length is 64000 tokens. However, you requested about 73772 tokens (5156 of text input, 4616 of tool input, 64000 in the output). Please reduce the length.",
    ),
  );
  assert.ok(looksLikeTokenOverflow('context_length_exceeded: too many tokens'));
  assert.ok(looksLikeTokenOverflow('maximum context length is 8192 tokens'));
  assert.ok(looksLikeTokenOverflow('prompt is too long'));
});

test('looksLikeTokenOverflow does NOT match unrelated 400s (auth, bad param, etc.)', () => {
  assert.ok(!looksLikeTokenOverflow('invalid api key'));
  assert.ok(!looksLikeTokenOverflow('unsupported parameter: temperature'));
  assert.ok(!looksLikeTokenOverflow('model not found'));
});

test('shrinkMaxTokens halves an output cap and floors at 4096; leaves other bodies alone', () => {
  const a: Record<string, unknown> = { model: 'x', max_tokens: 64000 };
  assert.equal(shrinkMaxTokens(a), true);
  assert.equal(a.max_tokens, 32000);
  assert.equal(shrinkMaxTokens(a), true);
  assert.equal(a.max_tokens, 16000);

  const b: Record<string, unknown> = { model: 'x', max_completion_tokens: 5000 };
  assert.equal(shrinkMaxTokens(b), true);
  assert.equal(b.max_completion_tokens, 4096); // floored, not below 4096

  // already at/below the floor → no change, returns false (so the retry loop stops)
  const c: Record<string, unknown> = { model: 'x', max_tokens: 4096 };
  assert.equal(shrinkMaxTokens(c), false);
  assert.equal(c.max_tokens, 4096);

  // nothing to shrink
  assert.equal(shrinkMaxTokens({ model: 'x' }), false);
  assert.equal(shrinkMaxTokens(null), false);
});
