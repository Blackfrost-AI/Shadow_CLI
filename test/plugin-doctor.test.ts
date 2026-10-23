/**
 * `shadow plugin doctor` — the report must be trustworthy in both directions.
 *
 * A doctor that cries wolf is ignored; a doctor that stays silent while content is dropped is
 * worse than no doctor. These tests pin both: a clean plugin reports clean, and a plugin with
 * dropped files / dangling refs / exceeded caps reports exactly that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diagnosePlugin,
  formatDoctorReport,
  findDanglingRefs,
  resolveDiagnosisRoot,
} from '../src/plugins/doctor.js';
import { PLUGIN_MAX_FILES, PLUGIN_MAX_BYTES } from '../src/plugins/manager.js';

function fixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `shadow-doctor-${name}-`));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name, version: '1.0.0', description: 'd' }));
  return dir;
}

function skill(root: string, name: string, body = 'body'): void {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
}

test('a markdown-only plugin reports clean', () => {
  const root = fixture('clean');
  try {
    skill(root, 'alpha');
    skill(root, 'beta');
    const r = diagnosePlugin(root);
    assert.equal(r.clean, true, formatDoctorReport(r));
    assert.equal(r.dropped.length, 0);
    assert.equal(r.dangling.length, 0);
    assert.ok(!r.caps.over);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dropped non-markdown files are counted by extension', () => {
  const root = fixture('drops');
  try {
    skill(root, 'alpha');
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'a.sh'), '#!/bin/sh\n');
    writeFileSync(join(root, 'hooks', 'b.sh'), '#!/bin/sh\n');
    writeFileSync(join(root, 'hooks', 'c.py'), 'print(1)\n');
    const r = diagnosePlugin(root);
    assert.equal(r.clean, false, 'dropped files must make the report unclean');
    const sh = r.dropped.find((d) => d.ext === '.sh');
    const py = r.dropped.find((d) => d.ext === '.py');
    assert.equal(sh?.count, 2);
    assert.equal(py?.count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a markdown reference to a dropped script is reported as non-markdown', () => {
  const root = fixture('dangling');
  try {
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'guard.sh'), '#!/bin/sh\n');
    skill(root, 'alpha', 'The `hooks/guard.sh` hook enforces this.');
    const r = diagnosePlugin(root);
    const hit = r.dangling.find((d) => d.ref === 'hooks/guard.sh');
    assert.ok(hit, `expected a dangling ref, got ${JSON.stringify(r.dangling)}`);
    assert.equal(hit.reason, 'non-markdown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a reference to a path that does not exist is reported as missing', () => {
  const root = fixture('missing');
  try {
    skill(root, 'alpha', 'Run `scripts/nothere.py` first.');
    const r = diagnosePlugin(root);
    const hit = r.dangling.find((d) => d.ref === 'scripts/nothere.py');
    assert.ok(hit);
    assert.equal(hit.reason, 'missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('markdown-to-markdown references are NOT reported as dangling', () => {
  const root = fixture('mdref');
  try {
    skill(root, 'alpha', 'See `references/notes.md` for detail.');
    mkdirSync(join(root, 'skills', 'alpha', 'references'), { recursive: true });
    writeFileSync(join(root, 'skills', 'alpha', 'references', 'notes.md'), '# notes\n');
    const r = diagnosePlugin(root);
    assert.equal(
      r.dangling.filter((d) => d.ref.includes('notes.md')).length,
      0,
      'a .md file that exists is copied, so it must not be reported',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prose like "Node.js" is not mistaken for a file reference', () => {
  const root = fixture('prose');
  try {
    skill(root, 'alpha', 'Works with Node.js and Vue.js and Next.js.');
    const r = diagnosePlugin(root);
    assert.equal(r.dangling.length, 0, `expected no refs, got ${JSON.stringify(r.dangling)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('symlinks are reported, since their targets never arrive', () => {
  const root = fixture('symlink');
  try {
    skill(root, 'alpha');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'real.md'), '# real\n');
    symlinkSync(join(root, 'scripts', 'real.md'), join(root, 'scripts', 'link.md'));
    const r = diagnosePlugin(root);
    assert.equal(r.symlinks.length, 1);
    assert.equal(r.clean, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exceeding the file cap is reported, not thrown', () => {
  const root = fixture('overcap');
  try {
    // One past the cap. Diagnosing must still SUCCEED and report — the point is to explain
    // why an install would fail, so it cannot fail the same way.
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    for (let i = 0; i <= PLUGIN_MAX_FILES; i++) {
      writeFileSync(join(skillsDir, `s${i}.md`), '# x\n');
    }
    const r = diagnosePlugin(root);
    assert.equal(r.caps.over, true);
    assert.equal(r.caps.maxFiles, PLUGIN_MAX_FILES);
    assert.ok(r.caps.files > PLUGIN_MAX_FILES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('caps expose the raised limits (5000 files / 32 MB)', () => {
  assert.equal(PLUGIN_MAX_FILES, 5000);
  assert.equal(PLUGIN_MAX_BYTES, 32 * 1024 * 1024);
});

test('the rendered report names each problem section', () => {
  const root = fixture('render');
  try {
    skill(root, 'alpha', 'Uses `hooks/x.sh`.');
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'x.sh'), '#!/bin/sh\n');
    const text = formatDoctorReport(diagnosePlugin(root));
    assert.match(text, /DROPPED/);
    assert.match(text, /DANGLING REFERENCES/);
    assert.match(text, /NOT CLEAN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findDanglingRefs ignores root-level docs, which describe the repo not the plugin', () => {
  const root = fixture('rootdocs');
  try {
    skill(root, 'alpha');
    writeFileSync(join(root, 'CHANGELOG.md'), 'Fixed scripts/gone.js in this release.\n');
    const installed = new Set([join(root, 'CHANGELOG.md'), join(root, 'skills', 'alpha', 'SKILL.md')]);
    const refs = findDanglingRefs(root, installed);
    assert.equal(
      refs.filter((r) => r.file === 'CHANGELOG.md').length,
      0,
      'root docs must not contribute noise',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// --- Regression: bare `.md` basenames are prose, not plugin paths (defect B) ---------------
//
// `CLAUDE.md`, `SOUL.md`, `todo.md` and friends overwhelmingly name files in the CONSUMING
// project, or name the convention itself. Reporting them as dangling produced 378 false
// positives on ECC and made the report unreadable — exactly the "cries wolf" failure the
// header of this file warns about.

test('a bare .md basename in prose is not a plugin reference', () => {
  const root = fixture('baremd');
  try {
    skill(root, 'alpha', 'Read the target project `CLAUDE.md` and `SOUL.md`, then update `todo.md`.');
    const r = diagnosePlugin(root);
    assert.equal(r.dangling.length, 0, `expected no refs, got ${JSON.stringify(r.dangling)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a directory-qualified .md reference is still reported when it is missing', () => {
  // Discriminator: suppressing bare basenames must not blind the tool to real nested refs.
  const root = fixture('nestedmd');
  try {
    skill(root, 'alpha', 'See `references/notes.md` for detail.');
    const r = diagnosePlugin(root);
    const hit = r.dangling.find((d) => d.ref === 'references/notes.md');
    assert.ok(hit, `expected a dangling ref, got ${JSON.stringify(r.dangling)}`);
    assert.equal(hit.reason, 'missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a real path and a bare basename on the same line report only the real path', () => {
  // The exact ECC shape: a resolvable nested path plus prose naming the convention.
  const root = fixture('mixed');
  try {
    skill(root, 'alpha', 'Read `skills/beta/SKILL.md`. Example input is a standard `SKILL.md` file.');
    skill(root, 'beta');
    const r = diagnosePlugin(root);
    assert.equal(r.dangling.length, 0, `expected no refs, got ${JSON.stringify(r.dangling)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Regression: diagnose the source tree, not the already-stripped install (defect A) -----
//
// The installed copy has already lost every non-.md file, so diagnosing it labels every script
// reference `missing` and leaves DROPPED nearly empty. That inverts the tool's whole purpose.

test('resolveDiagnosisRoot prefers a recorded local source over the stripped install', () => {
  const source = fixture('src');
  const install = mkdtempSync(join(tmpdir(), 'shadow-doctor-inst-'));
  try {
    skill(source, 'alpha', 'Uses `hooks/guard.sh`.');
    mkdirSync(join(source, 'hooks'), { recursive: true });
    writeFileSync(join(source, 'hooks', 'guard.sh'), '#!/bin/sh\n');
    mkdirSync(install, { recursive: true });
    writeFileSync(
      join(install, '.shadow-plugin-meta.json'),
      JSON.stringify({ enabled: true, installedAt: 'now', source: { kind: 'path', path: source } }),
    );
    const resolved = resolveDiagnosisRoot(install);
    assert.equal(resolved.root, source, 'must diagnose the source tree');
    assert.equal(resolved.sourceOf, install, 'must report where the install lives');
    // And that choice is what makes the drop visible.
    assert.equal(diagnosePlugin(resolved.root).dropped.find((d) => d.ext === '.sh')?.count, 1);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(install, { recursive: true, force: true });
  }
});

test('resolveDiagnosisRoot falls back to the install when the source is gone', () => {
  const install = mkdtempSync(join(tmpdir(), 'shadow-doctor-gone-'));
  try {
    mkdirSync(install, { recursive: true });
    writeFileSync(
      join(install, '.shadow-plugin-meta.json'),
      JSON.stringify({
        enabled: true,
        installedAt: 'now',
        source: { kind: 'path', path: join(install, 'vanished') },
      }),
    );
    assert.equal(resolveDiagnosisRoot(install).root, install);
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
});

test('resolveDiagnosisRoot leaves git installs and bare paths alone', () => {
  const install = mkdtempSync(join(tmpdir(), 'shadow-doctor-git-'));
  try {
    mkdirSync(install, { recursive: true });
    writeFileSync(
      join(install, '.shadow-plugin-meta.json'),
      JSON.stringify({
        enabled: true,
        installedAt: 'now',
        source: { kind: 'git', url: 'https://example.test/x', commit: 'abc' },
      }),
    );
    assert.equal(resolveDiagnosisRoot(install).root, install);
    // No meta at all — a plain path argument.
    const bare = mkdtempSync(join(tmpdir(), 'shadow-doctor-bare-'));
    try {
      assert.equal(resolveDiagnosisRoot(bare).root, bare);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
});

test('the report names the source tree when one was substituted', () => {
  const root = fixture('render-src');
  try {
    skill(root, 'alpha');
    const text = formatDoctorReport(diagnosePlugin(root), '/some/install/dir');
    assert.match(text, /source tree/);
    assert.match(text, /\/some\/install\/dir/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
