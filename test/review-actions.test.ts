import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewReviewAction, applyReviewAction } from '../src/state/reviewActions.js';
import { readChanges } from '../src/state/gitChanges.js';
import { ChangeReview } from '../src/app/changeReview.js';
import { visibleWidth } from '@earendil-works/pi-tui';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shadow-review-actions-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); writeFileSync(join(root, '.gitignore'), '.shadow/\n');
  writeFileSync(join(root, 'a.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join(''));
  writeFileSync(join(root, 'other.txt'), 'unrelated\n'); git('add', '.'); git('commit', '-qm', 'initial');
  const file = (area: string, path = 'a.txt') => { const value = readChanges(root).files.find((item) => item.area === area && item.path === path); assert.ok(value, `${area} ${path} exists`); return value; };
  return { root, git, file, close: () => rmSync(root, { recursive: true, force: true }) };
}
function modify(root: string) {
  writeFileSync(join(root, 'a.txt'), readFileSync(join(root, 'a.txt'), 'utf8').replace('line 2\n', 'changed 2\n').replace('line 28\n', 'changed 28\n'));
}

test('scoped staging and unstaging change only the selected file, including a new binary file', () => {
  const f = fixture();
  try {
    modify(f.root); writeFileSync(join(f.root, 'other.txt'), 'human work\n');
    const preview = previewReviewAction(f.root, f.file('unstaged'), 'stage');
    assert.match(preview.diff, /changed 2/); assert.equal(f.git('diff', '--cached'), '');
    applyReviewAction(preview);
    assert.match(f.git('diff', '--cached'), /changed 2/); assert.equal(f.git('diff', '--', 'a.txt'), '');
    assert.match(f.git('diff', '--', 'other.txt'), /human work/);
    applyReviewAction(previewReviewAction(f.root, f.file('staged'), 'unstage'));
    assert.equal(f.git('diff', '--cached'), ''); assert.match(f.git('diff', '--', 'a.txt'), /changed 2/);
    writeFileSync(join(f.root, 'new binary.bin'), Buffer.from([0, 1, 2, 255]));
    applyReviewAction(previewReviewAction(f.root, f.file('untracked', 'new binary.bin'), 'stage'));
    assert.deepEqual(execFileSync('git', ['-C', f.root, 'show', ':new binary.bin']), Buffer.from([0, 1, 2, 255]));
    applyReviewAction(previewReviewAction(f.root, f.file('staged', 'new binary.bin'), 'unstage'));
    assert.equal(f.git('ls-files', '--', 'new binary.bin'), ''); assert.ok(existsSync(join(f.root, 'new binary.bin')));
  } finally { f.close(); }
});

test('individual hunk stage/unstage preserves the other hunk', () => {
  const f = fixture();
  try {
    modify(f.root);
    const preview = previewReviewAction(f.root, f.file('unstaged'), 'stage', 1);
    assert.doesNotMatch(preview.diff, /changed 2\n/); assert.match(preview.diff, /changed 28/);
    applyReviewAction(preview);
    const staged = f.git('diff', '--cached'); assert.match(staged, /changed 28/); assert.doesNotMatch(staged, /changed 2\n/);
    assert.match(f.git('diff', '--', 'a.txt'), /changed 2\n/);
    applyReviewAction(previewReviewAction(f.root, f.file('staged'), 'unstage', 0));
    assert.equal(f.git('diff', '--cached'), ''); assert.match(f.git('diff'), /changed 28/);
  } finally { f.close(); }
});

test('hunk restore retains a byte-exact backup and preserves other hunks and staged changes', () => {
  const f = fixture();
  try {
    modify(f.root); f.git('add', 'a.txt');
    writeFileSync(join(f.root, 'a.txt'), readFileSync(join(f.root, 'a.txt'), 'utf8').replace('line 10\n', 'unstaged 10\n').replace('line 20\n', 'unstaged 20\n'));
    const before = readFileSync(join(f.root, 'a.txt'));
    const result = applyReviewAction(previewReviewAction(f.root, f.file('unstaged'), 'restore', 0));
    const after = readFileSync(join(f.root, 'a.txt'), 'utf8');
    assert.match(after, /line 10\n/); assert.match(after, /unstaged 20/); assert.match(after, /changed 2\n/);
    assert.match(f.git('diff', '--cached'), /changed 28/);
    const backup = JSON.parse(readFileSync(result.backupPath!, 'utf8'));
    assert.deepEqual(Buffer.from(backup.contentBase64, 'base64'), before);
    assert.doesNotMatch(f.git('diff'), /unstaged 10/);
  } finally { f.close(); }
});

test('whole-file restore handles binary and deleted tracked files without deleting untracked files', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'binary.bin'), Buffer.from([0, 12, 44])); f.git('add', '.'); f.git('commit', '-qm', 'binary');
    writeFileSync(join(f.root, 'binary.bin'), Buffer.from([0, 13, 45]));
    applyReviewAction(previewReviewAction(f.root, f.file('unstaged', 'binary.bin'), 'restore'));
    assert.deepEqual(readFileSync(join(f.root, 'binary.bin')), Buffer.from([0, 12, 44]));
    unlinkSync(join(f.root, 'a.txt'));
    applyReviewAction(previewReviewAction(f.root, f.file('unstaged'), 'restore'));
    assert.match(readFileSync(join(f.root, 'a.txt'), 'utf8'), /line 1/);
    writeFileSync(join(f.root, 'new.txt'), 'retain me');
    assert.throws(() => previewReviewAction(f.root, f.file('untracked', 'new.txt'), 'restore'), /untracked files are never deleted/);
    assert.equal(readFileSync(join(f.root, 'new.txt'), 'utf8'), 'retain me');
  } finally { f.close(); }
});

