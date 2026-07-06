import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  resolveSystem,
  HARNESS_PREAMBLE,
  FALLBACK_SYSTEM,
} from '../src/system/resolveSystem.js';

const INSTALL_DIR = fileURLToPath(new URL('..', import.meta.url));

test('resolveSystem prepends HARNESS_PREAMBLE and uses bundled SHADOW.md when no global profile', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-sys-'));
  const sys = resolveSystem(cwd, { installDir: INSTALL_DIR, homedir: cwd });
  assert.match(sys, new RegExp(HARNESS_PREAMBLE.slice(0, 40)));
  assert.ok(sys.length > FALLBACK_SYSTEM.length, 'bundled SHADOW.md should extend the inline fallback');
});

test('resolveSystem appends project SHADOW.md and ingests AGENTS.md as untrusted', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-sys-'));
  writeFileSync(join(cwd, 'SHADOW.md'), 'PROJECT RULES');
  writeFileSync(join(cwd, 'AGENTS.md'), 'Use snake_case tools.');
  const sys = resolveSystem(cwd, { installDir: INSTALL_DIR, homedir: cwd });
  assert.match(sys, /PROJECT RULES/);
  assert.match(sys, /UNTRUSTED repository text/);
  assert.match(sys, /### AGENTS\.md/);
  assert.match(sys, /Use snake_case tools\./);
});

test('resolveSystem --system override replaces layered profile', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-sys-'));
  writeFileSync(join(cwd, 'override.md'), 'OVERRIDE ONLY');
  writeFileSync(join(cwd, 'AGENTS.md'), 'should not appear');
  const sys = resolveSystem(cwd, {
    installDir: INSTALL_DIR,
    homedir: cwd,
    systemPromptPath: 'override.md',
  });
  assert.equal(sys, 'OVERRIDE ONLY');
  assert.doesNotMatch(sys, /AGENTS/);
});