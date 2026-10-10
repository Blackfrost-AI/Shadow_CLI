import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertHarnessReady,
  assertHarnessRuntimeReady,
  CLI_LATE_NATIVE_HARNESS_TOOLS,
  discoverHarnessCatalog,
  evaluateHarnessRuntimeReadiness,
  harnessesDir,
  loadHarnessPackage,
  parseHarnessManifest,
  plannedSessionHarnessTools,
  resolveHarnessStack,
  SHADOW_SECURITY_FOUNDATION,
} from '../src/harness/index.js';

function tempHome(label: string): string {
  return mkdtempSync(join(tmpdir(), `shadow-harness-${label}-`));
}

function writeHarness(
  home: string,
  id: string,
  overrides: Record<string, unknown> = {},
): string {
  const dir = join(harnessesDir(home), id);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id,
    version: '1.0.0',
    title: id.toUpperCase(),
    description: `${id} test harness`,
    ...overrides,
  };
  writeFileSync(join(dir, 'harness.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

test('schema v1 is strict, canonicalizes tool aliases, and deduplicates declarative lists', () => {
  const manifest = parseHarnessManifest(
    JSON.stringify({
      schemaVersion: 1,
      id: 'blue.team',
      version: '1.2.3',
      title: 'Blue Team',
      description: 'Incident response workflow',
      instructions: ['IDENTITY.md', 'IDENTITY.md'],
      requiredAdapters: ['example.incident-response', 'example.incident-response'],
      tools: {
        add: ['bash', 'run_shell', 'read'],
        remove: ['websearch', 'web_search'],
      },
    }),
  );

  assert.deepEqual(manifest.instructions, ['IDENTITY.md']);
  assert.deepEqual(manifest.requiredAdapters, ['example.incident-response']);
  assert.deepEqual(manifest.tools.add, ['run_shell', 'read_file']);
  assert.deepEqual(manifest.tools.remove, ['web_search']);
});

test('manifest rejects provider, credential, permission, MCP, hook, and executable fields', () => {
  const base = {
    schemaVersion: 1,
    id: 'locked',
    version: '1',
    title: 'Locked',
    description: 'Strict manifest',
  };
  for (const [path, addition] of [
    ['provider', { provider: 'openai' }],
    ['endpoint', { endpoint: 'https://example.invalid' }],
    ['credentials', { credentials: { token: 'secret' } }],
    ['autonomy', { autonomy: 'full' }],
    ['permissions', { permissions: ['all'] }],
    ['hooks', { hooks: {} }],
    ['mcpServers', { mcpServers: {} }],
    ['scripts', { scripts: { install: 'whoami' } }],
    ['nested executable', { tools: { add: [], remove: [], executable: './tool' } }],
  ] as const) {
    assert.throws(
      () => parseHarnessManifest(JSON.stringify({ ...base, ...addition })),
      /forbidden field/,
      path,
    );
  }
  assert.throws(() => parseHarnessManifest(JSON.stringify({ ...base, surprise: true })), /invalid/);
  assert.throws(
    () => parseHarnessManifest(JSON.stringify({ ...base, tools: { add: ['bash'], remove: ['run_shell'] } })),
    /both added and removed/,
  );
});

test('catalog discovers only valid direct packages and exposes instructions, supported content, and a stable digest', () => {
  const home = tempHome('catalog');
  try {
    const dir = writeHarness(home, 'incident-response', {
      instructions: ['prompts/IDENTITY.md', 'prompts/WORKFLOW.md'],
      requiredAdapters: ['example.incident-response'],
      tools: { add: ['read_file'], remove: ['web_search'] },
    });
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'IDENTITY.md'), '# Incident Response\nEvidence first.\n');
    writeFileSync(join(dir, 'prompts', 'WORKFLOW.md'), '# Workflow\nGate every stage.\n');
    mkdirSync(join(dir, 'skills', 'measurements'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'measurements', 'SKILL.md'), '# Measurements\n');
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'reviewer.md'), '# Reviewer\n');
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'pipeline.yaml'), 'stages: []\n');

    const first = discoverHarnessCatalog({ homeDir: home });
    assert.deepEqual(first.issues, []);
    assert.equal(first.packages.length, 1);
    const pkg = first.packages[0];
    assert.equal(pkg.id, 'incident-response');
    assert.equal(pkg.instructions[0].text, '# Incident Response\nEvidence first.\n');
    assert.equal(pkg.contentDirs.skills, realpathSync(join(dir, 'skills')));
    assert.equal(pkg.contentDirs.references, realpathSync(join(dir, 'references')));
    assert.ok(pkg.bytes > 0);
    assert.match(pkg.digest, /^[a-f0-9]{64}$/);
    assert.equal(loadHarnessPackage('incident-response', { homeDir: home }).digest, pkg.digest);

    writeFileSync(join(dir, 'references', 'pipeline.yaml'), 'stages: [S0]\n');
    assert.notEqual(loadHarnessPackage('incident-response', { homeDir: home }).digest, pkg.digest);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('catalog rejects id mismatches, invalid direct entries, symlinked packages, and nested symlinks', () => {
  const home = tempHome('unsafe');
  const outside = tempHome('outside');
  try {
    writeHarness(home, 'wrong-dir', { id: 'different-id' });
    writeFileSync(join(harnessesDir(home), 'loose.txt'), 'not a package');
    mkdirSync(join(outside, 'linked-package'), { recursive: true });
    symlinkSync(join(outside, 'linked-package'), join(harnessesDir(home), 'linked'));

    const nested = writeHarness(home, 'nested-link');
    mkdirSync(join(nested, 'skills'), { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'outside secret');
    symlinkSync(join(outside, 'secret.txt'), join(nested, 'skills', 'secret.md'));

    const catalog = discoverHarnessCatalog({ homeDir: home });
    assert.equal(catalog.packages.length, 0);
    assert.ok(catalog.issues.some((issue) => issue.directory === 'wrong-dir' && issue.message.includes('does not match')));
    assert.ok(catalog.issues.some((issue) => issue.directory === 'loose.txt' && issue.message.includes('not a directory')));
    assert.ok(catalog.issues.some((issue) => issue.directory === 'linked' && issue.message.includes('symlink')));
    assert.ok(catalog.issues.some((issue) => issue.directory === 'nested-link' && issue.message.includes('symlink')));
    assert.ok(!readFileSync(join(outside, 'secret.txt'), 'utf8').includes('changed'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('package caps are enforced from file metadata before a large file is read', () => {
  const home = tempHome('caps');
  try {
    const dir = writeHarness(home, 'capped');
    writeFileSync(join(dir, 'large.bin'), Buffer.alloc(2_048));
    assert.throws(
      () => loadHarnessPackage('capped', { homeDir: home, limits: { packageBytes: 1_024 } }),
      /byte cap/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('security foundation is always present with zero selected add-ons', () => {
  const home = tempHome('foundation');
  try {
    const stack = resolveHarnessStack([], { homeDir: home });
    assert.equal(stack.foundation.id, 'shadow-security');
    assert.equal(stack.foundation, SHADOW_SECURITY_FOUNDATION);
    assert.deepEqual(stack.selectedIds, []);
    assert.deepEqual(stack.addons, []);
    assert.equal(stack.ready, true);
    assert.match(stack.instructionText, /provider-neutral security engineering agent/);
    assert.match(stack.digest, /^[a-f0-9]{64}$/);
    assert.doesNotThrow(() => assertHarnessReady(stack));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolver composes ordered add-ons and reports compiled adapter and existing-tool readiness', () => {
  const home = tempHome('resolve');
  try {
    const alpha = writeHarness(home, 'alpha', {
      instructions: ['IDENTITY.md'],
      requiredAdapters: ['blackfrost.alpha'],
      tools: { add: ['read_file', 'alpha_status'], remove: ['web_search'] },
    });
    writeFileSync(join(alpha, 'IDENTITY.md'), 'Alpha identity.\n');
    mkdirSync(join(alpha, 'skills'), { recursive: true });
    const beta = writeHarness(home, 'beta', {
      instructions: ['WORKFLOW.md'],
      requiredAdapters: ['blackfrost.alpha', 'blackfrost.beta'],
      tools: { add: ['read_file'], remove: ['run_shell'] },
    });
    writeFileSync(join(beta, 'WORKFLOW.md'), 'Beta workflow.\n');
    mkdirSync(join(beta, 'references'), { recursive: true });

    const adapters = new Set(['blackfrost.alpha', 'blackfrost.beta']);
    const tools = new Set(['read_file', 'alpha_status', 'web_search', 'run_shell']);
    const stack = resolveHarnessStack(['beta', 'alpha', 'beta', 'security'], {
      homeDir: home,
      adapterRegistry: adapters,
      availableTools: tools,
    });

    assert.deepEqual(stack.selectedIds, ['beta', 'alpha']);
    assert.deepEqual(stack.adapters, {
      required: ['blackfrost.alpha', 'blackfrost.beta'],
      available: ['blackfrost.alpha', 'blackfrost.beta'],
      missing: [],
    });
    assert.deepEqual(stack.tools.required, ['read_file', 'alpha_status']);
    assert.deepEqual(stack.tools.available, ['read_file', 'alpha_status']);
    assert.deepEqual(stack.tools.remove, ['run_shell', 'acceptance_check', 'bash_output', 'kill_shell', 'web_search']);
    assert.deepEqual(stack.tools.conflicts, []);
    assert.deepEqual(stack.contentDirs.references, [realpathSync(join(beta, 'references'))]);
    assert.deepEqual(stack.contentDirs.skills, [realpathSync(join(alpha, 'skills'))]);
    assert.ok(stack.instructionText.indexOf('Beta workflow.') < stack.instructionText.indexOf('Alpha identity.'));
    assert.equal(stack.ready, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolver fails closed for missing capabilities and cross-package tool conflicts', () => {
  const home = tempHome('blocked');
  try {
    writeHarness(home, 'needs-tools', {
      requiredAdapters: ['blackfrost.missing'],
      tools: { add: ['read_file'], remove: [] },
    });
    writeHarness(home, 'removes-tools', {
      tools: { add: [], remove: ['read_file'] },
    });
    const stack = resolveHarnessStack(['needs-tools', 'removes-tools'], {
      homeDir: home,
      adapterRegistry: new Set(),
      availableTools: new Set(['read_file']),
    });
    assert.equal(stack.ready, false);
    assert.deepEqual(stack.adapters.missing, ['blackfrost.missing']);
    assert.deepEqual(stack.tools.missing, ['read_file']);
    assert.deepEqual(stack.tools.conflicts, ['read_file']);
    assert.throws(() => assertHarnessReady(stack), /missing compiled adapters.*missing required tools.*both required and removed/);
    assert.throws(() => resolveHarnessStack(['not-installed'], { homeDir: home }), /not installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('tool subtraction closes native wrapper routes to removed execution capabilities', () => {
  const home = tempHome('wrapper-removals');
  try {
    writeHarness(home, 'scoped', {
      tools: {
        add: ['acceptance_check', 'collaborate'],
        remove: ['run_shell', 'agent'],
      },
    });
    const stack = resolveHarnessStack(['scoped'], {
      homeDir: home,
      availableTools: new Set(['acceptance_check', 'collaborate']),
    });

    assert.deepEqual(stack.tools.remove, ['run_shell', 'acceptance_check', 'bash_output', 'kill_shell', 'agent', 'collaborate']);
    assert.deepEqual(stack.tools.conflicts, ['acceptance_check', 'collaborate']);
    assert.deepEqual(stack.tools.missing, ['acceptance_check', 'collaborate']);
    assert.throws(() => assertHarnessReady(stack), /both required and removed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runtime readiness distinguishes fixed late CLI tools from nonexistent or unavailable host tools', () => {
  const home = tempHome('runtime-readiness');
  try {
    writeHarness(home, 'runtime-check', {
      tools: { add: ['read_file', 'agent', 'ghost_tool', 'web_search'], remove: [] },
    });
    // Structural composition does not pretend it has inspected a concrete host.
    const stack = resolveHarnessStack(['runtime-check'], {
      homeDir: home,
      availableTools: { has: () => true },
    });

    const webPlan = evaluateHarnessRuntimeReadiness(stack, {
      availableTools: plannedSessionHarnessTools({ offline: false, vision: false }),
    });
    assert.deepEqual(webPlan.tools.missing, ['agent', 'ghost_tool']);

    const cliPlan = evaluateHarnessRuntimeReadiness(stack, {
      availableTools: plannedSessionHarnessTools({
        offline: false,
        vision: false,
        deferred: CLI_LATE_NATIVE_HARNESS_TOOLS,
      }),
    });
    assert.deepEqual(cliPlan.tools.missing, ['ghost_tool']);

    const offlinePlan = evaluateHarnessRuntimeReadiness(stack, {
      availableTools: plannedSessionHarnessTools({
        offline: true,
        vision: false,
        deferred: CLI_LATE_NATIVE_HARNESS_TOOLS,
      }),
    });
    assert.deepEqual(offlinePlan.tools.missing, ['ghost_tool', 'web_search']);

    const actual = plannedSessionHarnessTools({
      offline: false,
      vision: false,
      deferred: CLI_LATE_NATIVE_HARNESS_TOOLS,
    });
    assert.throws(
      () => assertHarnessRuntimeReady(stack, { availableTools: actual }),
      /missing required tools: ghost_tool/,
    );
    actual.add('ghost_tool');
    assert.equal(evaluateHarnessRuntimeReadiness(stack, { availableTools: actual }).ready, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
