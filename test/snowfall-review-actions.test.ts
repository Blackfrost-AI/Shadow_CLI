import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangedFile, ReviewScope } from '../src/state/gitChanges.js';
import type { ReviewAction } from '../src/state/reviewActions.js';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { HeadlessTerminal } from './helpers/snowfallTerminal.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';
const isolated = isolateHome('review-actions-view');
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, isolated.home);
const { ShadowApp } = await import('../src/app/app.js');
const { loadConfig } = await import('../src/config.js');
const { Context } = await import('../src/agent/context.js');
const { EventBus } = await import('../src/agent/events.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { SessionLog } = await import('../src/state/session.js');
after(async () => { await removeFixtureTree(isolated.home); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shadow-review-view-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); writeFileSync(join(root, '.gitignore'), '.shadow/\n'); writeFileSync(join(root, 'a.txt'), 'original\n'); writeFileSync(join(root, 'other.txt'), 'unrelated\n'); git('add', '.'); git('commit', '-qm', 'initial');
  writeFileSync(join(root, 'a.txt'), 'agent change\n');
  const cfg = loadConfig(root, { provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off', instructionAutopilot: false });
  const context = new Context({ contextBudget: 32768, triggerRatio: .8, keepLastTurns: 4 });
  const log = SessionLog.open(root); const terminal = new HeadlessTerminal(120, 36); let providerCalls = 0;
  const app = new ShadowApp({ provider: { name: 'mock', estimateTokens: () => 1, async *send() { providerCalls++; yield { type: 'text', delta: 'unexpected' }; } }, cfg,
    bus: new EventBus(), registry: new ToolRegistry(), sessionLog: log, context, system: 'fixture', workspaceRoot: root,
    autonomy: 'manual', bypass: false, offline: true, version: 'test' }, terminal);
  const inspect = app as unknown as { openChanges(scope: ReviewScope): void; reviewAction(file: ChangedFile, action: ReviewAction, hunkIndex?: number): void; featureError(error: unknown): void; closePicker(): void; running: boolean; };
  const errors: string[] = []; const showError = inspect.featureError.bind(app);
  inspect.featureError = (error) => { errors.push(String(error)); showError(error); };
  const run = app.run(); await terminal.flush();
  return { root, git, app, inspect, terminal, errors, screen: () => terminal.lines().join('\n'), calls: () => providerCalls,
    close: async () => { inspect.running = false; app.stop(); await run; log.close(); terminal.screen.dispose(); await removeFixtureTree(root); } };
}
async function key(f: Awaited<ReturnType<typeof fixture>>, data: string) { f.terminal.input(data); await f.terminal.flush(); }
async function startPreview(f: Awaited<ReturnType<typeof fixture>>, action: string) {
  f.inspect.openChanges({ kind: 'working' }); await f.terminal.flush();
  await key(f, action); assert.match(f.screen(), /Only the selected|backup will be retained|Stage|Restore/);
}
async function confirm(f: Awaited<ReturnType<typeof fixture>>) { await key(f, '\x1b'); await key(f, '\x1b[B'); await key(f, '\r'); }

test('review UI previews, defaults to cancel, and changes only the confirmed scoped action', async () => {
  const f = await fixture();
  try {
    await startPreview(f, 's'); assert.equal(f.git('diff', '--cached'), '');
    await key(f, '\r'); assert.equal(f.git('diff', '--cached'), '', 'Enter in the evidence viewer cannot execute');
    await key(f, '\x1b'); assert.match(f.screen(), /Cancel/); assert.match(f.screen(), /Apply stage/);
    await key(f, '\r'); assert.equal(f.git('diff', '--cached'), '', 'confirmation starts on Cancel');
    await startPreview(f, 's'); await confirm(f);
    assert.match(f.git('diff', '--cached'), /agent change/); assert.equal(f.errors.length, 0);
    await startPreview(f, 'u'); await confirm(f); assert.equal(f.git('diff', '--cached'), '');
    await startPreview(f, 'd'); assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'agent change\n');
    f.terminal.resize(62, 20); await f.terminal.flush(); await confirm(f);
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'original\n');
    const backups = readdirSync(join(f.root, '.shadow/review-backups')); assert.equal(backups.length, 1);
    const backup = JSON.parse(readFileSync(join(f.root, '.shadow/review-backups', backups[0]!), 'utf8'));
    assert.equal(Buffer.from(backup.contentBase64, 'base64').toString(), 'agent change\n');
    assert.equal(readFileSync(join(f.root, 'other.txt'), 'utf8'), 'unrelated\n');
    assert.equal(f.calls(), 0, 'native review actions do not request inference');
  } finally { await f.close(); }
});

test('review UI rejects edits or staged changes made while its confirmation is open', async () => {
  const f = await fixture();
  try {
    await startPreview(f, 'd'); writeFileSync(join(f.root, 'a.txt'), 'human edit after preview\n'); await confirm(f);
    assert.match(f.errors.at(-1)!, /changed since preview/); assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'human edit after preview\n');
    f.inspect.closePicker(); await startPreview(f, 's');
    writeFileSync(join(f.root, 'other.txt'), 'human staged change\n'); f.git('add', 'other.txt'); await confirm(f);
    assert.match(f.errors.at(-1)!, /changed since preview/);
    assert.match(f.git('diff', '--cached'), /human staged change/); assert.doesNotMatch(f.git('diff', '--cached'), /human edit after preview/);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test('review UI busy guards apply both before preview and after confirmation', async () => {
  const f = await fixture();
  try {
    f.inspect.running = true;
    f.inspect.reviewAction({ path: 'a.txt', status: 'M', area: 'unstaged' }, 'stage');
    assert.match(f.errors.at(-1)!, /Finish the current operation/); assert.equal(f.git('diff', '--cached'), '');
    f.inspect.running = false; await startPreview(f, 's');
    await key(f, '\x1b'); f.inspect.running = true; await key(f, '\x1b[B'); await key(f, '\r');
    assert.match(f.errors.at(-1)!, /Workspace became busy/); assert.equal(f.git('diff', '--cached'), '');
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'agent change\n'); assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});
