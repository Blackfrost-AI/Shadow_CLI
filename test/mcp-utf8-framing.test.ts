import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpClient } from '../src/mcp/client.js';
import type { ToolRisk } from '../src/tools/types.js';

const RISK: ToolRisk = 'exec';

const REPLACEMENT = String.fromCodePoint(0xfffd);

/**
 * A pipe 'data' chunk splits on BYTE boundaries, not code points. Decoding each chunk in
 * isolation (the old `d.toString()`) replaced a multi-byte UTF-8 sequence split across chunks
 * with U+FFFD — silently corrupting the payload when the split landed inside a JSON string, and
 * dropping the whole response (JSON.parse threw, the catch swallowed it, the request stalled to
 * its 60s timeout) when it landed in structural JSON. onData is driven DIRECTLY with crafted
 * Buffers — deterministic, independent of how the OS happens to chunk the pipe — plus one
 * end-to-end test against a real child to pin the stdout wiring as raw-Buffer.
 */

/** Hand-drive the framing path (private, so reached through a typed cast). */
function feedOf(client: McpClient): (chunk: Buffer | string) => void {
  return (client as unknown as { onData: (chunk: Buffer | string) => void }).onData.bind(client);
}

/** Minimal fake child — enough for send() (stdin.write) and stop() (kill) to work. */
function attachFakeChild(client: McpClient): void {
  (client as unknown as { child: unknown }).child = { stdin: { write: () => {} }, kill: () => {} };
}

/** Byte offset just INSIDE `needle`'s UTF-8 encoding (i.e. after its lead byte). */
function midSequenceOffset(bytes: Buffer, needle: string): number {
  const at = bytes.indexOf(Buffer.from(needle, 'utf8'));
  assert.ok(at > 0, `test bug: ${needle} not present in message bytes`);
  return at + 1;
}

function newClient(): McpClient {
  // enabled:false keeps any future start() on the passthrough path; these tests never spawn —
  // they attach a fake child and drive onData by hand.
  return new McpClient('srv', { command: 'true' }, { workspaceRoot: tmpdir(), enabled: false });
}

function replyLine(id: number, result: unknown): Buffer {
  return Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, 'utf8');
}

test('stdio framing reassembles a 3-byte character split across two chunks inside a JSON string', async () => {
  const client = newClient();
  attachFakeChild(client);
  const pending = client.listTools(); // first request → wire id 1
  const bytes = replyLine(1, { tools: [{ name: 't', description: 'café 日本語 ✓' }] });
  const cut = midSequenceOffset(bytes, '日'); // chunk 1 ends mid-sequence
  // Sanity: the naive chunk-wise decode this fix replaces really does corrupt these bytes — so
  // the assertion below can only pass through a boundary-aware decoder.
  assert.match(bytes.subarray(0, cut).toString() + bytes.subarray(cut).toString(), new RegExp(REPLACEMENT, 'u'));
  const feed = feedOf(client);
  feed(bytes.subarray(0, cut));
  feed(bytes.subarray(cut));
  const tools = await pending;
  assert.equal(tools[0]?.description, 'café 日本語 ✓', 'a character split across chunks must reassemble intact');
  client.stop();
});

test('stdio framing survives a message delivered one byte at a time (2/3/4-byte chars)', async () => {
  const client = newClient();
  attachFakeChild(client);
  const pending = client.listTools();
  const bytes = replyLine(1, { tools: [{ name: 't', description: 'héllo 世界 🌍 ✓' }] });
  const feed = feedOf(client);
  for (let i = 0; i < bytes.length; i++) feed(bytes.subarray(i, i + 1));
  const tools = await pending;
  assert.equal(tools[0]?.description, 'héllo 世界 🌍 ✓');
  client.stop();
});

test('stdio framing holds a trailing partial line until its remaining bytes arrive', async () => {
  const client = newClient();
  attachFakeChild(client);
  const feed = feedOf(client);
  const first = client.listTools(); // wire id 1
  feed(replyLine(1, { tools: [] }));
  assert.deepEqual(await first, []);
  const pending = client.listTools(); // wire id 2
  const second = replyLine(2, { tools: [{ name: 'ünïcödé' }] });
  const cut = midSequenceOffset(second, 'ö'); // chunk 1 ends mid-character, before the '\n'
  feed(second.subarray(0, cut));
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(settled, false, 'a split line must neither resolve early nor decode as U+FFFD');
  feed(second.subarray(cut));
  assert.deepEqual(await pending, [{ name: 'ünïcödé' }]);
  client.stop();
});

/** End-to-end: the stdout handler must pass RAW Buffers (a regression to d.toString() fails this). */
test('stdio wiring decodes a real child pipe across a mid-character chunk split', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-utf8-'));
  // CJS on purpose: the child needs no package.json. The script answers the initialize
  // handshake, then writes the tools/call reply as TWO writes whose boundary sits inside 日.
  writeFileSync(
    join(dir, 'server.cjs'),
    [
      "let acc = '';",
      "process.stdin.on('data', (d) => {",
      '  acc += d;',
      '  let i;',
      "  while ((i = acc.indexOf('\\n')) >= 0) {",
      '    const line = acc.slice(0, i);',
      '    acc = acc.slice(i + 1);',
      '    if (!line.trim()) continue;',
      '    let m;',
      '    try { m = JSON.parse(line); } catch { continue; }',
      '    if (m.id === undefined) continue; // notification — no reply',
      "    if (m.method === 'initialize') {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\\n');",
      '      continue;',
      '    }',
      "    if (m.method === 'tools/call') {",
      "      const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'café ✓ 日本語 🌍 — split inside a character' }] } }) + '\\n', 'utf8');",
      "      const cut = payload.indexOf('日') + 1; // byte offset just inside the 3-byte sequence",
      '      process.stdout.write(payload.subarray(0, cut));',
      '      setTimeout(() => process.stdout.write(payload.subarray(cut)), 25);',
      '    }',
      '  }',
      '});',
    ].join('\n'),
  );
  const client = new McpClient('e2e', { command: process.execPath, args: [join(dir, 'server.cjs')] }, { workspaceRoot: dir, enabled: false });
  try {
    await client.start();
    const res = await client.callTool('probe', {}, RISK);
    assert.equal(res.ok, true, `tool call failed: ${res.summary}`);
    // callTool surfaces the reply as the enveloped `summary` string (see ok() in tools/types).
    const surfaced = res.summary;
    assert.ok(surfaced.includes('café ✓ 日本語 🌍 — split inside a character'), `payload corrupted: ${surfaced.slice(0, 200)}`);
    assert.doesNotMatch(surfaced, new RegExp(REPLACEMENT, 'u'), 'no U+FFFD may reach the model');
  } finally {
    client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
