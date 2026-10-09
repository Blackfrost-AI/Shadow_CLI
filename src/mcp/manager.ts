import { ToolRegistry } from '../tools/registry.js';
import { registerMcpServers, type McpConnection, type McpJail } from './client.js';
import type { McpServerConfig } from './manage.js';
import type { McpRuntimeOptions, McpCallEvent } from './lifecycle.js';

export interface McpServerSnapshot {
  name: string;
  state: 'connecting' | 'ready' | 'unavailable' | 'disabled';
  transport: 'stdio' | 'http';
  tools: string[];
  activeCalls: McpCallEvent[];
  lastActivityAt: number;
}
export interface McpManagerOptions extends Pick<McpRuntimeOptions, 'onProgress' | 'onCallStart' | 'onCallEnd'> {
  registry: ToolRegistry;
  workspaceRoot: string;
  jail?: Omit<McpJail, 'workspaceRoot'>;
}
export interface McpManager {
  reconnect(name: string, config: McpServerConfig): Promise<{ ok: boolean; message: string; tools: string[] }>;
  disable(name: string): boolean;
  test(name: string, config: McpServerConfig): Promise<{ ok: boolean; tools: string[] }>;
  list(): McpServerSnapshot[];
  stopAll(): void;
}
interface ManagedServer extends McpServerSnapshot { epoch: number; clients: McpConnection[] }

/** Own connector lifecycle and exact tool names; sanitized-name collisions never remove another server's tools. */
export function createMcpManager(options: McpManagerOptions): McpManager {
  const records = new Map<string, ManagedServer>();
  let epoch = 0;
  let stopped = false;
  const disconnect = (record: ManagedServer): void => {
    record.epoch = ++epoch;
    for (const name of record.tools) options.registry.unregister(name);
    record.tools = [];
    for (const client of record.clients) client.stop();
    record.clients = [];
    record.activeCalls = [];
    record.state = 'disabled';
    record.lastActivityAt = Date.now();
  };
  const manager: McpManager = {
    async reconnect(name, config) {
      if (stopped) return { ok: false, message: 'MCP manager has stopped.', tools: [] };
      const previous = records.get(name);
      if (previous) disconnect(previous);
      const record: ManagedServer = { name, epoch: ++epoch, clients: [], tools: [], activeCalls: [], transport: config.url ? 'http' : 'stdio', state: 'connecting', lastActivityAt: Date.now() };
      records.set(name, record);
      const generation = record.epoch;
      const active = (): boolean => !stopped && records.get(name) === record && generation === record.epoch;
      const clients = await registerMcpServers(options.registry, { [name]: { ...config, deferTools: config.deferTools ?? true } }, options.workspaceRoot, (client) => {
        if (active()) record.clients.push(client); else client.stop();
      }, options.jail, {
        isActive: active,
        onRegistered: (_server, tool) => { if (active()) record.tools.push(tool); else options.registry.unregister(tool); },
        onProgress: (event) => {
          if (!active()) return;
          record.lastActivityAt = event.lastActivityAt;
          const call = record.activeCalls.find((item) => item.progressToken === event.progressToken);
          if (call) call.lastActivityAt = event.lastActivityAt;
          options.onProgress?.(event);
        },
        onCallStart: (event) => {
          if (!active()) return;
          record.activeCalls.push(event); record.lastActivityAt = event.lastActivityAt;
          options.onCallStart?.(event);
        },
        onCallEnd: (event) => {
          record.activeCalls = record.activeCalls.filter((item) => item.progressToken !== event.progressToken);
          record.lastActivityAt = event.lastActivityAt;
          options.onCallEnd?.(event);
        },
      });
      if (!active()) { for (const client of clients) client.stop(); return { ok: false, message: `Connection to ${name} was superseded.`, tools: [] }; }
      record.state = clients.length ? 'ready' : 'unavailable';
      return { ok: clients.length > 0, message: clients.length ? `Connected ${name}: ${record.tools.length} tools.` : `Could not connect ${name}; inspect its configuration and retry.`, tools: [...record.tools] };
    },
    disable(name) {
      const record = records.get(name);
      if (!record) return false;
      disconnect(record);
      return true;
    },
    async test(name, config) {
      const registry = new ToolRegistry();
      const constructed: McpConnection[] = [];
      try {
        const clients = await registerMcpServers(registry, { [name]: config }, options.workspaceRoot, (client) => constructed.push(client), options.jail);
        return { ok: clients.length > 0, tools: registry.list({ includeDeferred: true }).filter((tool) => tool.name !== 'mcp_artifact').map((tool) => tool.name) };
      } finally { for (const client of constructed) client.stop(); }
    },
    list() {
      return [...records.values()].map(({ name, state, transport, tools, activeCalls, lastActivityAt }) => ({ name, state, transport, tools: [...tools], activeCalls: activeCalls.map((call) => ({ ...call })), lastActivityAt }));
    },
    stopAll() { stopped = true; for (const record of records.values()) disconnect(record); },
  };
  return manager;
}
