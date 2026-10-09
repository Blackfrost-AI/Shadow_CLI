import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JobStore } from '../src/state/jobStore.js';
import { DatabaseSync } from 'node:sqlite';

const moduleUrl = pathToFileURL(resolve('src/state/jobStore.ts')).href;
function child(ws: string, script: string): Promise<{ code: number | null; output: string }> {
  return new Promise((done, reject) => {
    const processChild = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', `import {JobStore} from ${JSON.stringify(moduleUrl)};const store=new JobStore(process.argv[1]);${script}`, ws], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    processChild.stdout.on('data', (chunk) => { output += String(chunk); });
    processChild.stderr.on('data', (chunk) => { output += String(chunk); });
    processChild.on('error', reject); processChild.on('exit', (code) => done({ code, output }));
  });
}
test('SQLite transactions serialize competing claims and preserve concurrent messages', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-job-concurrent-')); const store = new JobStore(ws);
  try {
    store.createJob({ prompt: 'benign fixture' }, { id: 'one' });
    const script = `for(let i=0;i<20;i++)store.postMessage({room:'fixture',from:String(process.pid),body:'message '+i});try{store.claimAttempt('one');console.log('CLAIMED')}catch{console.log('BLOCKED')}store.close();`;
    const outputs = await Promise.all([child(ws, script), child(ws, script), child(ws, script)]);
    assert.ok(outputs.every((result) => result.code === 0), JSON.stringify(outputs));
    assert.equal(outputs.filter((result) => result.output.includes('CLAIMED')).length, 1);
    assert.equal(store.get('one')?.attempts.length, 1);
    assert.equal(store.readMessages('fixture', 'lead', { limit: 100 }).length, 60);
  } finally { store.close(); rmSync(ws, { recursive: true, force: true }); }
});

test('dead owner recovery never replays work; explicit retry links attempts and fences stale completion', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-job-crash-')); const store = new JobStore(ws);
  try {
    store.createJob({ prompt: 'fixture' }, { id: 'crash' });
    const output = await child(ws, `const attempt=store.claimAttempt('crash');store.attachArtifacts('crash',attempt.ownerToken,['retained-fixture']);console.log(attempt.ownerToken);process.exit(0);`);
    assert.equal(output.code, 0);
    const token = store.get('crash')!.attempts[0]!.ownerToken;
    assert.deepEqual(store.recoverOrphans(), ['crash']);
    assert.equal(store.get('crash')?.status, 'interrupted');
    assert.equal(store.get('crash')?.attempts.length, 1, 'recovery classifies; it never executes');
    assert.deepEqual(store.get('crash')?.attempts[0]?.artifactIds, ['retained-fixture'], 'crash recovery retains the pre-announced output reference');
    assert.throws(() => store.claimAttempt('crash'), /explicit retry/);
    store.prepareRetry('crash', 'continue after inspection');
    const retry = store.claimAttempt('crash');
    assert.equal(retry.number, 2); assert.equal(retry.retryOf, store.get('crash')!.attempts[0]!.id);
    assert.throws(() => store.finishAttempt('crash', token, { status: 'completed' }), /ownership changed/);
    assert.deepEqual(store.recoverOrphans(), [], 'a live owner is never stolen just because another app opened');
    store.finishAttempt('crash', retry.ownerToken, { status: 'cancelled' });
  } finally { store.close(); rmSync(ws, { recursive: true, force: true }); }
});

test('dependencies reject cycles and require accepted evidence before claiming work', () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-job-deps-')); const store = new JobStore(ws);
  try {
    store.createJob({ prompt: 'first' }, { id: 'first' });
    store.createJob({ prompt: 'dependent' }, { id: 'dependent', dependencies: ['first'] });
    assert.throws(() => store.setDependencies('first', ['dependent']), /cycle/);
    assert.deepEqual(store.get('first')!.dependencies, [], 'failed transaction rolls back the cycle');
    assert.throws(() => store.claimAttempt('dependent'), /blocked/);
    const attempt = store.claimAttempt('first'); store.finishAttempt('first', attempt.ownerToken, { status: 'completed' });
    assert.throws(() => store.claimAttempt('dependent'), /blocked/, 'completion alone does not pass acceptance');
    store.recordAcceptance('first', { status: 'passed', reasons: ['fixture verified'], checks: [], evaluatedAt: Date.now() });
    assert.equal(store.claimAttempt('dependent').status, 'running');
  } finally { store.close(); rmSync(ws, { recursive: true, force: true }); }
});

