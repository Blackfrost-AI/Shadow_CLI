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

test('indented code survives — multi-space runs are NEVER collapsed (regression: code blocks flattened)', () => {
  // The old scrub collapsed `[ \t]{2,}` to one space "for compactness", silently mangling the
  // indented code blocks a local model is most likely to emit. Whitespace is content — only the
  // control token itself goes. (Token placed mid-text: a string-INITIAL token still sheds the
  // whitespace that follows it — that leading strip is deliberate, see the first test above.)
  const code = '  const x = 1;\n    return x;\t// tabbed tail';
  assert.equal(scrubControlTokens(`Here:\n<|im_start|>${code}<|im_end|>`), `Here:\n${code}`);
});
