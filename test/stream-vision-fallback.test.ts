import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeVisionUnsupported, looksLikeBadImagePayload, stripImagesFromBody, looksLikeTokenOverflow } from '../src/provider/stream.js';

test('looksLikeVisionUnsupported detects text-only-endpoint image rejections', () => {
  // The exact error a text-only OpenAI-compatible server returns after view_image.
  assert.ok(looksLikeVisionUnsupported("messages.content.type is invalid, allowed values: ['text']"));
  assert.ok(looksLikeVisionUnsupported('image_url is not supported by this model'));
  assert.ok(looksLikeVisionUnsupported('this model does not support image input'));
  assert.ok(looksLikeVisionUnsupported('invalid content type: image'));
  // vLLM gateways on text-only custom models
  assert.ok(looksLikeVisionUnsupported('BLACK-LM is not a multimodal model'));
  assert.ok(looksLikeVisionUnsupported('Error: model is not a multimodal model'));
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
  assert.match(userContent as string, /describe_media/); // steer text-only agents to eyes tool
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

// C7 — the strip matcher fired on ordinary, fixable image problems.
// `image` + (invalid|cannot|does not) also matched "invalid base64 data" and "image dimensions
// exceed 8000 pixels", so a corrupt or oversized attachment was silently replaced with
// "[image omitted — the current model has no vision support]" and the REAL error never surfaced.
// The user was told their model lacks a capability it actually has.
test('C7: a real capability rejection still strips', () => {
  for (const msg of [
    "messages.content.type is invalid, allowed values: ['text']",
    'BLACK-LM is not a multimodal model',
    'this model does not support images',
    'image_url is not supported by this endpoint',
    'text-only model',
  ]) {
    assert.equal(looksLikeVisionUnsupported(msg), true, `should strip: ${msg}`);
  }
});

test('C7: a problem with THIS image surfaces as itself, not as "no vision support"', () => {
  for (const msg of [
    'invalid base64 data',
    'image dimensions exceed 8000 pixels',
    'image file too large',
    'failed to decode image',
    'malformed image payload',
    'image truncated',
    'image exceeds maximum size of 5 MB',
  ]) {
    assert.equal(looksLikeVisionUnsupported(msg), false, `must NOT be mistaken for a capability gap: ${msg}`);
  }
});

// C7b — the trap the C7 narrowing nearly walked into.
// Making a corrupt image no longer match looksLikeVisionUnsupported meant the 400 became
// TERMINAL. The image stays in conversation history and every request body is rebuilt from
// history, so the identical 400 then fired on EVERY subsequent turn — the session was wedged
// until /clear. Showing the real error is right; showing it INSTEAD of recovering is not.
test('C7b: a bad image payload is recognised separately from a capability gap', () => {
  for (const m of [
    'messages.0.content.1.image.source.base64.data: invalid base64 data',
    'image dimensions exceed 8000 pixels',
    'image file too large',
    'image url could not be fetched',
    'unsupported image format: tiff',
  ]) {
    assert.equal(looksLikeBadImagePayload(m), true, `payload problem: ${m}`);
  }
  // A capability rejection is NOT a payload problem — the two reasons must stay distinct.
  assert.equal(looksLikeBadImagePayload('this model does not support images'), false);
  assert.equal(looksLikeBadImagePayload('invalid api key'), false, 'must mention an image at all');
});

test('C7b: stripping tells the TRUTH about why the image is gone', () => {
  const body: Record<string, unknown> = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,ZZ' } },
        ],
      },
    ],
  };
  assert.equal(stripImagesFromBody(body, 'the provider rejected it: invalid base64 data'), true);
  const content = (body.messages as { content: string }[])[0]!.content;
  assert.match(content, /invalid base64 data/, 'the real reason reaches the model');
  assert.doesNotMatch(content, /no vision support/, 'and it does not blame a capability it has');
  assert.match(content, /what is this\?/, 'the surrounding text survives');
});

test('C7b: the default placeholder is unchanged when no reason is given', () => {
  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
  };
  assert.equal(stripImagesFromBody(body), true);
  assert.match((body.messages as { content: string }[])[0]!.content, /no vision support/);
});
