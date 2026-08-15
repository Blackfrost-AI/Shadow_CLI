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

test('a configured vision endpoint is on-tool-use egress + warning; absent config, no line', () => {
  const cfg: PrivacyConfigView = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    vision: { baseUrl: 'https://vision.example.com/v1' },
  };
  const r = buildPrivacyReport(cfg, baseEnv());
  const vision = find(r, 'Vision endpoint');
  assert.equal(vision.target, 'vision.example.com');
  assert.equal(vision.active, true);
  assert.equal(vision.scope, 'on-tool-use');
  assert.ok(r.warnings.some((w) => w.includes('vision.example.com')), 'warns that images go to the vision host');

  const bare = buildPrivacyReport({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, baseEnv());
  assert.ok(!bare.egress.some((e) => e.name.startsWith('Vision endpoint')), 'no vision line without vision config');
});

test('a LOCAL vision endpoint is listed but raises no egress warning', () => {
  const cfg: PrivacyConfigView = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    vision: { baseUrl: 'http://127.0.0.1:8001/v1' },
  };
  const r = buildPrivacyReport(cfg, baseEnv());
  assert.equal(find(r, 'Vision endpoint').active, true);
  assert.ok(!r.warnings.some((w) => w.includes('describe_media')), 'local vision endpoint is not a leak warning');
});

test('an uncached repo-id preset surfaces the first-serve HuggingFace weight download; no repo-id presets, no line', () => {
  // A repo id that cannot exist in the local HF cache — the download line MUST appear.
  const cfg: PrivacyConfigView = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [{ label: 'qwen-mlx', mlx: 'mlx-community/shadow-privacy-doctor-test-model-does-not-exist-4bit' }],
  };
  const r = buildPrivacyReport(cfg, baseEnv());
  const weights = find(r, 'Model weights "qwen-mlx"');
  assert.equal(weights.target, 'huggingface.co');
  assert.equal(weights.scope, 'on-connect');
  assert.match(weights.note!, /first serve only/);
  assert.ok(r.warnings.some((w) => w.includes('huggingface.co')), 'warns about the pending weight download');

  // gguf / local-dir presets never download — no line.
  const local = buildPrivacyReport(
    { provider: 'openai', baseUrl: 'https://api.openai.com/v1', models: [{ label: 'gguf', gguf: '/models/q4.gguf' }] },
    baseEnv(),
  );
  assert.ok(!local.egress.some((e) => e.name.startsWith('Model weights')), 'no weight-download line without a repo-id preset');
});

test('configured hooks and statusLine are listed as arbitrary-shell paths, ACTIVE even offline; absent, no lines', () => {
  const cfg: PrivacyConfigView = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    hooks: { pre_tool_use: ['/Users/me/.shadow/hooks/lint.sh'], post_tool_use: [] },
    statusLine: 'git branch --show-current',
  };
  const r = buildPrivacyReport(cfg, baseEnv({ offline: true }));
  const hooks = find(r, 'Hooks');
  assert.equal(hooks.active, true, 'offline mode cannot stop a hook script from reaching the network');
  assert.match(hooks.target, /1 configured hook script/);
  assert.match(hooks.note!, /arbitrary commands, including network/);
  const status = find(r, 'Status line');
  assert.equal(status.active, true);
  assert.match(status.target, /git branch --show-current/);

  const bare = buildPrivacyReport({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', hooks: { pre_tool_use: [] } }, baseEnv());
  assert.ok(!bare.egress.some((e) => e.name === 'Hooks'), 'no hooks line when no hook scripts are configured');
  assert.ok(!bare.egress.some((e) => e.name === 'Status line'), 'no statusLine line when unset');
});

test('an npx-launched MCP server (browser preset) also reports the npm-registry package resolve; a plain command server does not', () => {
  const cfg: PrivacyConfigView = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    mcpServers: {
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.79', '--isolated'] },
      local: { command: 'node', args: ['server.js'] },
    },
  };
  const r = buildPrivacyReport(cfg, baseEnv());
  const npm = find(r, 'npm registry (MCP "playwright")');
  assert.equal(npm.target, 'registry.npmjs.org');
  assert.equal(npm.scope, 'on-connect');
  assert.equal(npm.active, true);
  assert.ok(r.warnings.some((w) => w.includes('npm registry')), 'first-connect package resolve is warned about');
  assert.ok(!r.egress.some((e) => e.name === 'npm registry (MCP "local")'), 'a non-npx command server adds no registry line');
});


test('P3-07: the plugin index is opt-in — absent by default, listed + warned when configured, signed-status reported', () => {
  // Default: NO central catalog — the path simply does not exist in the report.
  const bare = buildPrivacyReport({ provider: 'anthropic' }, baseEnv());
  assert.ok(!bare.egress.some((e) => e.name.startsWith('Plugin index')), 'no index configured = no path');

  // Unsigned index: listed as opt-in + active, with an explicit NOT-verified warning.
  const unsigned = buildPrivacyReport(
    { provider: 'anthropic', pluginIndexUrl: 'https://index.example/plugins.json' },
    baseEnv(),
  );
  const row = find(unsigned, 'Plugin index');
  assert.equal(row.target, 'index.example');
  assert.equal(row.active, true);
  assert.equal(row.scope, 'opt-in');
  assert.ok(row.note && row.note.includes('UNSIGNED'));
  assert.ok(unsigned.warnings.some((w) => w.includes('pluginIndexUrl') && w.includes('WITHOUT')));

  // Signed index: verification state is surfaced in the note.
  const signed = buildPrivacyReport(
    { provider: 'anthropic', pluginIndexUrl: 'https://index.example/plugins.json', pluginIndexKey: 'pem' },
    baseEnv(),
  );
  const signedRow = find(signed, 'Plugin index');
  assert.ok(signedRow.note && signedRow.note.includes('signature-verified'));
  assert.ok(!signed.warnings.some((w) => w.includes('WITHOUT')));

  // Offline suppresses it like every other outbound path.
  const off = buildPrivacyReport(
    { provider: 'anthropic', pluginIndexUrl: 'https://index.example/plugins.json' },
    baseEnv({ offline: true }),
  );
  assert.equal(find(off, 'Plugin index').active, false);
});

test('P3-07: the plugin-install git clone is disclosed as a broker-bypassing egress path', () => {
  // The capability exists in every install regardless of config — it must always be listed.
  const r = buildPrivacyReport({ provider: 'anthropic' }, baseEnv());
  const clone = find(r, 'Plugin install (git clone)');
  assert.equal(clone.scope, 'opt-in');
  assert.equal(clone.active, true);
  assert.ok(clone.note && clone.note.includes('plugin-clone'), 'the receipt purpose is named');

  // Offline: the manager refuses non-local clones, so the path is inactive.
  const off = buildPrivacyReport({ provider: 'anthropic' }, baseEnv({ offline: true }));
  assert.equal(find(off, 'Plugin install (git clone)').active, false);
});
