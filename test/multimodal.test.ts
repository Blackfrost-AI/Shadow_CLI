import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenAIMessages } from '../src/provider/openai.js';
import { toAnthropicMessages } from '../src/provider/anthropic.js';
import type { CompletionRequest, Message } from '../src/provider/provider.js';

const B64 = 'iVBORw0KGgoAAAANS'; // stand-in base64 payload (content is opaque to the adapter)

function req(messages: Message[]): CompletionRequest {
  return { model: 'gemini-flash-latest', system: 'sys', messages, tools: [], maxOutputTokens: 256 };
}

test('OpenAI adapter renders an image as a data-URI image_url part alongside text', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', mediaType: 'image/png', data: B64 },
      ],
    },
  ];
  const out = toOpenAIMessages(req(messages));
  const user = out.find((m) => m.role === 'user')!;
  assert.ok(Array.isArray(user.content), 'user content is a multimodal parts array');
  const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.deepEqual(parts[0], { type: 'text', text: 'what is this?' }, 'text part comes first');
  assert.equal(parts[1]?.type, 'image_url');
  assert.equal(parts[1]?.image_url?.url, `data:image/png;base64,${B64}`, 'image is a base64 data URI');
});

test('OpenAI adapter sends an image-only user turn as a parts array (no text part)', () => {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'image', mediaType: 'image/jpeg', data: B64 }] }];
  const parts = toOpenAIMessages(req(messages)).find((m) => m.role === 'user')!.content as Array<{ type: string }>;
  assert.ok(Array.isArray(parts));
  assert.equal(parts.length, 1, 'only the image part');
  assert.equal(parts[0]?.type, 'image_url');
});

test('OpenAI adapter keeps a text-only user turn as a plain string', () => {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
  const user = toOpenAIMessages(req(messages)).find((m) => m.role === 'user')!;
  assert.equal(user.content, 'hi', 'no image → plain string content (unchanged behavior)');
});

test('Anthropic adapter renders an image as a base64 source block in the user turn', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', mediaType: 'image/webp', data: B64 },
      ],
    },
  ];
  const user = toAnthropicMessages(messages, 'claude-opus-4-8').find((m) => m.role === 'user')!;
  const img = user.content.find((b) => b.type === 'image') as
    | { type: 'image'; source: { type: string; media_type: string; data: string } }
    | undefined;
  assert.ok(img, 'an image block is present');
  assert.deepEqual(img!.source, { type: 'base64', media_type: 'image/webp', data: B64 });
});
