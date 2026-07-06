import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubControlTokens } from '../src/util/scrub.js';

test('strips a leaked bare </think> (local-n2)', () => {
  assert.equal(scrubControlTokens('</think>  `log.txt` has 4 lines.'), '`log.txt` has 4 lines.');
});

test('strips channel / tool_call / tool_response tokens (gemma4-opus, ChatML)', () => {
  assert.equal(scrubControlTokens('done<channel|>'), 'done');
  assert.equal(scrubControlTokens('a<tool_call|>b'), 'ab');
  assert.equal(scrubControlTokens('<|tool_response>result'), 'result');
  assert.equal(scrubControlTokens('<|im_start|>assistant<|im_end|>'), 'assistant');
});

test('leaves normal answer text untouched', () => {
  const t = 'Here is the answer: 42. No tokens here.';
  assert.equal(scrubControlTokens(t), t);
});
