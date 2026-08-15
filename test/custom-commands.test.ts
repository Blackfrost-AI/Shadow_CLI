import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCustomCommands, parseCommandFile, expandCommandBody } from '../src/tui/customCommands.js';

function ws(): string {
  return mkdtempSync(join(tmpdir(), 'cmds-'));
}
function writeCmd(root: string, dir: string, name: string, content: string): void {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), content);
}

test('parseCommandFile: frontmatter description + body strip; first-line fallback', () => {
  const fm = parseCommandFile('---\ndescription: Review the diff\n---\nDo a careful review of $ARGUMENTS.');
  assert.equal(fm.description, 'Review the diff');
  assert.equal(fm.body, 'Do a careful review of $ARGUMENTS.');
  const plain = parseCommandFile('# Title\n\nSummarize the file.\nmore');
  assert.equal(plain.description, 'Summarize the file.');
});

test('expandCommandBody: $ARGUMENTS, positional $1, and append-when-no-placeholder', () => {
  assert.equal(expandCommandBody('Review $ARGUMENTS now', 'a.ts b.ts'), 'Review a.ts b.ts now');
  assert.equal(expandCommandBody('First=$1 Second=$2', 'x y'), 'First=x Second=y');
  // No placeholder + args → args appended so context still reaches the model.
  assert.equal(expandCommandBody('Run the linter.', 'src/'), 'Run the linter.\n\nsrc/');
  // No placeholder + no args → unchanged.
  assert.equal(expandCommandBody('Run the linter.', ''), 'Run the linter.');
});

test('discovers workspace .shadow/commands and .claude/commands *.md as commands', () => {
  const root = ws();
  try {
    writeCmd(root, '.shadow/commands', 'review.md', '---\ndescription: Careful review\n---\nReview $ARGUMENTS');
    writeCmd(root, '.claude/commands', 'ship.md', 'Ship it: run tests then summarize.');
    const cmds = discoverCustomCommands(root, join(root, 'nohome'));
    const names = cmds.map((c) => c.name).sort();
    assert.deepEqual(names, ['review', 'ship']);
    const review = cmds.find((c) => c.name === 'review')!;
    assert.equal(review.description, 'Careful review');
    assert.equal(review.workspace, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('global (~) commands win over a same-named workspace command', () => {
  const root = ws();
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  try {
    writeCmd(root, '.shadow/commands', 'deploy.md', 'WORKSPACE deploy body');
    writeCmd(home, '.shadow/commands', 'deploy.md', 'GLOBAL deploy body');
    const cmds = discoverCustomCommands(root, home);
    const deploy = cmds.filter((c) => c.name === 'deploy');
    assert.equal(deploy.length, 1, 'no duplicate');
    assert.equal(deploy[0]!.body, 'GLOBAL deploy body', 'trusted global wins');
    assert.equal(deploy[0]!.workspace, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('rejects a symlinked command file (no reading a secret into a prompt)', () => {
  const root = ws();
  const secret = join(root, 'secret.txt');
  try {
    writeFileSync(secret, 'PRIVATE KEY MATERIAL');
    const d = join(root, '.shadow/commands');
    mkdirSync(d, { recursive: true });
    try {
      symlinkSync(secret, join(d, 'evil.md'));
    } catch {
      return; // platform without symlink perms — nothing to assert
    }
    const cmds = discoverCustomCommands(root, join(root, 'nohome'));
    assert.ok(!cmds.some((c) => c.name === 'evil'), 'symlinked command file is skipped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects invalid command names (path/option smuggling)', () => {
  const root = ws();
  try {
    writeCmd(root, '.shadow/commands', 'bad name.md', 'x'); // space
    writeCmd(root, '.shadow/commands', '--flag.md', 'x'); // leading dash
    writeCmd(root, '.shadow/commands', 'ok.md', 'ok body');
    const cmds = discoverCustomCommands(root, join(root, 'nohome'));
    assert.deepEqual(cmds.map((c) => c.name), ['ok']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
