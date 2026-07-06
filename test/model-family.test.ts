import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFamily, looksAnthropicDistilled } from '../src/util/transport.js';

test('modelFamily classifies by maker', () => {
  assert.equal(modelFamily('claude-opus-4-8'), 'anthropic');
  assert.equal(modelFamily('gemma4:12b'), 'google');
  // An opus-DISTILLED gemma reads as 'anthropic' — intentional: it emits Anthropic format, so
  // distill-routing should send it to the Anthropic transport (the dev.21 auto-detect).
  assert.equal(modelFamily('gemma4-opus'), 'anthropic');
  assert.equal(modelFamily('grok-4'), 'grok');
  assert.equal(modelFamily('gpt-5.1'), 'openai');
  assert.equal(modelFamily('o4-mini'), 'openai');
  assert.equal(modelFamily('gemini-flash-latest'), 'google');
  assert.equal(modelFamily('deepseek-chat'), 'deepseek');
  assert.equal(modelFamily('qwen3-coder'), 'qwen');
  assert.equal(modelFamily('llama-3.3-70b'), 'meta');
  assert.equal(modelFamily('mistral-large-latest'), 'mistral');
  assert.equal(modelFamily('some-unknown-model'), 'other');
});

test('looksAnthropicDistilled delegates to modelFamily', () => {
  assert.equal(looksAnthropicDistilled('claude-3.5-sonnet'), true);
  assert.equal(looksAnthropicDistilled('my-opus-distill'), true);
  assert.equal(looksAnthropicDistilled('grok-4'), false);
  assert.equal(looksAnthropicDistilled('gpt-5.1'), false);
});
