import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelCapabilities } from '../src/config.js';
import { parseOpenAISSE } from '../src/provider/openai.js';
import { eventsFromOpenAICompletion } from '../src/provider/nonStream.js';
import { eventsFromResponsesCompletion, parseResponsesSSE } from '../src/provider/responses.js';
import { scrubControlTokens } from '../src/util/scrub.js';
import type { ProviderEvent } from '../src/provider/provider.js';

async function* lines(frames: unknown[]): AsyncIterable<string> {
  for (const frame of frames) {
    yield `data: ${JSON.stringify(frame)}`;
    yield '';
  }
  yield 'data: [DONE]';
}
const delta = (value: unknown): unknown => ({ choices: [{ delta: value }] });
async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function join(events: ProviderEvent[], kind: 'text' | 'thinking'): string {
  return events.flatMap((e) => e.type === kind ? [e.delta] : []).join('');
}
const examples = [
  'Document `<think>` as a literal XML token; the rest belongs in the answer.',
  'Use "<think>demo</think>" and `</think>` literally.',
  '```xml\n<think>demo</think>\n```\nAnswer continues.',
];

test('inline-capable models preserve prose examples across content chunk boundaries', async () => {
  for (const model of ['', 'qwen3-thinking', 'glm-4.6', 'MiniMax-M2']) {
    for (const content of examples) {
      for (const chunks of [[content], [...content]]) {
        const events = await collect(parseOpenAISSE(lines(chunks.map((s) => delta({ content: s }))), model));
        assert.equal(join(events, 'text'), content, model);
        assert.equal(scrubControlTokens(join(events, 'text')), content);
        assert.equal(join(events, 'thinking'), '');
      }
      const events = [...eventsFromOpenAICompletion({ choices: [{ message: { content } }] }, model)];
      assert.equal(join(events, 'text'), content);
      assert.equal(join(events, 'thinking'), '');
    }
  }
});

test('structured reasoning fields are authoritative even empty and in an earlier frame', async () => {
  for (const field of ['reasoning_content', 'reasoning']) {
    for (const reasoning of [null, '', 'Check the example.']) {
      for (const content of ['<think>literal</think> and more', '</think>demo', ...examples]) {
        for (const frames of [
          [delta({ [field]: reasoning, content })],
          [delta({ [field]: reasoning }), ...[...content].map((c) => delta({ content: c }))],
        ]) {
          const events = await collect(parseOpenAISSE(lines(frames), 'glm-4.6', true));
          assert.equal(join(events, 'text'), content);
          assert.equal(scrubControlTokens(join(events, 'text')), content);
          assert.equal(join(events, 'thinking'), reasoning ?? '');
        }
        const events = [...eventsFromOpenAICompletion({ choices: [{ message: { [field]: reasoning, content } }] }, 'glm-4.6', true)];
        assert.equal(join(events, 'text'), content);
        assert.equal(join(events, 'thinking'), reasoning ?? '');
      }
    }
  }
});

test('explicit hidden capability overrides model guessing in both transports', async () => {
  const caps: ModelCapabilities = { reasoning: 'hidden' };
  const content = '<think>literal data</think> followed by text';
  const events = await collect(parseOpenAISSE(lines([...content].map((c) => delta({ content: c }))), 'glm-4.6', false, caps));
  assert.equal(join(events, 'text'), content);
  assert.equal(join(events, 'thinking'), '');
  const completion = { choices: [{ message: { content } }] };
  assert.equal(join([...eventsFromOpenAICompletion(completion, 'glm-4.6', false, caps)], 'text'), content);
  async function* jsonBody(): AsyncIterable<string> { yield JSON.stringify(completion); }
  assert.equal(join(await collect(parseOpenAISSE(jsonBody(), 'glm-4.6', false, caps)), 'text'), content);
});

test('inline capability applies equally to aliased streamed and non-stream responses', async () => {
  const content = '<think>Check</think>Use `<think>` literally.';
  const caps: ModelCapabilities = { reasoning: 'inline' };
  const streams = [
    await collect(parseOpenAISSE(lines([...content].map((c) => delta({ content: c }))), 'custom', false, caps)),
    [...eventsFromOpenAICompletion({ choices: [{ message: { content } }] }, 'custom', false, caps)],
  ];
  for (const events of streams) {
    assert.equal(join(events, 'text'), 'Use `<think>` literally.');
    assert.equal(join(events, 'thinking'), 'Check');
  }
});

test('switching to a structured field releases a partial content prefix without reordering', async () => {
  const events = await collect(parseOpenAISSE(lines([
    delta({ content: '<thi' }), delta({ reasoning_content: '', content: 'nk>literal</think>' }),
  ]), 'glm-4.6'));
  assert.equal(join(events, 'text'), '<think>literal</think>');
});

test('native tool arguments preserve literal tags and exact strings', async () => {
  const input = { path: 'notes.xml', content: '<think>demo</think> and "False" and <|im_start|>' };
  const args = JSON.stringify(input);
  const events = await collect(parseOpenAISSE(lines([
    delta({ reasoning_content: 'Check the fixture.' }),
    ...[...args].map((c, i) => delta({ tool_calls: [{ index: 0, ...(i ? {} : { id: 'fixture', function: { name: 'write_fixture', arguments: c } }), ...(i ? { function: { arguments: c } } : {}) }] })),
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]), 'glm-4.6'));
  const calls = events.filter((e) => e.type === 'tool_call');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].call.input, input);
});

test('Responses output_text remains content including leading tags', async () => {
  const content = '<think>literal</think> and </think>demo';
  const output = [{ type: 'message', content: [{ type: 'output_text', text: content }] }];
  const streams = [
    [...eventsFromResponsesCompletion({ status: 'completed', output })],
    await collect(parseResponsesSSE(lines([...content].map((c) => ({ type: 'response.output_text.delta', delta: c }))))),
    await collect(parseResponsesSSE(lines([{ type: 'response.completed', response: { status: 'completed', output } }]))),
  ];
  for (const events of streams) {
    assert.equal(join(events, 'text'), content);
    assert.equal(join(events, 'thinking'), '');
  }
});


test('explicit interleaved endpoints may use both reasoning channels', async () => {
  const content = '<think>Inline reasoning.</think>Use `<think>` literally.';
  const caps: ModelCapabilities = { reasoning: 'interleaved' };
  const streams = [
    await collect(parseOpenAISSE(lines([
      delta({ reasoning_content: 'Structured reasoning. ' }),
      ...[...content].map((c) => delta({ content: c })),
    ]), 'custom', false, caps)),
    [...eventsFromOpenAICompletion({ choices: [{ message: {
      reasoning_content: 'Structured reasoning. ', content,
    } }] }, 'custom', false, caps)],
  ];
  for (const events of streams) {
    assert.equal(join(events, 'text'), 'Use `<think>` literally.');
    assert.equal(join(events, 'thinking'), 'Structured reasoning. Inline reasoning.');
  }
});
