import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { isolateHome } from './helpers/isolateHome.js';

// shadowFetch appends an egress receipt to ~/.shadow/egress.log — point HOME at a throwaway
// dir BEFORE the source modules load (isolateHome refuses to run if the redirect didn't take).
isolateHome('mcp-http-non-text');
const { McpClient, McpHttpClient } = await import('../src/mcp/client.js');
import type { ToolRisk } from '../src/tools/types.js';

const RISK: ToolRisk = 'exec';

type ToolCallResult = { ok: boolean; summary: string; data?: unknown };
type JsonRpcReq = { id?: number; method: string; params?: { name?: string } };

/**
 * Finding: the stdio client's callTool was taught to surface non-text MCP content (image/audio/
 * resource) as a presence note and to pass embedded resource text through — explicitly so the
 * model doesn't act as if a screenshot tool returned nothing. McpHttpClient never got that fix:
 * it mapped only `c.text`, so an all-non-text reply produced ok(..., 'ok') with NO content.
 * These tests pin the HTTP behavior, plus payload-for-payload parity between the two transports.
 */

/** Node's assert has no `include` (chai-ism) — string containment with a readable failure. */
function assertContains(haystack: string, needle: string, msg?: string | Error): void {
  assert.ok(
    haystack.includes(needle),
    msg ?? `expected ${JSON.stringify(haystack.slice(0, 200))}… to contain ${JSON.stringify(needle)}`,
  );
}

/** The envelope's payload (between the markers) — the part the model actually reads. */
function payloadOf(envelope: string): string {
  const begin = envelope.indexOf('>>>\n');
  const end = envelope.lastIndexOf('\n<<<');
  assert.ok(begin >= 0 && end > begin, `test bug: no envelope in ${envelope.slice(0, 120)}`);
  return envelope.slice(begin + 4, end);
}

/** One-shot Streamable-HTTP MCP endpoint: every tools/call replies with `resultFor`'s value. */
async function withMcpEndpoint(resultFor: (rpc: JsonRpcReq) => unknown, fn: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body) as JsonRpcReq;
      if (rpc.id === undefined) {
        res.end(); // notification (notifications/initialized) — no reply body
        return;
      }
      // connection:close so the server can shut down without waiting on a pooled keep-alive socket.
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: resultFor(rpc) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}/mcp`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** callTool against a live HTTP endpoint whose tools/call reply carries `content`. */
async function callThroughHttp(content: unknown): Promise<ToolCallResult> {
  let out: ToolCallResult | undefined;
  await withMcpEndpoint(
    (rpc) => (rpc.method === 'initialize' ? {} : { content }),
    async (url) => {
      const client = new McpHttpClient('srv', url);
      await client.start();
      try {
        out = await client.callTool('shot', {}, RISK);
      } finally {
        client.stop();
      }
    },
  );
  assert.ok(out, 'test bug: callTool never ran');
  return out;
}

/** Drive the stdio client's callTool with a fake child (same technique as mcp-utf8-framing.test.ts). */
async function callThroughStdio(content: unknown): Promise<ToolCallResult> {
  const client = new McpClient('srv', { command: 'true' }, { workspaceRoot: tmpdir(), enabled: false });
  (client as unknown as { child: unknown }).child = { stdin: { write: () => {} }, kill: () => {} };
  const pending = client.callTool('shot', {}, RISK); // first request → wire id 1
  const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content } })}\n`, 'utf8');
  (client as unknown as { onData: (chunk: Buffer) => void }).onData(line);
  const out = await pending;
  client.stop();
  return out;
}

test('HTTP callTool surfaces an image-only result as a presence note (was: empty ok)', async () => {
  const res = await callThroughHttp([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
  assert.equal(res.ok, true);
  assert.notEqual(res.summary, 'ok', 'an image-only reply must not read as an empty success');
  assertContains(payloadOf(res.summary), '[image]');
});

test('HTTP callTool surfaces embedded resource text and a by-reference resource note', async () => {
  const res = await callThroughHttp([
    { type: 'resource', resource: { uri: 'file:///tmp/report.txt', text: 'RESOURCE BODY TEXT' } },
    { type: 'resource', resource: { uri: 'https://example.test/blob.bin' } },
  ]);
  assert.equal(res.ok, true);
  const payload = payloadOf(res.summary);
  assertContains(payload, 'RESOURCE BODY TEXT', 'embedded resource text must reach the model');
  assertContains(payload, '[resource https://example.test/blob.bin]', 'a by-reference resource must not vanish');
});

test('HTTP callTool keeps text, notes, and the isError path alongside the new mapping', async () => {
  const mixed = await callThroughHttp([
    { type: 'text', text: 'screenshots attached' },
    { type: 'image', data: 'aGk=', mimeType: 'image/png' },
    { type: 'audio', data: 'aGk=', mimeType: 'audio/wav' },
  ]);
  const payload = payloadOf(mixed.summary);
  assertContains(payload, 'screenshots attached');
  assertContains(payload, '[image] [audio]');
  // An isError reply carries the same body, inside the envelope, on the failure path.
  let err: ToolCallResult | undefined;
  await withMcpEndpoint(
    () => ({ content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }], isError: true }),
    async (url) => {
      const client = new McpHttpClient('srv', url);
      await client.start();
      try {
        err = await client.callTool('shot', {}, RISK);
      } finally {
        client.stop();
      }
    },
  );
  assert.ok(err, 'test bug: isError callTool never ran');
  assert.equal(err.ok, false);
  assertContains(err.summary, '[image]');
});

test('stdio and HTTP transports surface an identical payload for the same content array', async () => {
  const content = [
    { type: 'text', text: 'screenshots attached' },
    { type: 'image', data: 'aGk=', mimeType: 'image/png' },
    { type: 'audio', data: 'aGk=', mimeType: 'audio/wav' },
    { type: 'resource', resource: { uri: 'file:///tmp/r.txt', text: 'embedded resource body' } },
  ];
  const http = await callThroughHttp(content);
  const stdio = await callThroughStdio(content);
  assert.equal(http.ok, true);
  assert.equal(stdio.ok, true);
  // Same mapping (shared helper) ⇒ the enveloped payload the model reads is byte-identical.
  assert.equal(payloadOf(http.summary), payloadOf(stdio.summary));
  const payload = payloadOf(http.summary);
  assertContains(payload, 'embedded resource body');
  assertContains(payload, '[image] [audio]');
});
