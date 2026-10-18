/**
 * Runtime-context snapshot — the model must be told its own confinement, honestly.
 *
 * The failure mode this guards against is a prompt that claims a boundary the kernel is not
 * providing. That is worse than saying nothing: a model told "you are read-only" that then sees a
 * successful write reports containment it never had, and a model told "confinement is waived" stops
 * trying to stay inside a workspace that would have held it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runtimeContextBlock } from '../src/agent/runtimeContext.js';

test('states the mode and the workspace root', () => {
  const block = runtimeContextBlock({ workspaceRoot: '/ws/proj', sandboxMode: 'workspace-write' });
  assert.match(block, /^## Runtime context/);
  assert.match(block, /sandbox: workspace-write/);
  assert.match(block, /writes confined to the workspace/);
  assert.match(block, /workspace root: \/ws\/proj/);
});

test('read-only says the workspace is not writable', () => {
  const block = runtimeContextBlock({ workspaceRoot: '/ws', sandboxMode: 'read-only' });
  assert.match(block, /no writes anywhere/);
});

test('danger-full-access is described as an explicit waiver, not as confinement', () => {
  const block = runtimeContextBlock({ workspaceRoot: '/ws', sandboxMode: 'danger-full-access' });
  assert.match(block, /no filesystem confinement/);
  assert.match(block, /waiver/);
});

test('enforced confinement makes no warning claim', () => {
  const block = runtimeContextBlock({
    workspaceRoot: '/ws',
    sandboxMode: 'workspace-write',
    confinementEnforced: true,
  });
  assert.doesNotMatch(block, /WARNING/);
  assert.doesNotMatch(block, /NOT enforced/);
});

test('requested-but-unenforced confinement WARNS instead of claiming a boundary', () => {
  // The dangerous case: the policy says workspace-write, the host has no backend.
  const block = runtimeContextBlock({
    workspaceRoot: '/ws',
    sandboxMode: 'workspace-write',
    confinementEnforced: false,
  });
  assert.match(block, /WARNING/);
  assert.match(block, /NOT enforced/);
  assert.match(block, /unconfined/);
});

test('an explicit waiver is reported as deliberate, not as a failure', () => {
  const block = runtimeContextBlock({
    workspaceRoot: '/ws',
    sandboxMode: 'workspace-write',
    confinementEnforced: undefined,
  });
  assert.match(block, /explicitly waived/);
  assert.doesNotMatch(block, /WARNING/);
});

test('additional roots and offline mode are stated when present', () => {
  const block = runtimeContextBlock({
    workspaceRoot: '/ws',
    sandboxMode: 'workspace-write',
    additionalRoots: ['/data', '/models'],
    offline: true,
    sessionName: 'ransomware-triage',
  });
  assert.match(block, /also granted: \/data, \/models/);
  assert.match(block, /offline/);
  assert.match(block, /session: ransomware-triage/);
});

test('absent optional facts are omitted rather than rendered empty', () => {
  const block = runtimeContextBlock({ workspaceRoot: '/ws', sandboxMode: 'workspace-write' });
  assert.doesNotMatch(block, /also granted/);
  assert.doesNotMatch(block, /offline/);
  assert.doesNotMatch(block, /session:/);
});

test('the block stays small — it rides in every request', () => {
  const block = runtimeContextBlock({ workspaceRoot: '/ws', sandboxMode: 'workspace-write' });
  // Generous ceiling: a few lines. This is a regression guard against scope creep, not an exact
  // token budget.
  assert.ok(block.length < 500, `runtime context must stay compact, got ${block.length} chars`);
});