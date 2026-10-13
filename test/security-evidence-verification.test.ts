import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EvidenceStore, currentFindingRetest } from '../src/security/evidence.js';
import { ProjectCheckStore } from '../src/checks/store.js';
import { checksForRegistry } from '../src/checks/registry.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { makeSecurityFindingsTool } from '../src/tools/securityFindings.js';
import { ok, type ToolContext } from '../src/tools/types.js';
import { removeFixtureTree } from './helpers/removeFixtureTree.js';

test('finding verification rejects persisted counterfeit/historical results and invalidated live checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-finding-current-'));
  const evidence = new EvidenceStore(root); const checks = new ProjectCheckStore(root);
  const ctx: ToolContext = { workspaceRoot: root, signal: new AbortController().signal, dryRun: false, log: () => {} };
  try {
    checks.saveProfiles({ version: 1, profiles: [{ id: 'test', title: 'Fixture', command: 'fixture-command' }] });
    const id = evidence.importFindings([{ title: 'Recorded issue' } as never]).ids[0]!;
    const profile = checks.resolve('test');
    const recorded = checks.record(profile, ok('run_shell', 'exec', 1, 'Passed', { exitCode: 0, stdout: 'fixture', stderr: '' }));
    const forgedId = randomUUID();
    writeFileSync(join(root, `.shadow/check-results/${forgedId}.json`), JSON.stringify({ ...recorded, id: forgedId }));
    assert.equal(new ProjectCheckStore(root).getRun(forgedId)?.status, 'passed', 'forgery is schema-valid historical data');
    const tool = makeSecurityFindingsTool(() => checks);
    const forged = await tool.run({ action: 'retest', id, checkId: forgedId }, ctx);
    assert.equal(forged.ok, false); assert.match(forged.summary, /historical or imported/); assert.equal(evidence.get(id).status, 'open');
    const historyOnly = await makeSecurityFindingsTool(() => new ProjectCheckStore(root)).run({ action: 'retest', id, checkId: recorded.id }, ctx);
    assert.equal(historyOnly.ok, false, 'even genuine old records require an execution in the live session');
    checks.invalidate();
    assert.throws(() => currentFindingRetest(checks, recorded.id), /current check executed/);
    const fresh = checks.record(profile, ok('run_shell', 'exec', 1, 'Passed', { exitCode: 0, stdout: '', stderr: '' }));
    const retested = await tool.run({ action: 'retest', id, checkId: fresh.id }, ctx);
    assert.equal(retested.ok, true, retested.summary); assert.equal(evidence.get(id).status, 'verified');
    checks.saveProfiles({ version: 1, profiles: [{ id: 'test', title: 'Changed', command: 'different-command' }] });
    assert.throws(() => currentFindingRetest(checks, fresh.id), /current check executed/, 'profile edits invalidate prior passing evidence');
    const bytes = readFileSync(join(root, `.shadow/check-results/${forgedId}.json`), 'utf8');
    assert.equal(JSON.parse(bytes).status, 'passed', 'historical files are never rewritten to enforce the rule');
  } finally { evidence.close(); await removeFixtureTree(root); }
});

test('a finding retest cannot cross workspace scope; cancelled evidence tools do not create stores', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-finding-scope-')); const other = join(root, 'other'); mkdirSync(other);
  const store = new EvidenceStore(root);
  try {
    const id = store.importFindings([{ title: 'Issue' } as never]).ids[0]!;
    assert.throws(() => store.retest(id, { id: 'run', passed: true, command: 'check', recordedAt: Date.now(), scope: other }), /this finding workspace/);
    const controller = new AbortController(); controller.abort();
    const result = await makeSecurityFindingsTool().run({ action: 'list' }, { workspaceRoot: other, signal: controller.signal, dryRun: false, log: () => {} });
    assert.equal(result.ok, false); assert.equal(existsSync(join(other, '.shadow')), false);
  } finally { store.close(); await removeFixtureTree(root); }
});

test('check registry canonicalizes aliases while preserving independent worktree selections', async () => {
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'shadow-check-registry-')); const alias = `${root}-alias`;
  const worktree = join(root, 'worktree'); mkdirSync(worktree); symlinkSync(root, alias);
  try {
    const registry = new ToolRegistry();
    const primary = checksForRegistry(registry, root);
    assert.equal(checksForRegistry(registry, alias), primary);
    assert.notEqual(checksForRegistry(registry, worktree), primary);
    assert.notEqual(checksForRegistry(new ToolRegistry(), root), primary, 'registries keep independent sessions');
  } finally { await removeFixtureTree(alias); await removeFixtureTree(root); }
});
