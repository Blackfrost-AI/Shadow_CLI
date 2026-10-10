import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnvBlock } from '../src/agent/bootstrap.js';
import {
  promptCapabilitiesWithout,
  resolveSystem,
} from '../src/system/resolveSystem.js';

const INSTALL_DIR = fileURLToPath(new URL('..', import.meta.url));

test('an unrestricted capability view preserves the default resolved system prompt byte-for-byte', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-capability-prompt-'));
  const options = { installDir: INSTALL_DIR, homedir: cwd };
  assert.equal(
    resolveSystem(cwd, { ...options, capabilities: promptCapabilitiesWithout([]) }),
    resolveSystem(cwd, options),
  );
});

test('an unrestricted capability view preserves default environment guidance', () => {
  const normalizeDate = (value: string): string => value.replace(/^- date: .*$/m, '- date: <dynamic>');
  const defaultBlock = buildEnvBlock('/nonexistent-shadow-capability-workspace', ['/extra-root']);
  const explicitBlock = buildEnvBlock(
    '/nonexistent-shadow-capability-workspace',
    ['/extra-root'],
    {},
    promptCapabilitiesWithout([]),
  );
  assert.equal(normalizeDate(explicitBlock), normalizeDate(defaultBlock));
});

test('resolved Shadow guidance omits recommendations for tools removed by the harness', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-capability-prompt-'));
  const system = resolveSystem(cwd, {
    installDir: INSTALL_DIR,
    homedir: cwd,
    capabilities: promptCapabilitiesWithout(['agent', 'todo_write', 'run_shell']),
  });

  assert.doesNotMatch(system, /\btodo_write\b/i);
  assert.doesNotMatch(system, /\brun_shell\b/i);
  assert.doesNotMatch(system, /`agent`|['"]agent['"] tool|\bagent tool\b/i);
  assert.doesNotMatch(system, /\breviewer\b|\bworktree isolation\b/i);
  assert.match(system, /Always-on foundation: Shadow Security/);
  assert.match(system, /read_file/);
});

test('environment guidance describes only effective discovery and orchestration capabilities', () => {
  const capabilities = promptCapabilitiesWithout(['agent', 'todo_write', 'run_shell', 'glob']);
  const block = buildEnvBlock(
    '/nonexistent-shadow-capability-workspace',
    [],
    { sandboxToolPresent: true },
    capabilities,
  );

  assert.doesNotMatch(block, /\btodo_write\b|\brun_shell\b/i);
  assert.doesNotMatch(block, /['"]agent['"] tool|\breviewer\b|\bworktree\b/i);
  assert.doesNotMatch(block, /use bash\/sh syntax|confirm it exists with glob/i);
  assert.match(block, /Use only paths supplied by the user or shown in available tool results/);
  assert.match(block, /No shell execution capability is exposed/);
  assert.match(block, /Keep durable plans and research notes in the workspace/);
});

test('bootstrap derives both prompt layers from the same immutable harness removal set', () => {
  const source = readFileSync(new URL('../src/agent/bootstrap.ts', import.meta.url), 'utf8');
  assert.match(source, /promptCapabilitiesWithout\(harness\.tools\.remove\)/);
  assert.match(source, /resolveSystem\([\s\S]*?capabilities: promptCapabilities/);
  assert.match(source, /buildEnvBlock\([\s\S]*?promptCapabilities\)/);
});
