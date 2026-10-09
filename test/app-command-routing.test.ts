import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { ModelEntry } from '../src/config.js';
import type { PermissionRule } from '../src/safety/rules.js';
import type { FlattenItem } from '../src/tui/flatten.js';
import type { Component } from '@earendil-works/pi-tui';
import type { McpManager } from '../src/mcp/manager.js';
import type { McpServerConfig } from '../src/mcp/manage.js';

const isolated = isolateHome('pi-commands');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, isolated.home);
const { ShadowApp } = await import('../src/app/app.js');
const { recordEgress } = await import('../src/safety/egress.js');
const { findSlashCommand, runSlashCommand } = await import('../src/tui/slash.js');
after(() => rmSync(isolated.home, { recursive: true, force: true }));

function workspace(t: { after(fn: () => void): void }, gitRepo = true) {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-pi-commands-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (gitRepo) {
    git('init', '-q', '-b', 'fixture-main');
    git('config', 'user.name', 'Command Test');
    git('config', 'user.email', 'commands@example.test');
    writeFileSync(join(cwd, 'tracked.txt'), 'before\n');
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  }
  return { cwd, git };
}

interface HarnessConfig {
  provider: string;
  model: string;
  permissionRules: PermissionRule[];
  models: ModelEntry[];
  contextBudget: number;
  autoClassifier: boolean;
  fastMode: boolean;
  effort: string;
  cacheTtl: string;
  parallelTools: boolean;
  temperature: number;
  maxIterations: number;
  [key: string]: unknown;
}

interface HarnessOptions {
  cfg?: Partial<HarnessConfig>;
  state?: Record<string, unknown>;
  mcpManager?: McpManager;
}

