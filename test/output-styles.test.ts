import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCustomStyles, parseStyleFile } from '../src/agent/outputStyles.js';
import { setCustomStyles, customStyleBlock, customStyleNames, isKnownStyle } from '../src/agent/styles.js';
import { buildStyledSystem } from '../src/agent/system.js';

function ws(): string {
  return mkdtempSync(join(tmpdir(), 'os-'));
}
function writeStyle(root: string, dir: string, name: string, content: string): void {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), content);
}

test('parseStyleFile: frontmatter label + body; name-derived label fallback', () => {
  const fm = parseStyleFile('terse', '---\nlabel: Terse *Blunt*\n---\nBe extremely concise.');
  assert.equal(fm.label, 'Terse Blunt'); // markdown control chars (*) stripped
  assert.equal(fm.block, 'Be extremely concise.');
  const plain = parseStyleFile('mentor', 'Explain like a patient mentor.');
  assert.equal(plain.label, 'Mentor');
});

test('discoverCustomStyles finds .shadow and .claude output-styles; global wins on collision', () => {
  const root = ws();
  const home = mkdtempSync(join(tmpdir(), 'os-home-'));
  try {
    writeStyle(root, '.shadow/output-styles', 'terse.md', '---\nlabel: Terse\n---\nBe brief.');
    writeStyle(root, '.claude/output-styles', 'mentor.md', 'Teach as you go.');
    writeStyle(root, '.shadow/output-styles', 'shared.md', 'WORKSPACE shared');
    writeStyle(home, '.shadow/output-styles', 'shared.md', 'GLOBAL shared');
    const styles = discoverCustomStyles(root, home);
    const names = styles.map((s) => s.name).sort();
    assert.deepEqual(names, ['mentor', 'shared', 'terse']);
    assert.match(styles.find((s) => s.name === 'shared')!.block, /GLOBAL shared/, 'trusted global wins');
    assert.match(styles.find((s) => s.name === 'terse')!.block, /## Output style — Terse/, 'block is titled');
    assert.match(styles.find((s) => s.name === 'terse')!.block, /Be brief\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a symlinked style file is skipped (no reading a secret into the system prompt)', () => {
  const root = ws();
  try {
    writeFileSync(join(root, 'secret.txt'), 'PRIVATE');
    const d = join(root, '.shadow/output-styles');
    mkdirSync(d, { recursive: true });
    try {
      symlinkSync(join(root, 'secret.txt'), join(d, 'evil.md'));
    } catch {
      return; // platform without symlink perms
    }
    assert.ok(!discoverCustomStyles(root, join(root, 'nohome')).some((s) => s.name === 'evil'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry: buildStyledSystem falls back to a registered custom style block', () => {
  try {
    setCustomStyles([{ name: 'terse', label: 'Terse', block: '\n## Output style — Terse\nBe brief.\n' }]);
    assert.ok(isKnownStyle('terse'));
    assert.ok(isKnownStyle('proactive'), 'built-ins still known');
    assert.ok(customStyleNames().includes('terse'));
    assert.match(customStyleBlock('terse') ?? '', /Be brief\./);
    // Built-in still resolves…
    assert.match(buildStyledSystem('BASE', 'proactive' as never), /Output style — Proactive/);
    // …and a custom name resolves via the fallback.
    const sys = buildStyledSystem('BASE', 'terse' as never);
    assert.match(sys, /BASE/);
    assert.match(sys, /Output style — Terse/);
    assert.match(sys, /Be brief\./);
  } finally {
    setCustomStyles([]); // don't leak into other tests
  }
});

test('an unknown style name yields no block (no crash)', () => {
  setCustomStyles([]);
  const sys = buildStyledSystem('BASE', 'nonexistent' as never);
  assert.equal(sys, 'BASE');
});
