import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { registerMcpServers } from '../src/mcp/client.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ENTRY = join(REPO_ROOT, 'src', 'index.ts');

function runShadow(home: string, ...args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx/esm', SOURCE_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('browser MCP public CLI persists the playwright preset and disables it by its config key', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-browser-cli-'));
  const shadowDir = join(home, '.shadow');
  const configPath = join(shadowDir, 'config.json');
  mkdirSync(shadowDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      theme: 'dark',
      mcpServers: { existing: { url: 'https://example.test/mcp' } },
    }),
  );

  try {
    const enabledOutput = runShadow(home, 'mcp', 'enable', 'browser');
    assert.match(enabledOutput, /Enabled Playwright browser MCP/);
    assert.match(enabledOutput, /Restart Shadow to load browser tools/);

    const enabled = JSON.parse(readFileSync(configPath, 'utf8')) as {
      theme?: string;
      mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }>;
    };
    assert.equal(enabled.theme, 'dark', 'unrelated global configuration is preserved');
    assert.deepEqual(enabled.mcpServers?.existing, { url: 'https://example.test/mcp' });
    assert.deepEqual(enabled.mcpServers?.playwright, {
      command: 'npx',
      args: [
        '-y',
        '@playwright/mcp@0.0.79',
        '--isolated',
        '--browser',
        'chrome',
        '--output-dir',
        resolve(home, '.shadow', 'playwright-output'),
        '--output-max-size',
        '52428800',
      ],
    });

    const disabledOutput = runShadow(home, 'mcp', 'disable', 'playwright');
    assert.match(disabledOutput, /Disabled MCP server "playwright"/);
    const disabled = JSON.parse(readFileSync(configPath, 'utf8')) as {
      theme?: string;
      mcpServers?: Record<string, unknown>;
    };
    assert.equal(disabled.theme, 'dark');
    assert.deepEqual(disabled.mcpServers, { existing: { url: 'https://example.test/mcp' } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('playwright stdio MCP registers a callable exec-risk browser tool', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-browser-mcp-'));
  const fixture = join(root, 'fake-playwright-mcp.mjs');
  writeFileSync(
    fixture,
    String.raw`import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const reply = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
};

lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-playwright', version: '1.0.0' },
    });
    return;
  }
  if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [{
        name: 'browser_navigate',
        description: 'Navigate the isolated test browser',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
        annotations: { readOnlyHint: true },
      }],
    });
    return;
  }
  if (message.method === 'tools/call') {
    const url = message.params?.arguments?.url ?? '';
    reply(message.id, { content: [{ type: 'text', text: 'navigated ' + url }] });
    return;
  }
  reply(message.id, {});
});
`,
  );

  const registry = new ToolRegistry();
  const clients = await registerMcpServers(
    registry,
    { playwright: { command: process.execPath, args: [fixture] } },
    root,
  );
  t.after(() => {
    for (const client of clients) client.stop();
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal(clients.length, 1, 'the stdio server completed the MCP handshake');
  const tool = registry.get('mcp_playwright_browser_navigate');
  assert.ok(tool, 'Playwright tools use the stable mcp_playwright_* namespace');
  assert.equal(tool.risk, 'exec', 'server-declared readOnlyHint never bypasses approval');
  assert.equal(tool.inputSchema.safeParse({ url: 'http://127.0.0.1/test' }).success, true);
  assert.equal(tool.inputSchema.safeParse({}).success, false);

  const context: ToolContext = {
    workspaceRoot: root,
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
  };
  const result = await tool.run({ url: 'http://127.0.0.1/test' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.meta.tool, 'mcp_playwright_browser_navigate');
  assert.equal(result.meta.risk, 'exec');
  assert.match(result.summary, /navigated http:\/\/127\.0\.0\.1\/test/);
});
