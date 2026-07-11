import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrivacyReport, type PrivacyConfigView, type PrivacyEnv } from '../src/doctor/privacy.js';

const baseEnv = (over: Partial<PrivacyEnv> = {}): PrivacyEnv => ({
  offline: false,
  credStore: 'vault',
  keychainAvailable: true,
  ...over,
});

const find = (r: ReturnType<typeof buildPrivacyReport>, name: string) => r.egress.find((e) => e.name.startsWith(name))!;

test('a cloud provider config: provider + web tools are live egress; update check is off by default', () => {
  const cfg: PrivacyConfigView = { provider: 'openai', model: 'glm-4.6', baseUrl: 'https://api.z.ai/api/coding/paas/v4' };
  const r = buildPrivacyReport(cfg, baseEnv());
  assert.equal(r.providerIsLocal, false);
  assert.equal(find(r, 'Model provider').active, true);
  assert.equal(find(r, 'Model provider').target, 'api.z.ai');
  assert.equal(find(r, 'Web tools').active, true);
  assert.equal(find(r, 'Update check').active, false, 'update check off by default');
  assert.ok(r.warnings.some((w) => w.includes('api.z.ai')), 'warns that prompts go to the provider');
});

test('NEVER under-reports: the three baseline egress paths are ALWAYS listed', () => {
  // Even a minimal config lists provider + web tools + update check, so a reader never assumes a path
  // simply because it was omitted.
  const r = buildPrivacyReport({ provider: 'anthropic' }, baseEnv({ credStore: 'env-only' }));
  for (const name of ['Model provider', 'Web tools', 'Update check']) {
    assert.ok(find(r, name), `${name} is always present in the report`);
  }
  // Anthropic default endpoint is inferred when no baseUrl is set.
  assert.equal(find(r, 'Model provider').target, 'api.anthropic.com');
});

test('offline mode flips every outbound path to inactive and drops the provider warning', () => {
  const cfg: PrivacyConfigView = {
    provider: 'openai',
    model: 'glm-4.6',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    updateCheck: true,
    mcpServers: { remote: { url: 'https://mcp.example.com/sse' } },
  };
  const r = buildPrivacyReport(cfg, baseEnv({ offline: true }));
  for (const e of r.egress) assert.equal(e.active, false, `${e.name} is inactive offline`);
  assert.equal(r.warnings.length, 0, 'no "leaves this machine" warnings when nothing can leave');
});

test('opt-in update check ON is reported as live egress + a warning', () => {
  const cfg: PrivacyConfigView = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', updateCheck: true };
  const r = buildPrivacyReport(cfg, baseEnv());
  assert.equal(find(r, 'Update check').active, true);
  assert.ok(r.warnings.some((w) => w.includes('raw.githubusercontent.com')));
});

test('an http MCP server is surfaced as an outbound connector + warning; a command server is a local process', () => {
  const cfg: PrivacyConfigView = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    mcpServers: {
      remote: { url: 'https://mcp.example.com/x' },
      local: { command: 'node', args: ['server.js'] },
    },
  };
  const r = buildPrivacyReport(cfg, baseEnv());
  const remote = find(r, 'MCP server "remote"');
  assert.equal(remote.target, 'mcp.example.com');
  assert.ok(r.warnings.some((w) => w.includes('mcp.example.com')), 'http MCP raises a connector warning');
  const local = find(r, 'MCP server "local"');
  assert.match(local.target, /local process: node server\.js/);
  assert.ok(!r.warnings.some((w) => w.includes('"local"')), 'a local-process MCP is not an egress warning');
});

test('plaintext credentials raise a warning and report the plaintext store', () => {
  const r = buildPrivacyReport({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, baseEnv({ credStore: 'plaintext' }));
  assert.equal(r.credentials.store, 'plaintext');
  assert.ok(r.warnings.some((w) => /plaintext/i.test(w) && /onboard --web/.test(w)));
});

test('a local model endpoint is offline-eligible and raises no provider egress warning', () => {
  const cfg: PrivacyConfigView = { provider: 'openai', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' };
  const r = buildPrivacyReport(cfg, baseEnv());
  assert.equal(r.providerIsLocal, true);
  assert.equal(r.offlineEligible.eligible, true);
  assert.ok(!r.warnings.some((w) => w.includes('prompts')), 'no cloud-egress warning for a local model');
});
