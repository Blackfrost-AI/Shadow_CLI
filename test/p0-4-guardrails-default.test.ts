import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_UNRESTRICTED } from '../src/buildProfile.js';

// P0-4: guardrails (filesystem jail + OS sandbox) ship ON by default. Dropping them is OPT-IN
// via SHADOW_DEV_UNRESTRICTED=1, and the release gate refuses to publish a build that
// hard-codes DEV_UNRESTRICTED to an always-true value.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildProfileUrl = new URL('../src/buildProfile.ts', import.meta.url).href;
const gateScript = join(repoRoot, 'scripts', 'check-release-gate.sh');

test('DEV_UNRESTRICTED defaults to false (guardrails ON) when SHADOW_DEV_UNRESTRICTED is unset', () => {
  // The test process does not set SHADOW_DEV_UNRESTRICTED, so the imported value is the safe default.
  assert.equal(DEV_UNRESTRICTED, false);
});

test('SHADOW_DEV_UNRESTRICTED=1 opts in to unrestricted (DEV_UNRESTRICTED=true)', () => {
  const code = `import(${JSON.stringify(buildProfileUrl)}).then(m => process.exit(m.DEV_UNRESTRICTED === true ? 0 : 1), e => { console.error(e); process.exit(2); });`;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '-e', code],
    { env: { ...process.env, SHADOW_DEV_UNRESTRICTED: '1' }, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, `expected DEV_UNRESTRICTED=true with env opt-in; stderr: ${child.stderr}`);
});

test('any value other than "1" stays safe (DEV_UNRESTRICTED=false)', () => {
  const code = `import(${JSON.stringify(buildProfileUrl)}).then(m => process.exit(m.DEV_UNRESTRICTED === false ? 0 : 1), e => { console.error(e); process.exit(2); });`;
  for (const val of ['0', 'true', 'yes', '']) {
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', '--input-type=module', '-e', code],
      { env: { ...process.env, SHADOW_DEV_UNRESTRICTED: val }, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, `SHADOW_DEV_UNRESTRICTED=${JSON.stringify(val)} should stay safe; stderr: ${child.stderr}`);
  }
});

// Run the real gate script against a throwaway repo so we can prove it BLOCKS insecure
// assignments and does NOT false-positive on the safe form or the doctor.ts diagnostic string.
function runGateOn(srcContent: string) {
  const root = mkdtempSync(join(tmpdir(), 'shadow-gate-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    const scriptCopy = join(root, 'scripts', 'check-release-gate.sh');
    copyFileSync(gateScript, scriptCopy);
    chmodSync(scriptCopy, 0o755);
    writeFileSync(join(root, 'src', 'buildProfile.ts'), srcContent, 'utf8');
    return spawnSync('bash', [scriptCopy], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('release gate BLOCKS an always-true DEV_UNRESTRICTED assignment', () => {
  const bad = [
    "export const DEV_UNRESTRICTED = true;",
    "export const DEV_UNRESTRICTED = 1;",
    "DEV_UNRESTRICTED = !!1;",
    "exports.DEV_UNRESTRICTED = Boolean(true);",
  ];
  for (const line of bad) {
    const res = runGateOn(line + '\n');
    assert.notEqual(res.status, 0, `gate should block: ${line}`);
  }
});

test('release gate PASSES the safe default and does not false-positive on diagnostics', () => {
  const safe = [
    "export const DEV_UNRESTRICTED = process.env.SHADOW_DEV_UNRESTRICTED === '1';",
    // mirrors the human-readable string in src/doctor.ts — must NOT trip the gate
    "const detail = 'dev default: jail OFF (buildProfile DEV_UNRESTRICTED=true). Use SHADOW_GUARDRAILS=on';",
  ].join('\n');
  const res = runGateOn(safe + '\n');
  assert.equal(res.status, 0, `gate false-positived on safe code; stderr: ${res.stderr}`);
});
