import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  CLI_LATE_NATIVE_HARNESS_TOOLS,
  SHARED_SESSION_HARNESS_TOOLS,
  harnessesDir,
} from '../src/harness/index.js';

const CLI = resolve('src/index.ts');

function fixture(requiredTools: string[]): { home: string; marker: string } {
  const home = mkdtempSync(join(tmpdir(), 'shadow-harness-cli-'));
  const packageDir = join(harnessesDir(home), 'readiness-fixture');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'harness.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'readiness-fixture',
      version: '1.0.0',
      title: 'Readiness Fixture',
      description: 'Exercises structural and runtime validation.',
      tools: { add: requiredTools, remove: [] },
    }),
  );

  const marker = join(home, 'HOOK_RAN');
  const hook = join(home, 'session-start.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(hook, 0o700);
  mkdirSync(join(home, '.shadow'), { recursive: true });
  writeFileSync(
    join(home, '.shadow', 'config.json'),
    JSON.stringify({
      provider: 'mock',
      model: 'mock',
      hooks: { session_start: [hook] },
    }),
  );
  return { home, marker };
}

function run(home: string, args: string[]) {
  // os.homedir() reads USERPROFILE on Windows and HOME on POSIX. Set both so the child resolves
  // the same isolated harness/config tree on every supported host.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SHADOW_HARNESSES;
  return spawnSync(process.execPath, ['--import', 'tsx/esm', CLI, ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('shadow harness validate reports structural validity without claiming runtime loadability', () => {
  const f = fixture(['ghost_tool']);
  try {
    const result = run(f.home, ['harness', 'validate', 'readiness-fixture']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /valid package structure/);
    assert.match(result.stdout, /runtime readiness is checked.*new session/);
    assert.doesNotMatch(result.stdout, /locally loadable/);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test('an unknown required tool fails before session_start hooks or provider work', () => {
  const f = fixture(['ghost_tool']);
  try {
    const result = run(f.home, ['--task', 'unused', '--provider', 'mock', '--model', 'mock', '--harness', 'readiness-fixture']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /required tools are unavailable in this host: ghost_tool/);
    // A broken implementation fires this hook detached immediately before reaching provider setup.
    // Give any wrongly-spawned child a brief chance to leave its marker after the parent exits.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    assert.equal(existsSync(f.marker), false, 'readiness failure must precede session_start hooks');
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test('the terminal finalizes its shared and fixed late-native tool promises before the first turn', () => {
  const f = fixture([
    ...SHARED_SESSION_HARNESS_TOOLS,
    'web_fetch',
    'web_search',
    ...CLI_LATE_NATIVE_HARNESS_TOOLS,
  ]);
  try {
    const result = run(f.home, [
      '--task',
      'print ok',
      '--provider',
      'mock',
      '--model',
      'mock',
      '--harness',
      'readiness-fixture',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /missing required tools|unavailable in this host/);
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
