/**
 * Skill mode scoping: `mode:` frontmatter keeps a large catalogue from taxing every session.
 *
 * The contract is opt-in. A skill with no `mode:` is available everywhere, so an existing
 * install behaves exactly as before — that is the property most likely to regress, so it is
 * tested first and hardest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, parseMode, filterByMode } from '../src/skills/loader.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-mode-'));
}

function addSkill(root: string, name: string, mode?: string): void {
  const dir = join(root, '.shadow', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const front = [`name: ${name}`, `description: ${name} desc`];
  if (mode !== undefined) front.push(`mode: ${mode}`);
  writeFileSync(join(dir, 'SKILL.md'), `---\n${front.join('\n')}\n---\nbody for ${name}\n`);
}

test('parseMode reads a bare scalar', () => {
  assert.equal(parseMode('---\nname: x\nmode: security\n---\nbody'), 'security');
});

test('parseMode lowercases and trims', () => {
  assert.equal(parseMode('---\nmode:   SECURITY  \n---\nb'), 'security');
});

test('parseMode strips a trailing comment', () => {
  assert.equal(parseMode('---\nmode: security # red/purple\n---\nb'), 'security');
});

test('parseMode handles quoted values', () => {
  assert.equal(parseMode('---\nmode: "security"\n---\nb'), 'security');
  assert.equal(parseMode("---\nmode: 'security'\n---\nb"), 'security');
});

test('parseMode returns undefined when absent — the opt-in default', () => {
  assert.equal(parseMode('---\nname: x\ndescription: d\n---\nb'), undefined);
});

test('parseMode rejects a value that is not a bare slug', () => {
  assert.equal(parseMode('---\nmode: ../../etc\n---\nb'), undefined);
  assert.equal(parseMode('---\nmode: [a, b]\n---\nb'), undefined);
});

test('parseMode ignores mode outside frontmatter', () => {
  assert.equal(parseMode('body mentions\nmode: security\n'), undefined);
});

test('with no mode filter, every skill is returned', () => {
  const ws = workspace();
  try {
    addSkill(ws, 'alpha');
    addSkill(ws, 'beta', 'security');
    addSkill(ws, 'gamma', 'coding');
    const skills = discoverSkills(ws, { homedir: join(ws, 'home') });
    // Bundled skills ship with the agent and are always present; mode-scoped assertions
    // compare the disk-authored set only.
    assert.deepEqual(
      skills.filter((s) => s.source !== 'bundled').map((s) => s.name).sort(),
      ['alpha', 'beta', 'gamma'],
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

/** Disk-authored names only — bundled skills ship with the agent and are always present. */

function assertDiskNames(skills: Array<{ name: string; source?: string }>, expected: string[], label?: string): void {
  assert.deepEqual(
    skills.filter((s) => s.source !== 'bundled').map((s) => s.name).sort(),
    expected,
    label,
  );
}

test('a mode filter keeps unscoped skills and the matching mode only', () => {
  const ws = workspace();
  try {
    addSkill(ws, 'alpha');
    addSkill(ws, 'beta', 'security');
    addSkill(ws, 'gamma', 'coding');
    const skills = discoverSkills(ws, { homedir: join(ws, 'home'), mode: 'security' });
    assertDiskNames(skills, ['alpha', 'beta']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('mode matching is case-insensitive on both sides', () => {
  const ws = workspace();
  try {
    addSkill(ws, 'beta', 'Security');
    const skills = discoverSkills(ws, { homedir: join(ws, 'home'), mode: 'SECURITY' });
    assertDiskNames(skills, ['beta']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('scoping actually reduces the index — the whole point', () => {
  const ws = workspace();
  try {
    for (let i = 0; i < 30; i++) addSkill(ws, `sec${i}`, 'security');
    for (let i = 0; i < 30; i++) addSkill(ws, `code${i}`, 'coding');
    const all = discoverSkills(ws, { homedir: join(ws, 'home') });
    const sec = discoverSkills(ws, { homedir: join(ws, 'home'), mode: 'security' });
    // Disk-authored counts only — bundled skills ship regardless of scope.
    assert.equal(all.filter((s) => s.source !== 'bundled').length, 60);
    assert.equal(sec.filter((s) => s.source !== 'bundled').length, 30);
    assert.ok(sec.length < all.length);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('filterByMode re-scopes an already-discovered list', () => {
  const list = [{ name: 'a' }, { name: 'b', mode: 'security' }, { name: 'c', mode: 'coding' }];
  assert.equal(filterByMode(list, undefined).length, 3);
  assert.deepEqual(filterByMode(list, 'security').map((s) => s.name), ['a', 'b']);
  assert.deepEqual(filterByMode(list, 'coding').map((s) => s.name), ['a', 'c']);
});
test('a comma-separated mode list matches any of its members', () => {
  const ws = workspace();
  try {
    addSkill(ws, 'both', 'security, coding');
    addSkill(ws, 'only-sec', 'security');
    addSkill(ws, 'only-code', 'coding');
    assertDiskNames(
      discoverSkills(ws, { homedir: join(ws, 'home'), mode: 'security' }),
      ['both', 'only-sec'],
    );
    assertDiskNames(
      discoverSkills(ws, { homedir: join(ws, 'home'), mode: 'coding' }),
      ['both', 'only-code'],
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