test('room recipients, replies and unread cursors persist; job inputs discard credential-shaped extras', () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-job-room-')); let store = new JobStore(ws);
  try {
    const first = store.postMessage({ room: 'review', from: 'lead', to: 'reviewer', body: 'inspect the fixture' });
    store.postMessage({ room: 'review', from: 'reviewer', to: 'lead', body: 'one finding', replyTo: first.id });
    assert.equal(store.readMessages('review', 'unrelated').length, 0);
    assert.equal(store.readMessages('review', 'lead').length, 2);
    store.markRead('review', 'lead', first.id);
    assert.throws(() => store.postMessage({ room: 'other', from: 'lead', body: 'bad reference', replyTo: first.id }), /same room/);
    const input = { prompt: 'fixture', profile: 'local-coder', apiKey: 'never-save-this', headers: { Authorization: 'never-save-this' } };
    store.createJob(input, { id: 'safe' });
    assert.doesNotMatch(JSON.stringify(store.get('safe')), /never-save-this|Authorization|apiKey/);
    store.close(); store = new JobStore(ws);
    assert.equal(store.readMessages('review', 'lead', { unread: true }).length, 1);
    assert.equal(store.profileMeasurements('general-purpose').recommendation, undefined);
  } finally { store.close(); rmSync(ws, { recursive: true, force: true }); }
});

test('schema version upgrades the initial layout and refuses a newer database without rewriting it', () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-job-version-'));
  try {
    const store = new JobStore(ws); const path = store.path; store.createJob({ prompt: 'preserve' }, { id: 'fixture' }); store.close();
    const db = new DatabaseSync(path);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    db.exec('PRAGMA user_version=0'); db.close();
    const migrated = new JobStore(ws); assert.equal(migrated.get('fixture')?.input.prompt, 'preserve'); migrated.close();
    const future = new DatabaseSync(path); future.exec('PRAGMA user_version=99'); future.close();
    assert.throws(() => new JobStore(ws), /newer schema 99/);
    const untouched = new DatabaseSync(path); assert.equal((untouched.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 99); untouched.close();
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('cross-process cancellation requests cascade and are observed by the next ownership heartbeat', () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-job-cancel-')); const store = new JobStore(ws); const other = new JobStore(ws);
  try {
    store.createJob({ prompt: 'parent' }, { id: 'parent' }); const parent = store.claimAttempt('parent');
    store.createJob({ prompt: 'child' }, { id: 'child', parentId: 'parent' }); const child = store.claimAttempt('child');
    store.createJob({ prompt: 'pending' }, { id: 'pending', parentId: 'child' });
    assert.deepEqual(new Set(other.requestCancel('parent')), new Set(['parent', 'child', 'pending']));
    assert.equal(store.heartbeat('parent', parent.ownerToken), true); assert.equal(store.heartbeat('child', child.ownerToken), true);
    assert.equal(store.get('pending')?.status, 'cancelled');
    assert.throws(() => store.claimAttempt('pending'), /explicit retry/);
  } finally { store.close(); other.close(); rmSync(ws, { recursive: true, force: true }); }
});

test('routing recommendations never combine mixed or unknown profile configuration versions', () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-job-routing-')); const store = new JobStore(ws);
  try {
    function record(profile: string, fingerprint: string | undefined, count: number): void {
      for (let i = 0; i < count; i++) {
        const job = store.createJob({ prompt: 'fixture', profile }, { category: 'review', fingerprint });
        const attempt = store.claimAttempt(job.id); store.finishAttempt(job.id, attempt.ownerToken, { status: 'completed' });
        store.recordAcceptance(job.id, { status: 'passed', checks: [], reasons: ['fixture'], evaluatedAt: Date.now() });
      }
    }
    record('a', 'version-one', 5); record('b', 'version-two', 5);
    assert.ok(store.profileMeasurements('review').recommendation);
    record('a', 'changed-endpoint-version', 1);
    assert.equal(store.profileMeasurements('review').recommendation, undefined);
    record('unknown', undefined, 8);
    const result = store.profileMeasurements('review');
    assert.equal(result.recommendation, undefined); assert.match(result.reason, /configuration versions/);
  } finally { store.close(); rmSync(ws, { recursive: true, force: true }); }
});
