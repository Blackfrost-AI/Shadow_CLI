import test from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { IntentNode, Run } from '../src/security/ops/types.js';

const { home } = isolateHome('ops-policy');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { parseScope, policyFromScope, checkDispatch, checkToolCall, checkRunBinding, targetInScope } = await import('../src/security/ops/policy.js');

const RECON_TOOLS = ['read_file', 'grep', 'glob', 'bin_recon', 'ops_writeback', 'ops_enrich'];
const VERIFIER_TOOLS = ['read_file', 'grep', 'project_checks', 'security_findings', 'ops_writeback'];

function intent(over: Partial<IntentNode['payload']> = {}): IntentNode {
  return {
    id: 1, runId: 'run_x', kind: 'intent',
    payload: { prompt: 'map the auth surface', archetype: 'recon', targets: ['/srv/app'], ...over },
    state: 'open', priority: 0, origin: 'lead', ownerJob: null, claimedAt: null,
    createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', completedAt: null,
  };
}

function policy(scope = '/srv/app', tools = RECON_TOOLS, profiles: string[] = []) {
  return policyFromScope('eng-1', scope, tools, profiles);
}

test('scope parser: conservative tokens only; allow-network literal exact', () => {
  const p = parseScope('targets: /srv/app, 10.0.0.0/24; example.com 192.168.1.5 allow-network');
  assert.deepEqual(p.targets, ['/srv/app', '10.0.0.0/24', '192.168.1.5', 'example.com']);
  assert.equal(p.allowNetwork, true);
  // Prose, URLs, globs, relative paths ignored → empty scope denies target work.
  assert.deepEqual(parseScope('please audit the login flow at https://x.com/a ../escape *.ts').targets, []);
  assert.equal(parseScope('Allow-Network ALLOW-NETWORK allow-networking').allowNetwork, false);
  assert.equal(parseScope('allow-network').allowNetwork, true);
  assert.equal(parseScope('999.1.1.1 10.0.0.0/33').targets.length, 0);
});

test('target matching: path prefix, exact host/IP, CIDR containment; traversal denied', () => {
  const scope = ['/srv/app', '10.0.0.0/24', 'example.com'];
  assert.ok(targetInScope('/srv/app/login.ts', scope));
  assert.ok(targetInScope('/srv/app', scope));
  assert.ok(!targetInScope('/srv/application', scope), 'prefix must be a path boundary');
  assert.ok(!targetInScope('/srv/app/../etc/passwd', scope), 'traversal denied');
  assert.ok(!targetInScope('/etc/passwd', scope));
  assert.ok(targetInScope('10.0.0.77', scope));
  assert.ok(!targetInScope('10.0.1.77', scope));
  assert.ok(targetInScope('example.com', scope));
  assert.ok(!targetInScope('evil-example.com', scope));
  assert.ok(!targetInScope('', scope));
});

test('dispatch: allow in-scope recon; deny run_shell, off-list tools, out-of-scope, missing targets', () => {
  const p = policy();
  assert.deepEqual(checkDispatch(p, intent(), ['read_file', 'grep', 'ops_writeback']), { allow: true });
  assert.equal(checkDispatch(p, intent(), ['run_shell']).allow, false);
  assert.equal(checkDispatch(p, intent(), ['web_fetch']).allow, false);
  assert.equal(checkDispatch(p, intent({ targets: ['/etc'] }), ['bin_recon']).allow, false);
  assert.equal(checkDispatch(p, intent({ targets: [] }), ['bin_recon']).allow, false);
  assert.equal(checkDispatch(p, intent({ archetype: 'root' as never }), ['read_file']).allow, false);
  assert.equal(checkDispatch(p, intent({ prompt: '' }), ['read_file']).allow, false);
  assert.equal(checkDispatch(p, intent(), []).allow, false);
  // Non-target-touching plan needs no targets.
  assert.deepEqual(checkDispatch(p, intent({ targets: [] }), ['read_file', 'grep']), { allow: true });
});

