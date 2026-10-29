import { createInterface } from 'node:readline';
import { loadEndpointRegistry } from '../endpoints/store.js';
import type { EndpointRegistryState } from '../endpoints/types.js';
import { RpcFailure, RpcPeer } from '../acp/jsonrpc.js';

export const ENDPOINT_DISCOVERY_PROTOCOL = '2026-06-18';
export const ENDPOINT_DISCOVERY_RESOURCE_URI = 'shadow://endpoints/registry';
const MAX_RESOURCE_BYTES = 64 * 1024;

export interface EndpointDiscoveryServerOptions {
  loadRegistry?: () => EndpointRegistryState;
  writeLine?: (line: string) => void;
}

function publicRegistry(load: () => EndpointRegistryState): Record<string, unknown> {
  const state = load();
  return {
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    updatedAt: state.updatedAt,
    endpoints: state.endpoints.map(({ id, label, provider, baseUrl, model, selfHosted, follow, createdAt, updatedAt }) => ({
      id, label, provider, baseUrl, model, selfHosted, follow, createdAt, updatedAt,
    })),
    observations: state.observations,
  };
}

function resource(load: () => EndpointRegistryState): { uri: string; name: string; mimeType: string; text: string } {
  const text = JSON.stringify(publicRegistry(load));
  if (Buffer.byteLength(text, 'utf8') > MAX_RESOURCE_BYTES) throw new RpcFailure(-32603, 'endpoint inventory exceeds the MCP resource limit');
  return { uri: ENDPOINT_DISCOVERY_RESOURCE_URI, name: 'Saved endpoint inventory', mimeType: 'application/json', text };
}

export function createEndpointDiscoveryPeer(options: EndpointDiscoveryServerOptions = {}): RpcPeer {
  const load = options.loadRegistry ?? (() => loadEndpointRegistry());
  const writeLine = options.writeLine ?? ((line) => process.stdout.write(line));
  return new RpcPeer(writeLine, {
    async request(method, params) {
      if (method === 'initialize') {
        return {
          protocolVersion: ENDPOINT_DISCOVERY_PROTOCOL,
          capabilities: { resources: { listChanged: false, subscribe: false } },
          serverInfo: { name: 'shadow-endpoint-discovery', version: '11.0.0' },
        };
      }
      if (method === 'resources/list') {
        return { resources: [{ uri: ENDPOINT_DISCOVERY_RESOURCE_URI, name: 'Saved endpoint inventory', mimeType: 'application/json' }] };
      }
      if (method === 'resources/read') {
        const uri = params && typeof params === 'object' ? (params as { uri?: unknown }).uri : undefined;
        if (uri !== ENDPOINT_DISCOVERY_RESOURCE_URI) throw new RpcFailure(-32602, 'unknown resource URI');
        return { contents: [resource(load)] };
      }
      throw new RpcFailure(-32601, `method not found: ${method}`);
    },
    notification() {
      // notifications/initialized and unknown notifications are intentionally no-ops.
    },
  });
}

export function runEndpointDiscoveryServer(options: EndpointDiscoveryServerOptions = {}): Promise<void> {
  const peer = createEndpointDiscoveryPeer(options);
  const input = options.writeLine ? undefined : createInterface({ input: process.stdin });
  return new Promise((resolve) => {
    if (!input) return resolve();
    input.on('line', (line) => peer.feed(`${line}\n`));
    input.on('close', resolve);
  });
}
