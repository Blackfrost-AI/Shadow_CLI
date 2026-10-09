import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome } from './helpers/isolateHome.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';
isolateHome('mcp-lifecycle');
const { McpClient, McpHttpClient } = await import('../src/mcp/client.js');
const { createMcpManager } = await import('../src/mcp/manager.js');
const { McpArtifactStore } = await import('../src/mcp/artifacts.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
import type { McpProgress } from '../src/mcp/lifecycle.js';
import type { ToolContext } from '../src/tools/types.js';

const FAKE = `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = process.argv[2];
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...m})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); appendFileSync(log, line+'\\n');
 if (m.method==='initialize') { setTimeout(()=>send({id:m.id,result:{capabilities:{}}}),Number(process.argv[3]||0)); return; }
 if (m.method==='tools/list') { send({id:m.id,result:{tools:[{name:'slow',inputSchema:{type:'object'}},{name:'large',inputSchema:{type:'object'}}]}}); return; }
 if (m.method==='tools/call') {
  if(m.params.name==='large') {send({id:m.id,result:{content:[{type:'text',text:'output '.repeat(10000)}]}});return;}
  const token=m.params._meta.progressToken;
  for (const [progress,progressToken] of [[0,token],[1,token],[1,token],[0,token],[10,'unknown']]) send({method:'notifications/progress',params:{progressToken,progress,total:20,message:'working'}});
 }
});`;
function fixture(): { root: string; script: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'shadow-mcp-life-'));
  const script = join(root, 'server.mjs');
  const log = join(root, 'wire.jsonl');
  writeFileSync(script, FAKE);
  return { root, script, log };
}
function records(log: string): Array<{ id?: number; method: string; params?: { requestId?: number } }> {
  try { return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)); } catch { return []; }
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('condition was not observed'); await new Promise((done) => setTimeout(done, 10)); }
}

test('stdio forwards monotonic active progress, remote cancellation, bounded timeout and preserved large artifact', async () => {
  const f = fixture();
  const progress: McpProgress[] = [];
  const outcomes: string[] = [];
  const store = new McpArtifactStore(f.root);
  const client = new McpClient('fixture', { command: process.execPath, args: [f.script, f.log], callTimeoutMs: 150 }, { workspaceRoot: f.root, enabled: false }, {
    artifacts: store, onProgress: (event) => progress.push(event), onCallEnd: (event) => outcomes.push(event.status),
  });
  try {
    await client.start();
    const ac = new AbortController();
    const pending = client.callTool('slow', {}, 'exec', ac.signal);
    await until(() => progress.length === 2);
    ac.abort();
    assert.equal((await pending).ok, false);
    await until(() => records(f.log).some((record) => record.method === 'notifications/cancelled'));
    const callId = records(f.log).find((record) => record.method === 'tools/call')!.id;
    assert.ok(records(f.log).some((record) => record.method === 'notifications/cancelled' && record.params?.requestId === callId));
    assert.deepEqual(progress.map((event) => event.progress), [0, 1]);
    const timed = await client.callTool('slow', {}, 'exec');
    assert.match(timed.summary, /timeout/);
    const large = await client.callTool('large', {}, 'exec', undefined, 300);
    assert.equal(large.ok, true);
    const artifact = (large.data as { artifact: { id: string } }).artifact;
    const reloaded = new McpArtifactStore(f.root).read(artifact.id, 40000, 500);
    assert.equal(reloaded.content.length, 500);
    assert.equal(reloaded.nextOffset, 40500);
    assert.match(large.summary, /UNTRUSTED_CONTENT_END/);
    assert.deepEqual(outcomes, ['cancelled', 'cancelled', 'completed']);
    assert.throws(() => store.read('../wire.jsonl'), /Invalid/);
  } finally { client.stop(); await removeFixtureTree(f.root); }
});

