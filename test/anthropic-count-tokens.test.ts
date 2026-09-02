import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicProvider } from '../src/provider/anthropic.js';
import type { Message } from '../src/provider/provider.js';

/**
 * count_tokens rides the same API as the real request, so its body must carry the SAME mapping:
 * role:'tool' history turns converted to user turns with tool_result blocks (a raw 'tool' role
 * 400'd every count), and tool schemas converted from the OpenAI shape ({parameters}) to the
 * Messages shape ({input_schema}) (forwarding verbatim 400'd EVERY call and silently degraded
 * the session to the local estimator). Driven against a loopback server that captures the body.
 */
test('count_tokens sends the mapped wire body and returns the provider count', async () => {
  let body: {
    model?: string;
    messages?: { role: string; content: unknown }[];
    tools?: { name?: string; description?: string; input_schema?: unknown; parameters?: unknown }[];
  } | null = null;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 42 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const p = new AnthropicProvider({
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'claude-sonnet-5',
    });
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'sys prompt' }] },
      { role: 'user', content: [{ type: 'text', text: 'find it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'grep', input: { q: 'x' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 't1', ok: true, content: 'result body' }] },
    ];
    const n = await p.countTokens({
      model: 'claude-sonnet-5',
      messages,
      tools: [{ name: 'grep', description: 'search', parameters: { type: 'object' } }],
    });
    assert.equal(n, 42, 'the endpoint count wins over the local estimator');

    assert.equal(body!.model, 'claude-sonnet-5');
    // Tool schema: input_schema, not the forwarded OpenAI `parameters` key.
    assert.equal(body!.tools!.length, 1);
    assert.equal(body!.tools![0]!.name, 'grep');
    assert.deepEqual(body!.tools![0]!.input_schema, { type: 'object' });
    assert.equal(body!.tools![0]!.parameters, undefined);

    // History mapping: no role:'tool' turn survives; alternation holds; the tool_result rides
    // in the closing user turn paired to its tool_use id.
    const roles = body!.messages!.map((m) => m.role);
    assert.ok(!roles.includes('tool'), 'role:tool never reaches the wire');
    assert.deepEqual(roles, ['user', 'assistant', 'user']);
    const last = body!.messages!.at(-1)!;
    const result = (last.content as { type: string; tool_use_id?: string; content?: string }[]).find(
      (b) => b.type === 'tool_result',
    );
    assert.ok(result, 'the tool_result block is present');
    assert.equal(result!.tool_use_id, 't1');
    assert.match(result!.content!, /result body/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
