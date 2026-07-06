import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disableMcpServer, enableContextCooler, mcpListLines, mcpServerLines } from '../src/mcp/manage.js';

test('enableContextCooler resolves an explicit checkout path without saving global config', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-cooler-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'server.js'), 'console.log("ok")\n');

  const change = enableContextCooler({}, root);
  assert.equal(change.ok, true);
  assert.deepEqual(change.servers['context-cooler'], { command: 'node', args: [join(root, 'dist', 'server.js')] });
});

test('disableMcpServer removes a server from an in-memory map', () => {
  const change = disableMcpServer({ local: { command: 'node', args: ['server.js'] } }, 'local');
  assert.equal(change.ok, true);
  assert.deepEqual(change.servers, {});

  const missing = disableMcpServer({}, 'missing');
  assert.equal(missing.ok, false);
  assert.match(missing.message, /No MCP server/);
});

test('mcp formatters summarize list and detail views', () => {
  const servers = {
    remote: { url: 'https://example.test/mcp', headers: { Authorization: 'secret' } },
    local: { command: 'node', args: ['server.js'] },
  };
  assert.match(mcpListLines(servers).join('\n'), /remote\s+http/);
  assert.match(mcpServerLines('remote', servers.remote).join('\n'), /headers: Authorization/);
  assert.doesNotMatch(mcpServerLines('remote', servers.remote).join('\n'), /secret/);
});
