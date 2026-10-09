import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readChanges, readFileDiff, reviewMaterial } from '../src/state/gitChanges.js';
import { writeFile } from '../src/tools/writeFile.js';
import { listCheckpointsForTurn } from '../src/state/checkpoints.js';
import { WorkCenter } from '../src/app/workCenter.js';
import { EventBus } from '../src/agent/events.js';
import { WorkBrowser } from '../src/app/workBrowser.js';
import { ChangeReview } from '../src/app/changeReview.js';
import { visibleWidth } from '@earendil-works/pi-tui';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shadow-parity-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); writeFileSync(join(root, '.gitignore'), '.shadow/\n'); writeFileSync(join(root, 'tracked.txt'), 'original\n');
  git('add', '.'); git('commit', '-qm', 'initial');
  return { root, git, close: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) };
}

test('change inventory preserves staged, unstaged, untracked and renamed filenames', () => {
  const f = fixture();
  try {
    // Windows forbids newlines in filenames; keep the POSIX case while exercising
    // spaces and Unicode on every platform.
    const untrackedPath = process.platform === 'win32' ? 'new file café.txt' : 'new file\nwith newline café.txt';
    writeFileSync(join(f.root, 'tracked.txt'), 'staged\n'); f.git('add', 'tracked.txt');
    writeFileSync(join(f.root, 'tracked.txt'), 'unstaged\n'); writeFileSync(join(f.root, untrackedPath), 'new\n');
    const changes = readChanges(f.root);
    assert.deepEqual(changes.files.map((entry) => entry.area).sort(), ['staged', 'unstaged', 'untracked']);
    assert.match(readFileDiff(f.root, changes.scope, changes.files.find((file) => file.area === 'staged')!), /\+staged/);
    const untracked = changes.files.find((file) => file.area === 'untracked')!;
    assert.equal(untracked.path, untrackedPath);
    assert.match(readFileDiff(f.root, changes.scope, untracked), /\+new/);
    f.git('add', '.'); f.git('commit', '-qm', 'second');
    f.git('mv', 'tracked.txt', 'renamed file.txt');
    const renamed = readChanges(f.root).files[0]!;
    assert.equal(renamed.previousPath, 'tracked.txt'); assert.equal(renamed.path, 'renamed file.txt');
    assert.ok(readChanges(f.root, { kind: 'commit', ref: 'HEAD' }).files.length);
    assert.equal(readChanges(f.root, { kind: 'base', ref: 'HEAD' }).files.length, 0, 'base scope is committed changes, not local edits');
  } finally { f.close(); }
});

test('write_file creation checkpoints absence and retains it through another write in the turn', async () => {
  const f = fixture();
  try {
    const ctx = { workspaceRoot: f.root, signal: new AbortController().signal, log: () => {}, dryRun: false, checkpoint: { sessionId: 'fixture', turn: 0 } };
    assert.equal((await writeFile.run({ path: 'created.txt', content: 'first' }, ctx)).ok, true);
    assert.equal((await writeFile.run({ path: 'created.txt', content: 'second' }, ctx)).ok, true);
    const entries = listCheckpointsForTurn(f.root, 'fixture', 0);
    assert.equal(entries.length, 1); assert.equal(entries[0]!.absent, true); assert.equal(existsSync(join(f.root, 'created.txt')), true);
  } finally { f.close(); }
});

test('scoped reviewer receives the selected commit diff even when the working file differs', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'tracked.txt'), 'committed value\n'); f.git('add', '.'); f.git('commit', '-qm', 'selected');
    writeFileSync(join(f.root, 'tracked.txt'), 'unrelated working value\n');
    const material = reviewMaterial(f.root, readChanges(f.root, { kind: 'commit', ref: 'HEAD' }));
    assert.match(material.text, /\+committed value/); assert.doesNotMatch(material.text, /unrelated working value/);
    assert.equal(material.diffs.get('tracked.txt')?.includes('+committed value'), true);
  } finally { f.close(); }
});

test('Work Center persists precise partial outcome, artifacts and unverified state without interrupting plan rows', () => {
  const center = new WorkCenter(); const bus = new EventBus(); center.subscribe(bus);
  bus.emit({ type: 'subagent_start', taskId: 'a', subagentType: 'reviewer', profile: 'local', provider: 'openai', model: 'fixture' });
  bus.emit({ type: 'subagent_end', taskId: 'a', ok: false, status: 'partial', stopReason: 'max_iterations', answer: 'Partial findings', artifactIds: ['artifact-a'] });
  center.syncTodos([{ id: 't', subject: 'Continue work', status: 'pending' }]);
  const restored = new WorkCenter(); restored.restore(center.snapshot());
  assert.equal(restored.get('a')?.status, 'partial'); assert.equal(restored.get('a')?.finalOutput, 'Partial findings');
  assert.deepEqual(restored.get('a')?.artifactIds, ['artifact-a']); assert.equal(restored.get('a')?.verification, 'unverified');
  assert.equal(restored.get('a')?.profile, 'local'); assert.equal(restored.get('plan_t')?.status, 'queued');
  center.unsubscribe();
});

test('live work browser navigates controls, requires retry confirmation and fits small terminals', () => {
  const center = new WorkCenter(); const bus = new EventBus(); center.subscribe(bus);
  bus.emit({ type: 'subagent_start', taskId: 'a', subagentType: 'reviewer', background: true, description: 'Inspect the code' });
  bus.emit({ type: 'subagent_end', taskId: 'a', ok: false, status: 'failed' });
  bus.emit({ type: 'subagent_retryable', taskId: 'a' });
  const commands: string[] = [];
  const browser = new WorkBrowser({ items: () => center.list(), rows: () => 20, repaint: () => {}, close: () => {}, artifacts: () => {}, command: (command) => { commands.push(command); return 'scheduled'; } });
  browser.handleInput('1'); browser.handleInput('\r'); browser.handleInput('a'); browser.handleInput('\r');
  assert.equal(commands.length, 0); assert.match(browser.render(50).join('\n'), /retry|Retry/);
  browser.handleInput('\r'); assert.deepEqual(commands, ['retry a --confirm']);
  for (const width of [30, 60, 120]) assert.ok(browser.render(width).every((line) => visibleWidth(line) <= width));
  center.unsubscribe();
});

test('change browser opens a diff, navigates hunks, and returns without executing a review', () => {
  const changes = { title: 'Fixture', scope: { kind: 'working' as const }, files: [{ path: 'a.txt', area: 'unstaged' as const, status: 'M' }], summary: ['unstaged a.txt'] };
  let reviewed = false; let closed = false;
  const browser = new ChangeReview({ changes, diff: () => '@@ first @@\n+one\n@@ next @@\n+two', rows: () => 12, repaint: () => {}, close: () => { closed = true; }, review: () => { reviewed = true; } });
  browser.handleInput('\r'); browser.handleInput('n'); assert.match(browser.render(50).join('\n'), /next/);
  browser.handleInput('\x1b'); assert.equal(closed, false); assert.equal(reviewed, false);
  browser.handleInput('r'); assert.equal(reviewed, true);
});
