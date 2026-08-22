// T2 Phase 3 — instruction-file autopilot unit tests. Pure fs module against temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTRUCTION_FILES,
  SHADOW_SEED,
  decideInstructionAutopilot,
  seedInstructionFile,
  autopilotToastText,
} from '../src/tui/instructionAutopilot.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'autopilot-'));
}

test('the resolution order is SHADOW.md first, then AGENTS.md / CLAUDE.md', () => {
  assert.deepEqual(INSTRUCTION_FILES, ['SHADOW.md', 'AGENTS.md', 'CLAUDE.md']);
});

test('decision: none of the three → seed SHADOW.md', () => {
  const d = decideInstructionAutopilot(tmp());
  assert.deepEqual(d, { action: 'seed', file: 'SHADOW.md' });
});

test('decision: SHADOW.md present → none (silent, even if AGENTS.md also exists)', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'SHADOW.md'), '# mine');
  writeFileSync(join(dir, 'AGENTS.md'), '# agents');
  assert.deepEqual(decideInstructionAutopilot(dir), { action: 'none' });
});

test('decision: AGENTS.md only → read + acknowledge (list order preserved)', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'AGENTS.md'), '# agents');
  assert.deepEqual(decideInstructionAutopilot(dir), { action: 'read', files: ['AGENTS.md'] });
});

test('decision: CLAUDE.md + AGENTS.md (no SHADOW.md) → read both, AGENTS first', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'CLAUDE.md'), '# claude');
  writeFileSync(join(dir, 'AGENTS.md'), '# agents');
  assert.deepEqual(decideInstructionAutopilot(dir), { action: 'read', files: ['AGENTS.md', 'CLAUDE.md'] });
});

test('seed writes the scaffold and returns created', () => {
  const dir = tmp();
  const res = seedInstructionFile(dir);
  assert.ok('created' in res && res.created.endsWith('SHADOW.md'));
  const text = readFileSync(join(dir, 'SHADOW.md'), 'utf8');
  assert.equal(text, SHADOW_SEED);
  assert.match(text, /## Commands/);
  assert.match(text, /## Conventions/);
  assert.match(text, /## Hard rules/);
  assert.match(text, /\/init/, 'points back at the regeneration command');
  assert.match(text, /AGENTS\.md and CLAUDE\.md/, 'documents multi-file reading');
});

test('seed NEVER overwrites an existing SHADOW.md', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'SHADOW.md'), 'PRECIOUS');
  const res = seedInstructionFile(dir);
  assert.ok('alreadyPresent' in res);
  assert.equal(readFileSync(join(dir, 'SHADOW.md'), 'utf8'), 'PRECIOUS');
});

test('seed reports an error (never throws) when the dir is unwritable', () => {
  const dir = tmp();
  chmodSync(dir, 0o500); // read+execute, no write
  const res = seedInstructionFile(dir);
  chmodSync(dir, 0o700); // restore so cleanup works
  assert.ok('error' in res, `expected error, got ${JSON.stringify(res)}`);
  assert.ok(!existsSync(join(dir, 'SHADOW.md')));
});

test('seed is idempotent: a second call sees the first result', () => {
  const dir = tmp();
  assert.ok('created' in seedInstructionFile(dir));
  assert.ok('alreadyPresent' in seedInstructionFile(dir));
  assert.equal(readFileSync(join(dir, 'SHADOW.md'), 'utf8'), SHADOW_SEED);
});

// ── toast text mapping ───────────────────────────────────────────────────────

test('toast: seed+created → the creation ack', () => {
  const dir = tmp();
  const d = decideInstructionAutopilot(dir);
  const s = seedInstructionFile(dir);
  assert.equal(autopilotToastText(d, s), 'Created SHADOW.md — project instructions live here');
});

test('toast: seed+error → surfaces the failure, never silent', () => {
  const dir = tmp();
  const d = decideInstructionAutopilot(dir);
  assert.equal(autopilotToastText(d, { error: 'EACCES' }), 'Could not create SHADOW.md: EACCES');
});

test('toast: seed without an outcome, or alreadyPresent mid-session → null', () => {
  const dir = tmp();
  const d = decideInstructionAutopilot(dir);
  assert.equal(autopilotToastText(d, undefined), null);
  writeFileSync(join(dir, 'SHADOW.md'), 'x');
  assert.equal(autopilotToastText(d, { alreadyPresent: join(dir, 'SHADOW.md') }), null);
});

test('toast: read → names the files being ingested', () => {
  const d = decideInstructionAutopilot(tmp());
  void d;
  assert.equal(
    autopilotToastText({ action: 'read', files: ['AGENTS.md', 'CLAUDE.md'] }),
    'Reading AGENTS.md + CLAUDE.md as project context',
  );
});

test('toast: none → null (stay silent when SHADOW.md already rules)', () => {
  assert.equal(autopilotToastText({ action: 'none' }), null);
});
