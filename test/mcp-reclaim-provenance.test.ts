/**
 * 11.6.0 RECLAIM — MCP oversize coverage REUSES the existing resultArtifact persistence: when the
 * full body is archived, a TRUSTED provenance line (outside the envelope) names the artifact id and
 * the mcp_artifact retrieval tool. When the archive save fails, the visible degradation note stays
 * and NO locator is promised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpClient } from '../src/mcp/client.js';
import { McpArtifactStore } from '../src/mcp/artifacts.js';

/** Minimal JSON-RPC stdio server: one tool returning a configurable oversized body. */
const SERVER = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } }) + '\\n');
    } else if (req.method === 'tools/call') {
      const body = 'MCP-FULL-BODY-'.repeat(200);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: body }] } }) + '\\n');
    } else if (req.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
    }
  }
});
`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-mcpreclaim-'));
}

test('MCP oversize: full body archived, trusted provenance names the artifact, body retrievable', async () => {
  const ws = tmp();
  let client: McpClient | undefined;
  try {
    const store = new McpArtifactStore(ws);
    client = new McpClient(
      'fake',
      { command: process.execPath, args: ['-e', SERVER], sandbox: false },
      { workspaceRoot: ws, enabled: false },
      { artifacts: store },
    );
    await client.start();
    const r = await client.callTool('big', {}, 'exec', undefined, 200);
    assert.equal(r.ok, true);
    const provenance = r.summary.split('\n')[0]!;
    assert.match(provenance, /^Full result \(\d+ chars\) saved as MCP artifact [0-9a-f-]+ — retrieve it with the mcp_artifact tool\.$/, 'trusted provenance line first, outside the envelope');
    const id = provenance.match(/artifact ([0-9a-f-]+)/)![1]!;
    assert.ok(r.summary.includes('<<<UNTRUSTED_CONTENT_BEGIN>>>'), 'body still enveloped after the provenance line');
    // The artifact holds the FULL pre-clamp body and pages back through the store.
    const page = store.read(id, 0, 10_000_000);
    assert.equal(page.content, 'MCP-FULL-BODY-'.repeat(200), 'full body archived, not the excerpt');
    assert.ok(page.content.length > 200, 'body really was oversize');
  } finally {
    client?.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('MCP oversize with a failing artifact store: visible degradation, no locator promised', async () => {
  const ws = tmp();
  let client: McpClient | undefined;
  try {
    const brokenStore = { save: () => { throw new Error('disk full'); } };
    client = new McpClient(
      'fake',
      { command: process.execPath, args: ['-e', SERVER], sandbox: false },
      { workspaceRoot: ws, enabled: false },
      { artifacts: brokenStore as never },
    );
    await client.start();
    const r = await client.callTool('big', {}, 'exec', undefined, 200);
    assert.equal(r.ok, true, 'a local archive failure must not discard the remote result');
    assert.ok(!r.summary.includes('saved as MCP artifact'), 'no locator promised when the save failed');
    assert.ok(r.summary.includes('<<<UNTRUSTED_CONTENT_BEGIN>>>'), 'bounded excerpt still delivered');
    assert.deepEqual(r.data, { truncated: true, artifactUnavailable: true, note: 'The full MCP result could not be saved locally; only the bounded excerpt is available.' });
  } finally {
    client?.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});