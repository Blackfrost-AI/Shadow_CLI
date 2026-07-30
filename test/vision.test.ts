import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDescribeMediaTool } from '../src/tools/vision.js';

const PIXEL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('describe_media keeps the supported OpenAI-compatible vision backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-vision-'));
  const originalFetch = globalThis.fetch;
  try {
    writeFileSync(join(root, 'pixel.png'), Buffer.from(PIXEL_PNG_B64, 'base64'));
    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'a transparent pixel' } }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const tool = makeDescribeMediaTool({
      baseUrl: 'http://vision.test/v1/',
      model: 'local-vlm',
      prompt: 'default prompt',
    });
    const result = await tool.run(
      { path: 'pixel.png', prompt: 'describe the test image' },
      {
        workspaceRoot: root,
        signal: new AbortController().signal,
        log: () => {},
        dryRun: false,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.summary, 'a transparent pixel');
    assert.equal((result.data as { backend: string }).backend, 'vision');
    assert.equal(requestUrl, 'http://vision.test/v1/chat/completions');
    assert.equal(requestBody.model, 'local-vlm');
    const messages = requestBody.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages[0]!.content[0], { type: 'text', text: 'describe the test image' });
    assert.match(
      (messages[0]!.content[1]!.image_url as { url: string }).url,
      /^data:image\/png;base64,/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
