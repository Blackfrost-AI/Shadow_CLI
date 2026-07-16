import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDescribeGraph, extractText, readHistory } from '../src/tools/comfy.js';

test('buildDescribeGraph: threads model/type/prompt into a valid ComfyUI API graph', () => {
  const g = buildDescribeGraph({ filename: 'shot.png', model: 'my-vl.safetensors', clipType: 'qwen_image', prompt: 'what is this?', maxLength: 200 });
  assert.equal(g['1']!.class_type, 'CLIPLoader');
  assert.deepEqual(g['1']!.inputs, { clip_name: 'my-vl.safetensors', type: 'qwen_image' });
  assert.equal((g['2']!.inputs as { image: string }).image, 'shot.png');
  const tg = g['3']!.inputs as { clip: unknown; prompt: string; image: unknown; max_length: number };
  assert.equal(g['3']!.class_type, 'TextGenerate');
  assert.deepEqual(tg.clip, ['1', 0], 'clip wired from the loader');
  assert.deepEqual(tg.image, ['2', 0], 'image wired from LoadImage');
  assert.equal(tg.prompt, 'what is this?');
  assert.equal(tg.max_length, 200);
  assert.deepEqual((g['4']!.inputs as { source: unknown }).source, ['3', 0], 'PreviewAny echoes the text out');
});

test('extractText: pulls the description from ComfyUI output shapes', () => {
  assert.equal(extractText({ '4': { text: ['a red bicycle by a wall'] } }), 'a red bicycle by a wall');
  assert.equal(extractText({ '4': { string: 'plain string form' } }), 'plain string form');
  assert.equal(extractText({ '4': { value: '  trimmed  ' } }), 'trimmed');
  assert.equal(extractText({ '4': { images: [{}] } }), null, 'no text field → null');
  assert.equal(extractText(undefined), null);
});

test('readHistory: distinguishes pending, done-with-text, and node error', () => {
  assert.deepEqual(readHistory(undefined), { state: 'pending' }, 'no entry yet = pending');
  assert.deepEqual(
    readHistory({ status: { status_str: 'success' }, outputs: { '4': { text: ['ok'] } } }),
    { state: 'done', text: 'ok' },
  );
  const err = readHistory({
    status: {
      status_str: 'error',
      messages: [['execution_error', { node_type: 'TextGenerate', exception_message: "'Config' object has no attribute 'stop_tokens'" }]],
    },
  });
  assert.equal(err.state, 'error');
  assert.match((err as { message: string }).message, /TextGenerate/);
  assert.match((err as { message: string }).message, /stop_tokens/);
});
