import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../src/agent/context.js';
import { SessionLog } from '../src/state/session.js';
import { deriveSessionTitle, normalizeSessionTitle, sessionTerminalTitle } from '../src/state/sessionTitle.js';
import { listResumableSessions, resumeSession, trustLegacySession } from '../src/state/resume.js';
import { forkSession } from '../src/state/fork.js';
import { serializeContext } from '../src/state/snapshot.js';
import { registerSecret } from '../src/util/redact.js';

const policy = { contextBudget: 10000, triggerRatio: 0.8, keepLastTurns: 4 };
const previousSessionDir = process.env.SHADOW_SESSION_DIR;
delete process.env.SHADOW_SESSION_DIR;
after(() => {
  if (previousSessionDir === undefined) delete process.env.SHADOW_SESSION_DIR;
  else process.env.SHADOW_SESSION_DIR = previousSessionDir;
});
function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'shadow-session-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function context(text: string): Context {
  const ctx = new Context(policy);
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text }] });
  return ctx;
}

test('session names are short, readable, Unicode-aware and redacted before display', () => {
  assert.equal(deriveSessionTitle('Can you fix the login redirect?\nDetails follow.'), 'Fix the login redirect');
  assert.equal(deriveSessionTitle('## Review **the release**.'), 'Review the release');
  assert.equal(deriveSessionTitle('改善日本語の検索'), '改善日本語の検索');
  assert.equal(normalizeSessionTitle('  Website\n\tlaunch  '), 'Website launch');
  assert.ok(Array.from(normalizeSessionTitle('😀'.repeat(100))).length <= 72);
  assert.equal(sessionTerminalTitle('Website launch'), 'Website launch — Shadow');
  assert.equal(sessionTerminalTitle(''), 'New session — Shadow');
  registerSecret('fixture-secret-session-names');
  assert.equal(deriveSessionTitle('Review fixture-secret-session-names'), 'Review [REDACTED]');
  assert.equal(normalizeSessionTitle('Name\u0007\u202e here'), 'Name here');
});

test('automatic names and explicit renames survive snapshots, reload, resume and independent forks', (t) => {
  const root = workspace(t);
  const log = SessionLog.open(root);
  const ctx = context('Please fix the login redirect');
  log.record({ kind: 'user', task: 'Please fix the login redirect' });
  log.recordSnapshot(ctx, 0);
  assert.equal(log.title, 'Fix the login redirect');
  log.record({ kind: 'user', task: 'Now update the tests' });
  assert.equal(log.title, 'Fix the login redirect', 'follow-ups do not keep changing the tab');
  assert.ok(log.setTitle('Website launch'));
  log.recordSnapshot(ctx, 1);
  log.record({ kind: 'event', type: 'assistant_done', text: 'Completed a normal tool output line.\n'.repeat(10000) });
  assert.ok(log.setTitle('Release checklist'), 'a rename after the last snapshot is persisted');
  log.close();

  const child = execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e',
    "import {SessionLog} from './src/state/session.ts'; console.log(SessionLog.titleFor(process.argv[1]));", log.path],
  { cwd: process.cwd(), encoding: 'utf8' }).trim();
  assert.equal(child, 'Release checklist', 'a new process recovers the newest rename');
  assert.equal(listResumableSessions(root)[0]!.title, 'Release checklist');
  const bindingsDir = join(root, 'owner-bindings');
  trustLegacySession(log.path, { bindingsDir });
  assert.equal(resumeSession(log.path, { ...policy, bindingsDir }).meta.title, 'Release checklist');
  assert.equal(SessionLog.countSnapshots(log.path), 2, 'naming does not alter turn offsets');

  const before = readFileSync(log.path);
  const fork = forkSession(log, root).log;
  assert.equal(fork.title, 'Release checklist');
  assert.ok(fork.setTitle('Follow-up release'));
  fork.recordSnapshot(ctx, 2);
  assert.equal(SessionLog.titleFor(fork.path), 'Follow-up release');
  assert.deepEqual(readFileSync(log.path), before, 'renaming a fork leaves its source untouched');
  fork.close();
});

test('older sessions get names from their first prompt without rewriting the log', (t) => {
  const root = workspace(t);
  const log = SessionLog.open(root);
  const ctx = context('Please organize the photo archive.');
  const raw = JSON.stringify({ kind: 'user', task: 'Please organize the photo archive.' }) + '\n'
    + JSON.stringify({ kind: 'context_snapshot', ts: '2026-10-05T08:00:00Z', turn: 0, data: serializeContext(ctx) }) + '\n';
  writeFileSync(log.path, raw);
  assert.equal(listResumableSessions(root)[0]!.title, 'Organize the photo archive');
  assert.equal(readFileSync(log.path, 'utf8'), raw);
});

test('a name chosen before the first message remains the name of the session', (t) => {
  const root = workspace(t);
  const log = SessionLog.open(root);
  assert.ok(log.setTitle('My website'));
  log.record({ kind: 'user', task: 'Fix the header' });
  log.recordSnapshot(context('Fix the header'), 0);
  assert.equal(log.title, 'My website');
  assert.equal(listResumableSessions(root)[0]!.title, 'My website');
  log.close();
});