test('dispatch: network tool needs literal allow-network; verifier needs bound profiles', () => {
  const noNet = policyFromScope('eng-1', '/srv/app', ['osv_query'], []);
  assert.equal(checkDispatch(noNet, intent(), ['osv_query']).allow, false);
  const withNet = policyFromScope('eng-1', '/srv/app allow-network', ['osv_query'], []);
  assert.equal(checkDispatch(withNet, intent(), ['osv_query']).allow, true);
  const vNoProfiles = policyFromScope('eng-1', '/srv/app', VERIFIER_TOOLS, []);
  assert.equal(checkDispatch(vNoProfiles, intent({ archetype: 'verifier' }), ['project_checks']).allow, false);
  const vBound = policyFromScope('eng-1', '/srv/app', VERIFIER_TOOLS, ['unit-tests']);
  assert.equal(checkDispatch(vBound, intent({ archetype: 'verifier' }), ['project_checks']).allow, true);
});

test('tool-call gate: default-deny matrix', () => {
  const p = policy();
  assert.deepEqual(checkToolCall(p, { name: 'read_file', input: { path: '/anywhere' } }), { allow: true });
  assert.equal(checkToolCall(p, { name: 'run_shell', input: {} }).allow, false);
  assert.equal(checkToolCall(p, { name: 'agent', input: {} }).allow, false, 'off-list tool denied');
  assert.equal(checkToolCall(p, { name: 'bin_recon', input: { path: '/etc/passwd' } }).allow, false);
  assert.deepEqual(checkToolCall(p, { name: 'bin_recon', input: { path: '/srv/app/bin' } }), { allow: true });
  assert.equal(checkToolCall(p, { name: 'bin_recon', input: {} }).allow, false, 'missing path denied');
  assert.equal(checkToolCall(p, { name: 'web_fetch', input: {} }).allow, false);
  assert.equal(checkToolCall(p, { name: '' as string, input: {} }).allow, false);
});

test('tool-call gate: project_checks run only for bound profile ids', () => {
  const p = policyFromScope('eng-1', '/srv/app', VERIFIER_TOOLS, ['unit-tests']);
  assert.deepEqual(checkToolCall(p, { name: 'project_checks', input: { action: 'run', id: 'unit-tests' } }), { allow: true });
  assert.equal(checkToolCall(p, { name: 'project_checks', input: { action: 'run', id: 'deploy' } }).allow, false);
  assert.equal(checkToolCall(p, { name: 'project_checks', input: { action: 'run' } }).allow, false);
  assert.deepEqual(checkToolCall(p, { name: 'project_checks', input: { action: 'list' } }), { allow: true });
});

test('fail-closed: malformed policy/input never throws, always denies', () => {
  assert.equal(checkDispatch(null as never, intent(), ['read_file']).allow, false);
  assert.equal(checkDispatch(policy(), null as never, ['read_file']).allow, false);
  assert.equal(checkToolCall(null as never, { name: 'read_file', input: {} }).allow, false);
  assert.equal(checkToolCall(policy(), null as never).allow, false);
  const hostile = intent();
  Object.defineProperty(hostile.payload, 'targets', { get() { throw new Error('boom'); } });
  const d = checkDispatch(policy(), hostile, ['bin_recon']);
  assert.equal(d.allow, false);
  assert.ok(!d.allow && d.reason.includes('boom'));
});

test('run binding: active + same engagement only', () => {
  const p = policy();
  const run: Run = { id: 'run_x', engagementId: 'eng-1', objective: 'o', status: 'active', createdAt: '2026-11-18T00:00:00Z' };
  assert.deepEqual(checkRunBinding(p, run), { allow: true });
  assert.equal(checkRunBinding(p, undefined).allow, false);
  assert.equal(checkRunBinding(p, { ...run, status: 'paused' }).allow, false);
  assert.equal(checkRunBinding(p, { ...run, engagementId: 'other' }).allow, false);
});