test('manager allowlist/deferred discovery, exact unregister, reconnect and superseded initialization work live', async () => {
  const f = fixture();
  const registry = new ToolRegistry();
  const manager = createMcpManager({ registry, workspaceRoot: f.root, jail: { enabled: false } });
  const cfg = { command: process.execPath, args: [f.script, f.log], toolNames: ['large'] };
  try {
    assert.equal((await manager.reconnect('a.b', cfg)).ok, true);
    assert.equal((await manager.reconnect('a_b', cfg)).ok, true);
    const first = manager.list().find((entry) => entry.name === 'a.b')!.tools[0]!;
    const second = manager.list().find((entry) => entry.name === 'a_b')!.tools[0]!;
    assert.notEqual(first, second);
    assert.equal(registry.list().length, 0, 'connector schemas stay out of the default prompt');
    assert.equal(registry.searchDeferred('large').length, 2);
    manager.disable('a.b');
    assert.equal(registry.get(first), undefined);
    assert.ok(registry.get(second), 'colliding sanitized server name remains registered');
    const result = await registry.get(second)!.run({}, { workspaceRoot: f.root, signal: new AbortController().signal, maxToolResultChars: 300 } as ToolContext);
    assert.ok(result.ok && result.data);
    const connection = manager.reconnect('slow-start', { ...cfg, args: [f.script, f.log, '500'] });
    manager.disable('slow-start');
    assert.equal((await connection).ok, false);
    assert.equal(manager.list().find((entry) => entry.name === 'slow-start')?.tools.length, 0);
    assert.equal((await manager.reconnect('a_b', { ...cfg, toolNames: [] })).tools.length, 0);
    assert.equal(registry.get(second), undefined);
  } finally { manager.stopAll(); await removeFixtureTree(f.root); }
});

test('HTTP SSE progress arrives before result, cancellation reaches remote and initialize is never cancelled', async () => {
  const requests: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = [];
  const hanging = new Set<ServerResponse>();
  let delayInitialize = false;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => body += chunk);
    req.on('end', () => {
      const rpc = JSON.parse(body); requests.push(rpc);
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
      if (rpc.method === 'initialize' && delayInitialize) { hanging.add(res); return; }
      if (rpc.method !== 'tools/call') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({jsonrpc:'2.0', id:rpc.id, result:{}})); return; }
      res.writeHead(200, { 'content-type':'text/event-stream' });
      res.write(`data: ${JSON.stringify({jsonrpc:'2.0', method:'notifications/progress', params:{progressToken:rpc.params._meta.progressToken, progress:1, total:2}})}\n\n`);
      if (rpc.params.name === 'hang') { hanging.add(res); return; }
      setTimeout(() => res.end(`data: ${JSON.stringify({jsonrpc:'2.0', id:rpc.id, result:{content:[{type:'text', text:'done'}]}})}\n\n`), 80);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}/mcp`;
  let settled = false;
  let observed = 0;
  const client = new McpHttpClient('http', url, {}, 1000, { onProgress: () => { assert.equal(settled, false); observed++; } });
  try {
    await client.start();
    const result = await client.callTool('finish', {}, 'exec');
    settled = true;
    assert.equal(observed, 1);
    assert.equal(result.ok, true);
    settled = false;
    const ac = new AbortController();
    const hangingCall = client.callTool('hang', {}, 'exec', ac.signal);
    await until(() => observed === 2);
    ac.abort();
    assert.equal((await hangingCall).ok, false);
    await until(() => requests.some((request) => request.method === 'notifications/cancelled'));
    const hang = requests.find((request) => request.method === 'tools/call' && request.params?.name === 'hang')!;
    assert.ok(requests.some((request) => request.method === 'notifications/cancelled' && request.params?.requestId === hang.id));
    delayInitialize = true;
    const count = requests.filter((request) => request.method === 'notifications/cancelled').length;
    const stalled = new McpHttpClient('init', url, {}, 100);
    await assert.rejects(stalled.start());
    assert.equal(requests.filter((request) => request.method === 'notifications/cancelled').length, count);
    stalled.stop();
  } finally { client.stop(); for (const res of hanging) res.destroy(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});
