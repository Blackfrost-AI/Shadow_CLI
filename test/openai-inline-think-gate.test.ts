import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenAISSE, emitsInlineThinking } from '../src/provider/openai.js';
import type { ProviderEvent } from '../src/provider/provider.js';

/**
 * C6 — inline <think> splitting ran for EVERY model, with no gate.
 *
 * So asking Shadow to document `<think>` tags, write a chat template, or explain this very
 * feature made the answer visibly truncate mid-sentence: the prose after the tag was routed to
 * the reasoning channel and LOST from history, because only `turn.text` is committed.
 */
async function* lines(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}
async function run(model: string, content: string): Promise<{ text: string; thinking: string }> {
  const evs: ProviderEvent[] = [];
  const body = ['data: ' + JSON.stringify({ choices: [{ delta: { content } }] }), 'data: [DONE]'];
  for await (const e of parseOpenAISSE(lines(body), model)) evs.push(e);
  const pick = (t: string): string =>
    evs.filter((e) => e.type === t).map((e) => (e as { delta: string }).delta).join('');
  return { text: pick('text'), thinking: pick('thinking') };
}

const PROSE = 'To hide reasoning, wrap it in <think>like this</think> and the client strips it.';

test('a NON-reasoning model keeps prose about think tags intact', async () => {
  for (const model of ['gpt-4o', 'claude-opus-4-8', 'llama-3.3-70b', 'mistral-large']) {
    const { text, thinking } = await run(model, PROSE);
    assert.equal(text, PROSE, `${model}: the answer must survive verbatim`);
    assert.equal(thinking, '', `${model}: nothing should be diverted to reasoning`);
  }
});

test('a model that genuinely emits inline reasoning still gets split', async () => {
  for (const model of ['deepseek-r1', 'QwQ-32B', 'qwen3-thinking', 'MiniMax-M2']) {
    const { text, thinking } = await run(model, '<think>weighing options</think>Final answer.');
    assert.equal(thinking, 'weighing options', `${model}: reasoning still routes to the think channel`);
    assert.equal(text, 'Final answer.', `${model}: the answer is what remains`);
  }
});

test('an unknown model stays permissive — a local serve is likelier a reasoner than a tag-documenter', async () => {
  const { text, thinking } = await run('', '<think>r</think>A');
  assert.equal(thinking, 'r');
  assert.equal(text, 'A');
});

test('emitsInlineThinking covers the families that do it, and nothing else', () => {
  for (const m of ['deepseek-r1', 'DeepSeek-R1-Distill-Qwen-7B', 'QwQ-32B', 'qwen3-30b-thinking', 'MiniMax-M2', 'glm-4.6'])
    assert.equal(emitsInlineThinking(m), true, `${m} emits inline <think>`);
  for (const m of ['gpt-4o', 'o3', 'claude-opus-4-8', 'gemini-2.5-pro', 'llama-3.3-70b'])
    assert.equal(emitsInlineThinking(m), false, `${m} does not`);
});
