import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonSchemaToZod, mcpRisk } from '../src/mcp/client.js';

test('mcpRisk: only read-only-hinted MCP tools auto-approve; everything else is exec (needs approval)', () => {
  assert.equal(mcpRisk({ readOnlyHint: true }), 'read');
  assert.equal(mcpRisk({ destructiveHint: true }), 'exec');
  assert.equal(mcpRisk({}), 'exec', 'no hint → cautious default, not auto-approved');
  assert.equal(mcpRisk(undefined), 'exec');
});

test('jsonSchemaToZod validates object props (required + types) and passes through extras', () => {
  const schema = jsonSchemaToZod({
    type: 'object',
    properties: { path: { type: 'string' }, count: { type: 'integer' } },
    required: ['path'],
  });
  assert.equal(schema.safeParse({ path: 'a.ts', count: 3 }).success, true);
  assert.equal(schema.safeParse({ path: 'a.ts' }).success, true, 'optional prop omitted is fine');
  assert.equal(schema.safeParse({ count: 3 }).success, false, 'missing required prop is rejected');
  assert.equal(schema.safeParse({ path: 5 }).success, false, 'wrong type is rejected');
  const parsed = schema.safeParse({ path: 'a.ts', extra: true });
  assert.equal(parsed.success, true, 'server-accepted extra fields survive');
  if (parsed.success) assert.equal((parsed.data as { extra?: boolean }).extra, true);
});

test('jsonSchemaToZod handles enums and an absent schema (permissive)', () => {
  const e = jsonSchemaToZod({ type: 'string', enum: ['a', 'b'] });
  assert.equal(e.safeParse('a').success, true);
  assert.equal(e.safeParse('z').success, false);
  assert.equal(jsonSchemaToZod(undefined).safeParse({ anything: 1 }).success, true, 'undefined schema accepts anything');
});

import { parseSseResult } from '../src/mcp/client.js';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parseSseResult extracts the JSON-RPC result from a Streamable-HTTP SSE body', () => {
  const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
  assert.deepEqual(parseSseResult(body), { tools: [] });
});

test('parseSseResult surfaces a JSON-RPC error and missing-result', () => {
  assert.throws(() => parseSseResult('data: {"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"boom"}}'), /boom/);
  assert.throws(() => parseSseResult('data: {"jsonrpc":"2.0"}\ndata: ping'), /no JSON-RPC result/);
});

// SECURITY (RT-B3): a project shadow.config.json is UNTRUSTED, so its mcpServers — url OR command — are
// dropped entirely. A `url` entry would auto-connect an outbound HTTP MCP server at startup (unapproved
// egress + SSRF, tools auto-approving on the server's self-declared readOnlyHint); a `command` entry would
// spawn a process (RCE). MCP servers are configured from ~/.shadow / env / `shadow mcp enable` instead.
test('project mcpServers (url AND command) are stripped as untrusted startup egress/exec', () => {
  const ws = mkdtempSync(join(tmpdir(), 'mcpcfg-'));
  try {
    writeFileSync(
      join(ws, 'shadow.config.json'),
      JSON.stringify({ mcpServers: { remote: { url: 'http://127.0.0.1:9000/mcp' }, cmd: { command: 'node', args: ['x.js'] } } }),
    );
    const cfg = loadConfig(ws);
    assert.ok(!('remote' in cfg.mcpServers), 'project url MCP is stripped (no unapproved startup egress)');
    assert.ok(!('cmd' in cfg.mcpServers), 'project command MCP is stripped (no startup RCE)');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
