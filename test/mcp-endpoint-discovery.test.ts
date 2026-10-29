import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEndpointDiscoveryPeer, ENDPOINT_DISCOVERY_RESOURCE_URI } from '../src/mcp/endpointDiscovery.js';
import { emptyEndpointRegistry } from '../src/endpoints/types.js';

function peerLines() {
  const lines: string[] = [];
  const peer = createEndpointDiscoveryPeer({
    loadRegistry: () => ({ ...emptyEndpointRegistry('now'), revision: 3, endpoints: [{ id: 'ep', label: 'local', provider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', credentialRef: 'secret-ref', createdAt: 'now', updatedAt: 'now' }], observations: [] }),
    writeLine: (line) => lines.push(line),
  });
  return { peer, lines };
}

function feedRequest(peer: ReturnType<typeof createEndpointDiscoveryPeer>, id: number, method: string, params?: unknown) {
  peer.feed(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
}

function result(lines: string[], id: number): any {
  return JSON.parse(lines.find((line) => JSON.parse(line).id === id)!);
}

test('inventory server negotiates, lists, and reads a bounded resource', async () => {
  const { peer, lines } = peerLines();
  feedRequest(peer, 1, 'initialize');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result(lines, 1).result.serverInfo.name, 'shadow-endpoint-discovery');
  feedRequest(peer, 2, 'resources/list');
  feedRequest(peer, 3, 'resources/read', { uri: ENDPOINT_DISCOVERY_RESOURCE_URI });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result(lines, 2).result.resources[0].uri, ENDPOINT_DISCOVERY_RESOURCE_URI);
  const text = result(lines, 3).result.contents[0].text;
  assert.equal(text.includes('secret-ref'), false);
  assert.equal(JSON.parse(text).endpoints[0].baseUrl, 'http://127.0.0.1:8000/v1');
});

test('inventory server refuses unknown resources and unknown methods', async () => {
  const { peer, lines } = peerLines();
  feedRequest(peer, 1, 'resources/read', { uri: 'shadow://other' });
  feedRequest(peer, 2, 'tools/list');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result(lines, 1).error.code, -32602);
  assert.equal(result(lines, 2).error.code, -32601);
});
