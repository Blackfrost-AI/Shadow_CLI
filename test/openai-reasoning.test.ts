import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOpenAIReasoningModel,
  isReasoningModel,
  isDeepSeekReasoner,
  isQwenReasoner,
  toReasoningEffort,
  buildOpenAIBody,
  parseOpenAISSE,
} from '../src/provider/openai.js';
import type { CompletionRequest, ProviderEvent } from '../src/provider/provider.js';

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const l of lines) yield l;
}
async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const req = (model: string, maxOutputTokens = 8192, effort: CompletionRequest['effort'] = 'high'): CompletionRequest => ({
  model,
  system: 's',
  messages: [],
  tools: [],
  maxOutputTokens,
  effort,
});

test('isOpenAIReasoningModel: GPT-5 family + o-series, excluding gpt-5-chat', () => {
  for (const m of ['gpt-5', 'gpt-5.2-codex', 'gpt-5-mini', 'o3', 'o4-mini', 'o1']) {
    assert.equal(isOpenAIReasoningModel(m), true, m);
  }
  for (const m of ['gpt-4o', 'gpt-5-chat', 'grok-4', 'claude-opus-4-8', 'gpt-4.1-mini']) {
    assert.equal(isOpenAIReasoningModel(m), false, m);
  }
});

test('isReasoningModel: one gate covering every hidden-reasoning family', () => {
  for (const m of ['gpt-5.1', 'o3', 'o4-mini', 'grok-3-mini', 'grok-4-fast-reasoning', 'gemini-flash-latest', 'gemini-2.5-pro', 'deepseek-reasoner', 'deepseek-r1', 'DeepSeek-R1-Distill-Qwen-32B', 'qwq-32b', 'qwen3-235b-think']) {
    assert.equal(isReasoningModel(m), true, m);
  }
  for (const m of ['gpt-4o', 'gpt-5-chat', 'grok-4-fast-non-reasoning', 'gemma4:12b', 'deepseek-chat', 'qwen3-coder', 'claude-opus-4-8', 'llama-3.3-70b']) {
    assert.equal(isReasoningModel(m), false, m);
  }
  assert.equal(isDeepSeekReasoner('deepseek-chat'), false);
  assert.equal(isQwenReasoner('qwen3-coder'), false);
});

test('toReasoningEffort collapses Shadow effort to OpenAI 3-level', () => {
  assert.equal(toReasoningEffort('low'), 'low');
  assert.equal(toReasoningEffort('medium'), 'medium');
  assert.equal(toReasoningEffort('high'), 'high');
  assert.equal(toReasoningEffort('xhigh'), 'high');
  assert.equal(toReasoningEffort('max'), 'high');
  assert.equal(toReasoningEffort(undefined), 'high');
});

test('reasoning model body: max_completion_tokens (floored to MAX) + reasoning_effort, NO max_tokens', () => {
  const body = buildOpenAIBody(req('gpt-5.2-codex', 4000, 'max'), 'fallback');
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.max_completion_tokens, 64_000); // floored up from 4000
  assert.equal(body.reasoning_effort, 'high');
});

test('reasoning model body honors a larger explicit cap', () => {
  const body = buildOpenAIBody(req('o3', 100_000, 'low'), 'fallback'); // > the 64k floor
  assert.equal(body.max_completion_tokens, 100_000);
  assert.equal(body.reasoning_effort, 'low');
});

test('every max_tokens reasoning family is floored to MAX; non-reasoners are not', () => {
  // Gemini, Grok-reasoning, DeepSeek-R1, Qwen-QwQ all floor to 64k via the one isReasoningModel gate.
  assert.equal(buildOpenAIBody(req('gemini-flash-latest', 8192), 'fb').max_tokens, 64_000);
  assert.equal(buildOpenAIBody(req('grok-3-mini', 8192), 'fb').max_tokens, 64_000);
  assert.equal(buildOpenAIBody(req('deepseek-reasoner', 8192), 'fb').max_tokens, 64_000);
  assert.equal(buildOpenAIBody(req('qwq-32b', 8192), 'fb').max_tokens, 64_000);
  assert.equal(buildOpenAIBody(req('gemini-2.5-pro', 100_000), 'fb').max_tokens, 100_000); // larger cap wins
  // Not floored: plain chat models (different families / non-reasoning variants).
  assert.equal(buildOpenAIBody(req('gemma4:12b', 8192), 'fb').max_tokens, 8192);
  assert.equal(buildOpenAIBody(req('deepseek-chat', 8192), 'fb').max_tokens, 8192);
  assert.equal(buildOpenAIBody(req('grok-4-fast-non-reasoning', 8192), 'fb').max_tokens, 8192);
  // gemini never sends max_completion_tokens (that's the OpenAI gpt-5/o field).
  assert.equal(buildOpenAIBody(req('gemini-flash-latest', 8192), 'fb').max_completion_tokens, undefined);
});

test('non-reasoning model body: max_tokens, no reasoning fields', () => {
  const body = buildOpenAIBody(req('gpt-4o', 8192), 'fallback');
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test('cached tokens are subtracted from input — disjoint, no double-count (review #6)', async () => {
  const lines = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
    'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 4000 } } }),
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]',
  ];
  const events = await collect(parseOpenAISSE(fromLines(lines)));
  const u = events.find((e) => e.type === 'usage');
  assert.ok(u && u.type === 'usage');
  assert.equal(u.type === 'usage' && u.inputTokens, 1000); // 5000 - 4000 cached
  assert.equal(u.type === 'usage' && u.cacheReadTokens, 4000);
});

test('parseOpenAISSE routes reasoning_content to the thinking channel', async () => {
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"let me "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
    'data: {"choices":[{"delta":{"content":"the answer"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ];
  const events = await collect(parseOpenAISSE(fromLines(lines)));
  const think = events.filter((e): e is Extract<ProviderEvent, { type: 'thinking' }> => e.type === 'thinking').map((e) => e.delta).join('');
  const text = events.filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(think, 'let me think');
  assert.equal(text, 'the answer');
});

test('parseOpenAISSE surfaces an in-stream error frame on a 200 stream (not silent)', async () => {
  const lines = [
    'data: {"error":{"message":"rate limit exceeded","code":"rate_limit_exceeded","type":"rate_limit"}}',
    'data: [DONE]',
  ];
  const events = await collect(parseOpenAISSE(fromLines(lines)));
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, 'expected an error event');
  assert.equal(err.type === 'error' && err.recoverable, true);
  assert.equal(err.type === 'error' && err.code, 'rate_limit_exceeded');
  assert.match(err.type === 'error' ? err.message : '', /rate limit exceeded/);
  // Still terminates cleanly with a done event.
  assert.ok(events.some((e) => e.type === 'done'));
});
