import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeVisionUnsupported, stripImagesFromBody, looksLikeTokenOverflow } from '../src/provider/stream.js';

test('looksLikeVisionUnsupported detects text-only-endpoint image rejections', () => {
  // The exact error a text-only OpenAI-compatible server returns after view_image.
  assert.ok(looksLikeVisionUnsupported("messages.content.type is invalid, allowed values: ['text']"));
  assert.ok(looksLikeVisionUnsupported('image_url is not supported by this model'));
  assert.ok(looksLikeVisionUnsupported('this model does not support image input'));
  assert.ok(looksLikeVisionUnsupported('invalid content type: image'));
});

test('looksLikeVisionUnsupported does NOT match unrelated 400s (incl. token overflow)', () => {
  assert.ok(!looksLikeVisionUnsupported('invalid api key'));
  assert.ok(!looksLikeVisionUnsupported('unsupported parameter: temperature'));
  assert.ok(!looksLikeVisionUnsupported('model not found'));
  // Must stay disjoint from the token-overflow branch so the two retries never fight.
  assert.ok(!looksLikeVisionUnsupported('context_length_exceeded: too many tokens'));
  assert.ok(!looksLikeTokenOverflow("messages.content.type is invalid, allowed values: ['text']"));
});

test('stripImagesFromBody drops image parts, keeps text, collapses to a string (OpenAI shape)', () => {
  const oai: Record<string, unknown> = {
    model: 'x',
    messages: [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Loaded image standings.png — shown below.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  };
  assert.equal(stripImagesFromBody(oai), true);
  const userContent = (oai.messages as { content: unknown }[])[1].content;
  assert.equal(typeof userContent, 'string'); // collapsed
  assert.match(userContent as string, /Loaded image standings\.png/); // text preserved
  assert.match(userContent as string, /image omitted/); // note appended
  assert.doesNotMatch(userContent as string, /base64|image_url/); // image gone
});

test('stripImagesFromBody handles the Anthropic image shape too', () => {
  const ant: Record<string, unknown> = {
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    ],
  };
  assert.equal(stripImagesFromBody(ant), true);
  assert.equal(typeof (ant.messages as { content: unknown }[])[0].content, 'string');
});

test('stripImagesFromBody returns false when there is nothing to strip (so no retry is attempted)', () => {
  assert.equal(stripImagesFromBody({ messages: [{ role: 'user', content: 'hello' }] }), false);
  assert.equal(stripImagesFromBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), false);
  assert.equal(stripImagesFromBody({}), false);
  assert.equal(stripImagesFromBody(null), false);
});