function resetGlobalConfig(config: Record<string, unknown> = {}): void {
  writeFileSync(join(isolated.shadowDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

function harness(workspaceRoot: string, rules: PermissionRule[] = [], options: HarnessOptions = {}) {
  const output: Array<Partial<FlattenItem>> = [];
  const resumed: string[] = [];
  const applied: PermissionRule[][] = [];
  const autonomyUpdates: string[] = [];
  let overlay: Component | undefined;
  const session = { sentinel: 'existing session' };
  const cfg: HarnessConfig = {
    provider: 'mock',
    model: 'mock-model',
    permissionRules: rules,
    models: [],
    contextBudget: 128_000,
    autoClassifier: false,
    fastMode: false,
    effort: 'high',
    cacheTtl: '5m',
    parallelTools: true,
    temperature: 1,
    maxIterations: 0,
    ...options.cfg,
  };
  // Exercise the production dispatcher and real git/config behavior without owning a TTY.
  const app = Object.assign(Object.create(ShadowApp.prototype), {
    opts: { workspaceRoot, version: '9.0.0-test', cfg, context: session, mcpManager: options.mcpManager },
    running: false,
    compacting: false,
    modelChecking: false,
    autonomy: 'manual',
    current: { provider: cfg.provider, model: cfg.model },
    contextPct: 0,
    costUSD: 0,
    sessionInputTokens: 0,
    sessionOutputTokens: 0,
    sessionTurns: 0,
    previousTurnCostUSD: 0,
    previousTurnInputTokens: 0,
    previousTurnOutputTokens: 0,
    lastUsage: null,
    activeTarget: { selfHosted: false },
    goal: null,
    planMode: false,
    terminal: { rows: 36, columns: 120 },
    editor: {},
    tui: {
      showOverlay: (component: Component) => { overlay = component; return { hide: () => { overlay = undefined; } }; },
      setFocus: () => {},
      requestRender: () => {},
    },
    loopRef: {
      setPermissionRules: (next: PermissionRule[]) => applied.push(next),
      setAutonomy: (next: string) => autonomyUpdates.push(next),
    },
    hudState: () => ({}),
    pushLine: (line: Partial<FlattenItem>) => output.push(line),
    doResume: (arg: string) => resumed.push(arg),
    ...options.state,
  }) as {
    runSlash(raw: string): void;
    running: boolean;
    opts: { cfg: HarnessConfig; context: object };
    current: { provider: string; model: string };
    activeTarget: { baseUrl?: string; selfHosted: boolean };
  };
  return {
    app,
    output,
    resumed,
    applied,
    autonomyUpdates,
    session,
    overlay: () => overlay,
    overlayText: () => overlay?.render(120).join('\n') ?? '',
    text: () =>
      output
        .map((line) => [line.text, ...(line.lines ?? []).map((row) => row.text)].join('\n'))
        .join('\n'),
  };
}

test('pi autonomy updates the active loop as well as the displayed state', (t) => {
  const h = harness(workspace(t, false).cwd);

  h.app.runSlash('/autonomy full');

  assert.deepEqual(h.autonomyUpdates, ['full']);
  assert.match(h.text(), /autonomy: full/);
});

test('pi diff/files/branch report the actual workspace and never resume a session', (t) => {
  const f = workspace(t);
  writeFileSync(join(f.cwd, 'tracked.txt'), 'before\nafter\n');
  writeFileSync(join(f.cwd, 'untracked.txt'), 'new\n');
  const h = harness(f.cwd);
  h.app.runSlash('/diff');
  assert.match(h.overlayText(), /Uncommitted changes/);
  assert.match(h.overlayText(), /unstaged.*tracked\.txt/);
  assert.match(h.overlayText(), /untracked.*untracked\.txt/);
  h.overlay()!.handleInput!('\r');
  assert.match(h.overlayText(), /\+after/);
  h.overlay()!.handleInput!('\x1b');
  h.overlay()!.handleInput!('\x1b[B');
  h.overlay()!.handleInput!('\r');
  assert.match(h.overlayText(), /\+new/);
  h.overlay()!.handleInput!('\x1b');
  h.overlay()!.handleInput!('\x1b');
  assert.equal(h.overlay(), undefined, 'Escape returns through files and closes the browser');
  h.app.runSlash('/files');
  assert.match(h.text(), /\?\? untracked\.txt/);
  h.app.runSlash('/branch');
  assert.match(h.text(), /branch: fixture-main/);
  assert.deepEqual(h.resumed, []);
  assert.equal(h.app.opts.context, h.session);
  h.app.runSlash('/resume saved-session');
  assert.deepEqual(h.resumed, ['saved-session'], 'resume retains its own route');
});

test('pi workspace commands handle clean trees, detached HEAD and non-git directories', (t) => {
  const f = workspace(t);
  const h = harness(f.cwd);
  h.app.runSlash('/diff');
  assert.match(h.overlayText(), /No changes in this scope/);
  h.app.runSlash('/files');
  assert.match(h.text(), /No changed files/);
  f.git('checkout', '--detach', '-q');
  h.app.runSlash('/branch');
  assert.match(h.text(), /branch: detached HEAD/);
  const outside = harness(workspace(t, false).cwd);
  for (const command of ['/diff', '/files', '/branch']) outside.app.runSlash(command);
  assert.equal(outside.output.filter((line) => line.kind === 'error').length, 3);
  assert.deepEqual(outside.resumed, []);
});

test('pi permissions list is read-only; mutations persist globally and update the running loop', (t) => {
  const f = workspace(t, false);
  const globalPath = join(isolated.shadowDir, 'config.json');
  const initial = JSON.stringify({ models: [{ label: 'keep' }] });
  writeFileSync(globalPath, initial);
  writeFileSync(join(f.cwd, 'shadow.config.json'), '{"provider":"mock"}');
  const h = harness(f.cwd);
  h.app.runSlash('/permissions');
  h.app.runSlash('/permissions list');
  assert.equal(readFileSync(globalPath, 'utf8'), initial);
  h.app.runSlash('/permissions add deny run_shell /curl/');
  assert.deepEqual(h.app.opts.cfg.permissionRules, [
    { action: 'deny', tool: 'run_shell', pattern: 'curl' },
  ]);
  assert.deepEqual(
    JSON.parse(readFileSync(globalPath, 'utf8')).permissionRules,
    h.app.opts.cfg.permissionRules,
  );
  assert.deepEqual(h.applied.at(-1), h.app.opts.cfg.permissionRules);
  h.app.runSlash('/permissions set 0 ask run_shell');
  assert.equal(h.app.opts.cfg.permissionRules[0]!.action, 'ask');
  h.app.runSlash('/permissions remove 0');
  assert.deepEqual(h.app.opts.cfg.permissionRules, []);
  h.app.runSlash('/permissions add deny write_file');
  h.app.runSlash('/permissions clear');
  assert.deepEqual(h.applied.at(-1), []);
  assert.equal(readFileSync(join(f.cwd, 'shadow.config.json'), 'utf8'), '{"provider":"mock"}');
  assert.deepEqual(JSON.parse(readFileSync(globalPath, 'utf8')).models, [{ label: 'keep' }]);
  assert.deepEqual(h.resumed, []);
});

test('pi invalid permissions and failed saves leave active rules and session unchanged', (t) => {
  const h = harness(workspace(t, false).cwd, [{ tool: 'run_shell', action: 'deny' }]);
  const original = h.app.opts.cfg.permissionRules;
  h.app.runSlash('/permissions add invalid run_shell');
  assert.equal(h.app.opts.cfg.permissionRules, original);
  const globalPath = join(isolated.shadowDir, 'config.json');
  writeFileSync(globalPath, '{corrupt');
  t.after(() => resetGlobalConfig());
  h.app.runSlash('/permissions clear');
  assert.match(h.text(), /Could not save permissions/);
  assert.equal(h.app.opts.cfg.permissionRules, original);
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.resumed, []);
  assert.equal(h.app.opts.context, h.session);
  assert.equal(readFileSync(globalPath, 'utf8'), '{corrupt');
});

test('pi config get redacts direct and nested secrets while config show stays useful', (t) => {
  const h = harness(workspace(t, false).cwd, [], {
    cfg: {
      apiKey: 'local-secret-value',
      transport: { authToken: 'nested-secret-value', endpoint: 'https://example.test/v1' },
      models: [{ label: 'Fixture', provider: 'mock', model: 'mock-model' }],
    },
  });

  h.app.runSlash('/config get apiKey');
  h.app.runSlash('/config get transport');
  h.app.runSlash('/config show');

  const text = h.text();
  assert.doesNotMatch(text, /local-secret-value|nested-secret-value/);
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /provider\/model: mock\/mock-model/);
  assert.match(text, /1 models configured · API keys hidden/);
});

test('pi memory renders persisted facts through the approval-safe display path', (t) => {
  const f = workspace(t, false);
  mkdirSync(join(f.cwd, '.shadow'), { recursive: true });
  writeFileSync(
    join(f.cwd, '.shadow', 'memory.json'),
    JSON.stringify({ ['release\u202e']: 'npm\u001b[2J test' }),
  );
  const h = harness(f.cwd);

  h.app.runSlash('/memory');

  assert.match(h.text(), /release\\u202e/);
  assert.doesNotMatch(h.text(), /\u202e/);
  assert.match(h.text(), /npm\\x1b\[2J test/);
  assert.doesNotMatch(h.text(), /\x1b/, 'stored controls remain visible literals, never terminal instructions');
});

test('pi MCP commands redact inspection and async errors, persist settings and disable the live connector', async (t) => {
  const config: McpServerConfig = { url: 'https://fixture:password-private@example.test/mcp?key=query-private',
    headers: { Authorization: 'Bearer header-private' }, callTimeoutMs: 1000 };
  resetGlobalConfig({ mcpServers: { fixture: config }, sentinel: 'preserve' });
  t.after(() => resetGlobalConfig());
  const reconnects: Array<{ name: string; config: McpServerConfig }> = [];
  const disabled: string[] = [];
  const manager: McpManager = {
    async reconnect(name, next) { reconnects.push({ name, config: next }); throw new Error('Connection failed: Bearer rejected-private'); },
    async test() { throw new Error('Test failed: Bearer rejected-private'); },
    disable(name) { disabled.push(name); return true; }, list: () => [], stopAll: () => {},
  };
  const h = harness(workspace(t, false).cwd, [], { cfg: { mcpServers: { fixture: config } }, mcpManager: manager });
  h.app.runSlash('/mcp get fixture');
  assert.match(h.text(), /example\.test/);
  assert.doesNotMatch(h.text(), /password-private|query-private|header-private/);
  h.app.runSlash('/mcp timeout fixture 0.5');
  h.app.runSlash('/mcp tools fixture search,read');
  h.app.runSlash('/mcp test fixture');
  h.app.runSlash('/mcp reconnect fixture');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reconnects[0]!.config.callTimeoutMs, 500);
  assert.deepEqual(reconnects[1]!.config.toolNames, ['search', 'read']);
  assert.match(h.text(), /Test failed: Bearer \[REDACTED\]/);
  assert.match(h.text(), /Connection failed: Bearer \[REDACTED\]/);
  assert.doesNotMatch(h.text(), /rejected-private/);
  const persisted = JSON.parse(readFileSync(join(isolated.shadowDir, 'config.json'), 'utf8'));
  assert.equal(persisted.mcpServers.fixture.callTimeoutMs, 500);
  assert.deepEqual(persisted.mcpServers.fixture.toolNames, ['search', 'read']);
  assert.equal(persisted.sentinel, 'preserve');
  h.app.runSlash('/mcp disable fixture');
  assert.deepEqual(disabled, ['fixture'], 'disable reaches the currently connected manager immediately');
  const afterDisable = JSON.parse(readFileSync(join(isolated.shadowDir, 'config.json'), 'utf8'));
  assert.equal(afterDisable.mcpServers.fixture, undefined);
  assert.equal(afterDisable.sentinel, 'preserve');
});

test('pi doctor runs local diagnostics without contacting a provider', (t) => {
  resetGlobalConfig({ provider: 'mock', model: 'mock-model', models: [] });
  const h = harness(workspace(t, false).cwd);

  h.app.runSlash('/doctor');

  assert.match(h.text(), /shadow doctor 9\.0\.0-test/);
  assert.match(h.text(), /provider:/);
  assert.match(h.text(), /sandbox-policy:/);
});

test('pi keybindings are renderer-specific and unsupported commands explain the boundary', (t) => {
  const teams: string[] = [];
  const h = harness(workspace(t, false).cwd, [], { state: { doTeam: (arg: string) => teams.push(arg) } });
  h.app.runSlash('/keybindings show');
  for (const command of ['/vim', '/table', '/statusline echo unsafe']) h.app.runSlash(command);

  const text = h.text();
  assert.match(text, /pi keybindings/i);
  assert.match(text, /Shift\+Tab\s+toggle plan mode/);
  assert.match(text, /~\/\.shadow\/keybindings\.json is Ink-only/);
  for (const name of ['/vim', '/statusline']) {
    assert.match(text, new RegExp(`${name} is unavailable in Snowfall`));
  }
  assert.match(text, /Snowfall collaboration uses \/team and \/consult/);
  assert.deepEqual(teams, [''], '/table routes to the collaboration preset picker');
  assert.doesNotMatch(text, /Unknown command/);

  const unknown = harness(workspace(t, false).cwd);
  unknown.app.runSlash('/not-a-shadow-command');
  assert.match(unknown.text(), /Unknown command: \/not-a-shadow-command/);
});

test('pi status identifies the active profile and the keys it contributed', (t) => {
  const h = harness(workspace(t, false).cwd, [], {
    cfg: {
      activeProfile: 'deep-review',
      profile: { model: 'mock-model', effort: 'max', contextBudget: 128_000 },
    },
  });

  h.app.runSlash('/status');

  assert.match(h.text(), /profile\s+deep-review/);
  assert.match(h.text(), /model=mock-model/);
  assert.match(h.text(), /effort=max/);
  assert.match(h.text(), /contextBudget=128000/);
});

test('pi status reports the active mission instead of a stale legacy goal', (t) => {
  const h = harness(workspace(t, false).cwd, [], {
    state: {
      goal: null,
      mission: {
        active: true,
        mission: 'Ship the release',
        phase: 'verifying',
        tasks: [],
        updatedAt: '2026-09-28T00:00:00.000Z',
      },
    },
  });

  h.app.runSlash('/status');

  assert.match(h.text(), /mission\s+Ship the release \(verifying\)/);
  assert.doesNotMatch(h.text(), /goal\s+\(none\)/);
});

test('pi connections reports real allowed, denied, flagged, and purpose counts', (t) => {
  const host = 'pi-command-fixture.invalid';
  recordEgress(host, 'web', 'allowed');
  recordEgress(host, 'provider', 'denied');
  recordEgress(host, 'dispatch', 'allowed', 'quarantine');
  const h = harness(workspace(t, false).cwd);

  h.app.runSlash('/connections');

  const text = h.text();
  assert.match(text, /pi-command-fixture\.invalid/);
  assert.match(text, /2 allowed/);
  assert.match(text, /1 denied/);
  assert.match(text, /1 ⚑ outside allowlist/);
  assert.match(text, /dispatch, provider, web/);
  assert.doesNotMatch(text, /× \?/);
});

test('pi workflows includes enabled plugin runbooks', (t) => {
  const plugin = join(isolated.shadowDir, 'plugins', 'workflow-fixture');
  mkdirSync(join(plugin, 'workflows'), { recursive: true });
  writeFileSync(
    join(plugin, 'manifest.json'),
    JSON.stringify({ name: 'workflow-fixture', version: '1.0.0', description: 'workflow fixture' }),
  );
  writeFileSync(
    join(plugin, '.shadow-plugin-meta.json'),
    JSON.stringify({
      enabled: true,
      installedAt: '2026-09-28T00:00:00.000Z',
      source: { kind: 'path', path: plugin },
    }),
  );
  writeFileSync(join(plugin, 'workflows', 'release.md'), '# release\n');
  const h = harness(workspace(t, false).cwd);

  h.app.runSlash('/workflows');

  assert.match(h.text(), /plugin:workflow-fixture/);
  assert.match(h.text(), /release\.md/);
});

test('pi login reports the real subscription store and keeps imports in the CLI', (t) => {
  const h = harness(workspace(t, false).cwd);

  h.app.runSlash('/login status');
  h.app.runSlash('/login import codex');

  assert.match(h.text(), /codex: no subscription credential stored/);
  assert.match(h.text(), /grok: no subscription credential stored/);
  assert.match(h.text(), /Credential import runs outside the shell: `shadow login`/);
});

test('pi editor route enforces the busy guard before touching the terminal or editor', (t) => {
  const h = harness(workspace(t, false).cwd, [], { state: { running: true } });

  h.app.runSlash('/editor');

  assert.match(h.text(), /Finish the current operation before opening the external editor/);
  assert.doesNotMatch(h.text(), /External editor needs an interactive terminal/);
});

test('pi model list and catalog mutations persist without provider calls', (t) => {
  const models: ModelEntry[] = [{
    label: 'Existing',
    provider: 'openai',
    model: 'model-one',
    baseUrl: 'http://127.0.0.1:8000/v1',
    selfHosted: true,
  }];
  resetGlobalConfig({
    provider: 'openai',
    model: 'model-one',
    baseUrl: 'http://127.0.0.1:8000/v1',
    selfHosted: true,
    lastModel: 'Existing',
    models,
  });
  const h = harness(workspace(t, false).cwd, [], {
    cfg: {
      provider: 'openai',
      model: 'model-one',
      baseUrl: 'http://127.0.0.1:8000/v1',
      selfHosted: true,
      lastModel: 'Existing',
      models: models.map((model) => ({ ...model })),
    },
    state: {
      current: { provider: 'openai', model: 'model-one' },
      activeTarget: { baseUrl: 'http://127.0.0.1:8000/v1', selfHosted: true },
    },
  });

  h.app.runSlash('/model list');
  h.app.runSlash('/model add "Second Model" anthropic model-two');
  assert.equal(h.app.opts.cfg.models.length, 2);
  h.app.runSlash('/model disable "Second Model"');
  assert.equal(h.app.opts.cfg.models[1]?.disabled, true);
  h.app.runSlash('/model enable "Second Model"');
  assert.equal(h.app.opts.cfg.models[1]?.disabled, undefined);
  h.app.runSlash('/model default "Second Model"');
  h.app.runSlash('/model list');

  assert.equal(h.app.opts.cfg.model, 'model-one', 'saving the next-launch default does not relabel the live model');
  assert.equal(h.app.opts.cfg.provider, 'openai');
  assert.equal(h.app.opts.cfg.baseUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(h.app.opts.cfg.selfHosted, true);
  assert.equal(h.app.opts.cfg.lastModel, 'Existing');
  assert.deepEqual(h.app.current, { provider: 'openai', model: 'model-one' });
  assert.deepEqual(h.app.activeTarget, { baseUrl: 'http://127.0.0.1:8000/v1', selfHosted: true });
  assert.match(h.text(), /Configured models/);
  assert.match(h.text(), /Added model preset: Second Model/);
  assert.match(h.text(), /Default model saved for next launch: Second Model/);
  assert.match(h.text(), /● Existing/);
  assert.doesNotMatch(h.text(), /● Second Model/);
  const saved = JSON.parse(readFileSync(join(isolated.shadowDir, 'config.json'), 'utf8')) as {
    provider?: string;
    model?: string;
    baseUrl?: string;
    selfHosted?: boolean;
    lastModel?: string;
    models?: ModelEntry[];
  };
  assert.equal(saved.provider, 'anthropic');
  assert.equal(saved.model, 'model-two');
  assert.equal(saved.baseUrl, undefined);
  assert.equal(saved.selfHosted, undefined);
  assert.equal(saved.lastModel, 'Second Model');
  assert.equal(saved.models?.find((model) => model.label === 'Second Model')?.disabled, undefined);
});

test('Ink /model default persists the next launch without relabeling the live transport', () => {
  const models: ModelEntry[] = [
    {
      label: 'Live Local',
      provider: 'openai',
      model: 'local-model',
      baseUrl: 'http://127.0.0.1:8000/v1',
      selfHosted: true,
    },
    { label: 'Cloud Next', provider: 'anthropic', model: 'cloud-model' },
  ];
  const cfg = {
    provider: 'openai',
    model: 'local-model',
    baseUrl: 'http://127.0.0.1:8000/v1',
    selfHosted: true,
    lastModel: 'Live Local',
    models,
  };
  resetGlobalConfig(cfg);
  const currentRef = { current: { provider: 'openai', model: 'local-model' } };
  const activeTargetRef = {
    current: { baseUrl: 'http://127.0.0.1:8000/v1', selfHosted: true },
  };
  const output: Array<{ text?: string }> = [];
  const ctx = {
    setLine() {},
    setMenuIndex() {},
    pushLine: (line: { text?: string }) => output.push(line),
    opts: { cfg },
    currentRef,
    activeTargetRef,
  };

  runSlashCommand(ctx as never, findSlashCommand('/model')!, '/model default "Cloud Next"');

  assert.deepEqual(cfg, {
    provider: 'openai',
    model: 'local-model',
    baseUrl: 'http://127.0.0.1:8000/v1',
    selfHosted: true,
    lastModel: 'Live Local',
    models,
  });
  assert.deepEqual(currentRef.current, { provider: 'openai', model: 'local-model' });
  assert.deepEqual(activeTargetRef.current, {
    baseUrl: 'http://127.0.0.1:8000/v1',
    selfHosted: true,
  });
  assert.match(output.map((line) => line.text).join('\n'), /Default model saved for next launch: Cloud Next/);

  const saved = JSON.parse(readFileSync(join(isolated.shadowDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(saved.provider, 'anthropic');
  assert.equal(saved.model, 'cloud-model');
  assert.equal(saved.baseUrl, undefined);
  assert.equal(saved.selfHosted, undefined);
  assert.equal(saved.lastModel, 'Cloud Next');
});
