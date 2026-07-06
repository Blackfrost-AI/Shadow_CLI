import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksAnthropicDistilled, toAnthropicBaseUrl } from '../src/util/transport.js';

test('looksAnthropicDistilled flags Claude/Opus-distilled model names', () => {
  for (const m of ['gemma4-opus', 'claude-opus-4-8', 'foo-claude-distill', 'my-sonnet-ft', 'haiku-coder', 'anthropic-x']) {
    assert.equal(looksAnthropicDistilled(m), true, `${m} should be flagged`);
  }
});

test('looksAnthropicDistilled leaves standard/base models alone', () => {
  for (const m of ['gemma4:12b', 'my-model', 'local-n2', 'glm-4.7-flash', 'qwen3-coder', 'llama-3', 'gpt-4o']) {
    assert.equal(looksAnthropicDistilled(m), false, `${m} should NOT be flagged`);
  }
});

test('toAnthropicBaseUrl strips a trailing /v1 (Anthropic adapter appends /v1/messages)', () => {
  assert.equal(toAnthropicBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  assert.equal(toAnthropicBaseUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434');
  assert.equal(toAnthropicBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
});
