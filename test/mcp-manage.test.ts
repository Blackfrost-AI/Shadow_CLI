import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  disableMcpServer,
  enableContextCooler,
  enablePlaywrightBrowser,
  mcpListLines,
  mcpServerLines,
  PLAYWRIGHT_MCP_PACKAGE,
} from '../src/mcp/manage.js';

test('enableContextCooler resolves an explicit checkout path without saving global config', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-cooler-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'server.js'), 'console.log("ok")\n');

  const change = enableContextCooler({}, root);
  assert.equal(change.ok, true);
  assert.deepEqual(change.servers['context-cooler'], { command: 'node', args: [join(root, 'dist', 'server.js')] });
});

test('enablePlaywrightBrowser adds the exact isolated Chrome preset', () => {
  assert.equal(PLAYWRIGHT_MCP_PACKAGE, '@playwright/mcp@0.0.79');
  const change = enablePlaywrightBrowser({});

  assert.equal(change.ok, true);
  assert.deepEqual(change.servers, {
    playwright: {
      command: 'npx',
      args: [
        '-y',
        '@playwright/mcp@0.0.79',
        '--isolated',
        '--browser',
        'chrome',
        '--output-dir',
        resolve(homedir(), '.shadow', 'playwright-output'),
        '--output-max-size',
        '52428800',
      ],
      // P3-08: the preset opts this ONE server out of the OS jail explicitly (a browsing browser
      // needs sockets + broad fs access); its isolation is the `--isolated` profile + capped output.
      network: true,
      sandbox: false,
    },
  });
});

test('enablePlaywrightBrowser preserves unrelated MCP servers', () => {
  const servers = {
    local: { command: 'node', args: ['server.js'] },
    remote: { url: 'https://example.test/mcp' },
  };
  const change = enablePlaywrightBrowser(servers);

  assert.equal(change.ok, true);
  assert.notEqual(change.servers, servers);
  assert.deepEqual(change.servers.local, servers.local);
  assert.deepEqual(change.servers.remote, servers.remote);
});

test('enablePlaywrightBrowser is idempotent and never overwrites an existing Playwright entry', () => {
  const servers = {
    playwright: { command: '/custom/npx', args: ['@playwright/mcp@custom', '--headless'] },
    local: { command: 'node', args: ['server.js'] },
  };
  const change = enablePlaywrightBrowser(servers);

  assert.equal(change.ok, false);
  assert.equal(change.servers, servers);
  assert.deepEqual(change.servers, servers);
  assert.match(change.message, /already configured/i);
  assert.match(change.message, /inspect.*playwright|disable.*playwright/i);

  const enabled = enablePlaywrightBrowser({});
  const repeated = enablePlaywrightBrowser(enabled.servers);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.servers, enabled.servers);
  assert.deepEqual(repeated.servers.playwright, enabled.servers.playwright);
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
  assert.match(mcpListLines({})[0]!, /enable browser.*enable context-cooler/);
});
