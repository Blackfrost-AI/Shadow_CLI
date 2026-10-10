import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  resolveSystem,
  HARNESS_PREAMBLE,
  FALLBACK_SYSTEM,
} from '../src/system/resolveSystem.js';
import { SHADOW_SECURITY_FOUNDATION } from '../src/harness/resolver.js';

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

test('resolveSystem --system override replaces layered profile but retains the canonical foundation', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-sys-'));
  writeFileSync(join(cwd, 'override.md'), 'OVERRIDE ONLY');
  writeFileSync(join(cwd, 'AGENTS.md'), 'should not appear');
  const sys = resolveSystem(cwd, {
    installDir: INSTALL_DIR,
    homedir: cwd,
    systemPromptPath: 'override.md',
  });
  assert.match(sys, /^OVERRIDE ONLY/);
  assert.match(sys, new RegExp(SHADOW_SECURITY_FOUNDATION.instruction.slice(0, 60)));
  assert.doesNotMatch(sys, /AGENTS/);
  assert.doesNotMatch(sys, new RegExp(HARNESS_PREAMBLE.slice(0, 40)));
});

test('resolveSystem uses ~/.shadow/system_prompt.md as the base and drops Shadow module prose', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-home-'));
  mkdirSync(join(home, '.shadow'), { recursive: true });
  writeFileSync(join(home, '.shadow', 'system_prompt.md'), 'MY OWN PROMPT — do the whole job.');
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-sys-'));
  writeFileSync(join(cwd, 'AGENTS.md'), 'Project convention X.');
  const sys = resolveSystem(cwd, { installDir: INSTALL_DIR, homedir: home });

  // The tool-name hint stays — mechanical glue Shadow always contributes.
  assert.match(sys, new RegExp(HARNESS_PREAMBLE.slice(0, 40)));
  // The user's prompt IS the base.
  assert.match(sys, /MY OWN PROMPT — do the whole job\./);
  assert.match(sys, new RegExp(SHADOW_SECURITY_FOUNDATION.instruction.slice(0, 60)));
  // The built-in identity + self-limiting section + module prose are gone.
  assert.doesNotMatch(sys, /sysadmin agent/);
  assert.doesNotMatch(sys, /Calibrate to your capability/);
  assert.doesNotMatch(sys, /## Policies:/);
  // Project agent files are still ingested (fenced, untrusted) — kept regardless.
  assert.match(sys, /### AGENTS\.md/);
  assert.match(sys, /Project convention X\./);
});

test('an empty ~/.shadow/system_prompt.md is ignored (falls back to the layered base)', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-home-'));
  mkdirSync(join(home, '.shadow'), { recursive: true });
  writeFileSync(join(home, '.shadow', 'system_prompt.md'), '   \n  ');
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-sys-'));
  const sys = resolveSystem(cwd, { installDir: INSTALL_DIR, homedir: home });
  // Blank file must not blank the identity — the bundled base + modules return.
  assert.ok(sys.length > FALLBACK_SYSTEM.length);
  assert.match(sys, /## Policies:/);
});

test('selected local harness instructions extend normal and full-override prompts', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-sys-'));
  const layered = resolveSystem(cwd, {
    installDir: INSTALL_DIR,
    homedir: cwd,
    harnessInstructions: ['INCIDENT_RESPONSE_WORKFLOW_MARKER'],
  });
  assert.match(layered, /Selected harness add-ons/);
  assert.match(layered, /INCIDENT_RESPONSE_WORKFLOW_MARKER/);

  writeFileSync(join(cwd, 'override.md'), 'OVERRIDE ONLY');
  const overridden = resolveSystem(cwd, {
    installDir: INSTALL_DIR,
    homedir: cwd,
    systemPromptPath: 'override.md',
    harnessInstructions: ['OVERRIDE_HARNESS_MARKER'],
  });
  assert.match(overridden, /^OVERRIDE ONLY/);
  assert.match(overridden, /OVERRIDE_HARNESS_MARKER/);
  assert.match(overridden, new RegExp(SHADOW_SECURITY_FOUNDATION.instruction.slice(0, 60)));
});

test('selected local harness instructions survive ~/.shadow/system_prompt.md', () => {
  const home = mkdtempSync(join(tmpdir(), 'shadow-home-'));
  mkdirSync(join(home, '.shadow'), { recursive: true });
  writeFileSync(join(home, '.shadow', 'system_prompt.md'), 'CUSTOM BASE');
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-sys-'));
  const sys = resolveSystem(cwd, {
    installDir: INSTALL_DIR,
    homedir: home,
    harnessInstructions: ['OWN_PROMPT_HARNESS_MARKER'],
  });
  assert.match(sys, /CUSTOM BASE/);
  assert.match(sys, /OWN_PROMPT_HARNESS_MARKER/);
  assert.match(sys, new RegExp(SHADOW_SECURITY_FOUNDATION.instruction.slice(0, 60)));
});
