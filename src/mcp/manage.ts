import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { loadGlobalConfig, saveGlobalConfig } from '../state/globalStore.js';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export type McpServers = Record<string, McpServerConfig>;

export interface McpChange {
  ok: boolean;
  message: string;
  servers: McpServers;
}

export function loadGlobalMcpServers(): McpServers {
  const cfg = loadGlobalConfig();
  return { ...((cfg.mcpServers as McpServers | undefined) ?? {}) };
}

export function saveGlobalMcpServers(servers: McpServers): void {
  saveGlobalConfig({ mcpServers: servers });
}

/** Resolve Context Cooler's dist/server.js from an explicit path or known locations. */
export function resolveContextCooler(pathArg?: string): string | null {
  const candidates: string[] = [];
  if (pathArg) candidates.push(pathArg.endsWith('.js') ? resolve(pathArg) : resolve(pathArg, 'dist/server.js'));
  const h = homedir();
  candidates.push(
    resolve(h, '.shadow-code/context-cooler/dist/server.js'),
    resolve(h, 'context-cooler/dist/server.js'),
    resolve(h, 'Documents/Claude Projects/context-cooler/dist/server.js'),
  );
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function enableContextCooler(servers: McpServers, pathArg?: string): McpChange {
  const server = resolveContextCooler(pathArg);
  if (!server) {
    return {
      ok: false,
      servers,
      message:
        'Could not find Context Cooler. Use: /mcp enable context-cooler --path /path/to/context-cooler',
    };
  }
  return {
    ok: true,
    servers: { ...servers, 'context-cooler': { command: 'node', args: [server] } },
    message: `Enabled Context Cooler -> ${server}`,
  };
}

export function disableMcpServer(servers: McpServers, name: string): McpChange {
  if (!name) return { ok: false, servers, message: 'usage: /mcp disable <name>' };
  if (!(name in servers)) return { ok: false, servers, message: `No MCP server "${name}" configured.` };
  const next = { ...servers };
  delete next[name];
  return { ok: true, servers: next, message: `Disabled MCP server "${name}".` };
}

export function mcpServerLines(name: string, server: McpServerConfig): string[] {
  if (server.url) {
    return [
      `${name}`,
      `  transport: http`,
      `  url: ${server.url}`,
      `  headers: ${server.headers ? Object.keys(server.headers).join(', ') || 'none' : 'none'}`,
    ];
  }
  return [
    `${name}`,
    `  transport: stdio`,
    `  command: ${server.command ?? 'unknown'}`,
    `  args: ${(server.args ?? []).join(' ') || 'none'}`,
    `  env: ${server.env ? Object.keys(server.env).join(', ') || 'none' : 'none'}`,
  ];
}

export function mcpListLines(servers: McpServers): string[] {
  const names = Object.keys(servers).sort();
  if (!names.length) return ['No MCP servers configured. Try: /mcp enable context-cooler'];
  return names.map((name) => {
    const server = servers[name]!;
    const transport = server.url ? 'http' : 'stdio';
    const target = server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
    return `${name.padEnd(18)} ${transport.padEnd(5)} ${target || '(missing target)'}`;
  });
}