test('intervening file or index changes reject the preview without overwriting user work', () => {
  const f = fixture();
  try {
    modify(f.root); const preview = previewReviewAction(f.root, f.file('unstaged'), 'restore');
    writeFileSync(join(f.root, 'a.txt'), 'human changed it after review\n');
    assert.throws(() => applyReviewAction(preview), /changed since preview/);
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'human changed it after review\n');
    const next = previewReviewAction(f.root, f.file('unstaged'), 'stage');
    writeFileSync(join(f.root, 'other.txt'), 'staged human change\n'); f.git('add', 'other.txt');
    assert.throws(() => applyReviewAction(next), /changed since preview/);
    assert.match(f.git('diff', '--cached'), /staged human change/); assert.doesNotMatch(f.git('diff', '--cached'), /human changed it after review/);
    assert.equal(existsSync(join(f.root, '.git/index.lock')), false);
  } finally { f.close(); }
});

test('review rejects unsupported hunks, traversal, modified tokens and busy index locks', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'new.txt'), 'new\n');
    assert.throws(() => previewReviewAction(f.root, f.file('untracked', 'new.txt'), 'stage', 0), /ordinary modified text/);
    assert.throws(() => previewReviewAction(f.root, { path: '../escape', status: 'M', area: 'unstaged' }, 'restore'), /exact workspace-relative/);
    modify(f.root); const preview = previewReviewAction(f.root, f.file('unstaged'), 'stage');
    assert.throws(() => applyReviewAction({ ...preview, path: 'other.txt' }), /expired or changed/);
    writeFileSync(join(f.root, '.git/index.lock'), 'another process');
    assert.throws(() => applyReviewAction(preview), /index is busy/);
    assert.equal(readFileSync(join(f.root, '.git/index.lock'), 'utf8'), 'another process');
  } finally { f.close(); }
});

test('review refuses file symlinks before preparing a mutation', { skip: process.platform === 'win32' ? 'File symlinks require Windows developer mode or elevation.' : false }, () => {
  const f = fixture();
  try {
    symlinkSync('a.txt', join(f.root, 'link.txt'));
    assert.throws(() => previewReviewAction(f.root, { path: 'link.txt', status: 'M', area: 'unstaged' }, 'restore'), /symlinks/);
  } finally { f.close(); }
});

test('whole-file staging preserves executable index modes when Git ignores filesystem modes', () => {
  const f = fixture();
  try {
    f.git('config', 'core.filemode', 'false');
    f.git('update-index', '--chmod=+x', 'a.txt'); f.git('commit', '-qm', 'executable tracked file');
    modify(f.root);
    applyReviewAction(previewReviewAction(f.root, f.file('unstaged'), 'stage'));
    assert.match(f.git('ls-files', '--stage', '--', 'a.txt'), /^100755 /);
    assert.match(f.git('diff', '--cached'), /changed 2/);
    writeFileSync(join(f.root, 'new.txt'), 'new\n');
    applyReviewAction(previewReviewAction(f.root, f.file('untracked', 'new.txt'), 'stage'));
    assert.match(f.git('ls-files', '--stage', '--', 'new.txt'), /^100644 /);
  } finally { f.close(); }
});

test('restoring a hunk preserves no-final-newline bytes', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'a.txt'), 'one\ntwo'); f.git('add', 'a.txt'); f.git('commit', '-qm', 'no newline');
    writeFileSync(join(f.root, 'a.txt'), 'one\nchanged');
    applyReviewAction(previewReviewAction(f.root, f.file('unstaged'), 'restore', 0));
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'one\ntwo');
  } finally { f.close(); }
});

test('review browser exposes scoped action callbacks while fitting narrow terminals', () => {
  const file = { path: 'a.txt', status: 'M', area: 'unstaged' as const };
  const actions: unknown[] = [];
  const browser = new ChangeReview({ changes: { title: 'Changes', scope: { kind: 'working' }, files: [file], summary: ['unstaged a.txt'] }, diff: () => '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n@@ -20 +20 @@\n-c\n+d', rows: () => 15, repaint: () => {}, close: () => {}, action: (...args) => actions.push(args) });
  browser.handleInput('s'); browser.handleInput('\r'); browser.handleInput('n'); browser.handleInput('n'); browser.handleInput('d'); browser.handleInput('U');
  assert.deepEqual(actions, [[file, 'stage', undefined], [file, 'restore', 1], [file, 'unstage', undefined]]);
  for (const width of [24, 48, 120]) assert.ok(browser.render(width).every((line) => visibleWidth(line) <= width));
});

test('preview refuses Git conversion filters before executing them', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, '.gitattributes'), 'a.txt filter=fixture\n');
    f.git('config', 'filter.fixture.clean', 'touch FILTER_MUST_NOT_RUN; cat');
    modify(f.root);
    assert.throws(() => previewReviewAction(f.root, { path: 'a.txt', area: 'unstaged', status: 'M' }, 'stage'), /Git filter conversion/);
    assert.equal(existsSync(join(f.root, 'FILTER_MUST_NOT_RUN')), false);
  } finally { f.close(); }
});
