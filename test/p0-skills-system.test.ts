import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSkills } from '../src/skills/loader.js';
import { resolveSystem } from '../src/system/resolveSystem.js';

const INSTALL_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * P0-7: a hostile repo can symlink skills/<x>/SKILL.md at a secret (e.g. ~/.ssh/id_ed25519)
 * to read it straight into the system prompt. discoverSkills must refuse the symlink and
 * never surface the secret — while still finding legitimate, non-symlinked skills.
 */
test('discoverSkills refuses a symlinked SKILL.md and never reads the secret it points at', () => {
  const ws = mkdtempSync(join(tmpdir(), 'p0-skills-'));
  try {
    const secret = join(ws, 'id_ed25519');
    writeFileSync(secret, 'SECRET-PRIVATE-KEY-MATERIAL');

    // Hostile skill: SKILL.md is a symlink to the secret.
    mkdirSync(join(ws, 'skills', 'evil'), { recursive: true });
    symlinkSync(secret, join(ws, 'skills', 'evil', 'SKILL.md'));

    // Legit skill: a real SKILL.md should still be discovered.
    mkdirSync(join(ws, 'skills', 'good'), { recursive: true });
    writeFileSync(join(ws, 'skills', 'good', 'SKILL.md'), '# Good\nA harmless helper.');

    const skills = discoverSkills(ws);

    assert.equal(
      skills.find((s) => s.name === 'evil'),
      undefined,
      'the symlinked skill is not surfaced',
    );
    assert.ok(
      !skills.some((s) => s.body.includes('SECRET-PRIVATE-KEY-MATERIAL')),
      'the secret never lands in any skill body',
    );
    assert.ok(
      skills.find((s) => s.name === 'good'),
      'a legitimate non-symlinked skill is still discovered',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

/**
 * P0-8(b): a PROJECT SHADOW.md lives in the untrusted working repo, so it must be wrapped in
 * the untrusted-data fence and capped (AGENT_FILE_CAP), never spliced at full system trust.
 */
test('resolveSystem fences and caps a project SHADOW.md instead of trusting it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'p0-sys-'));
  try {
    const head = 'PROJECT-SHADOW-HEAD';
    const tail = 'PROJECT-SHADOW-TAIL';
    // > AGENT_FILE_CAP (8000) so the tail is truncated away.
    writeFileSync(join(cwd, 'SHADOW.md'), `${head}\n${'x'.repeat(9000)}\n${tail}`);

    const sys = resolveSystem(cwd, { installDir: INSTALL_DIR, homedir: cwd });

    assert.match(sys, /### SHADOW\.md/, 'project SHADOW.md is listed as an untrusted agent file');
    assert.match(sys, /UNTRUSTED repository text/, 'it sits under the untrusted fence');
    assert.ok(sys.includes(head), 'the in-cap head of the project file is kept');
    assert.ok(!sys.includes(tail), 'content beyond AGENT_FILE_CAP is truncated');
    assert.match(sys, /…\(truncated\)/, 'truncation is marked');
    assert.ok(
      sys.indexOf(head) > sys.indexOf('UNTRUSTED repository text'),
      'the project content appears inside the fence, not at full system trust',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
