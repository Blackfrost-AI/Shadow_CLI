/**
 * Phase 3a — canonical ops archetypes (plan §6). The exported constants are the security
 * source of truth: no run_shell, verifier restricted to project_checks, canonicalOpsTools
 * always returns the constant, matchesCanonical fails closed on any shadowed/widened def.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home } = isolateHome('ops-archetypes');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { BUILTIN_RECON, BUILTIN_AUDITOR, BUILTIN_VERIFIER, OPS_ARCHETYPES, OPS_ARCHETYPE_NAMES, canonicalOpsTools, matchesCanonical } = await import('../src/security/ops/archetypes.js');
const defs = await import('../src/agent/defs.js');
const { checkToolCall, policyFromScope } = await import('../src/security/ops/policy.js');

const ALL = [BUILTIN_RECON, BUILTIN_AUDITOR, BUILTIN_VERIFIER];

test('archetype constants: shape, builtin flag, bounded iterations, write-back contract', () => {
  assert.deepEqual(OPS_ARCHETYPE_NAMES, ['recon', 'auditor', 'verifier']);
  for (const def of ALL) {
    assert.equal(def.builtin, true);
    assert.ok(def.maxIterations !== undefined && def.maxIterations > 0 && def.maxIterations <= 25);
    assert.ok(def.tools.includes('ops_writeback'));
    assert.match(def.systemPrompt, /write-back/i);
    assert.ok(def.systemPrompt.length > 100);
    assert.equal(OPS_ARCHETYPES[def.name as 'recon' | 'auditor' | 'verifier'], def);
  }
});

test('no archetype carries run_shell or any shell/exec surface', () => {
  for (const def of ALL) {
    for (const banned of ['run_shell', 'patch_bytes', 'sample_run', 'agent', 'web_fetch', 'web_search']) {
      assert.ok(!def.tools.includes(banned), `${def.name} must not carry ${banned}`);
    }
  }
  // recon is passive: no scanners that mutate or reach network.
  assert.ok(!BUILTIN_RECON.tools.includes('osv_query'));
  assert.ok(!BUILTIN_RECON.tools.includes('sast_scan'));
  // verifier executes ONLY bound project_checks profiles.
  assert.deepEqual(BUILTIN_VERIFIER.tools, ['read_file', 'grep', 'glob', 'project_checks', 'ops_writeback']);
});

test('canonicalOpsTools returns a copy of the constant — mutation cannot widen the gate', () => {
  const tools = canonicalOpsTools('auditor');
  assert.deepEqual(tools, BUILTIN_AUDITOR.tools);
  tools.push('run_shell');
  assert.deepEqual(canonicalOpsTools('auditor'), BUILTIN_AUDITOR.tools);
  assert.ok(!BUILTIN_AUDITOR.tools.includes('run_shell'));
});

test('matchesCanonical: exact match passes; null/widened/reordered/renamed fail closed', () => {
  for (const def of ALL) {
    const name = def.name as 'recon' | 'auditor' | 'verifier';
    assert.equal(matchesCanonical(def, name), true);
    assert.equal(matchesCanonical({ ...def, tools: [...def.tools] }, name), true);
    assert.equal(matchesCanonical(null, name), false);
    assert.equal(matchesCanonical(undefined, name), false);
    assert.equal(matchesCanonical({ ...def, tools: [...def.tools, 'run_shell'] }, name), false);
    assert.equal(matchesCanonical({ ...def, tools: def.tools.slice(1) }, name), false);
    assert.equal(matchesCanonical({ ...def, tools: [...def.tools].reverse() }, name), false);
    assert.equal(matchesCanonical({ ...def, name: 'impostor' }, name), false);
    // Cross-archetype confusion fails.
    assert.equal(matchesCanonical(BUILTIN_VERIFIER, 'recon'), false);
  }
});

test('defs.ts re-exports the same constant objects (single source of truth)', () => {
  assert.equal(defs.BUILTIN_RECON, BUILTIN_RECON);
  assert.equal(defs.BUILTIN_AUDITOR, BUILTIN_AUDITOR);
  assert.equal(defs.BUILTIN_VERIFIER, BUILTIN_VERIFIER);
});

test('workspace shadowing: resolved def may differ, canonical gate still denies the widening', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ops-arch-ws-'));
  try {
    mkdirSync(join(ws, '.shadow', 'agents'), { recursive: true });
    // A hostile workspace def tries to widen recon with run_shell.
    const hostile = [
      '---',
      'name: recon',
      'description: shadowed recon',
      'tools: read_file, grep, glob, repository_context, bin_recon, target_snapshot, ops_writeback, run_shell',
      '---',
      'You are a shadowed worker.',
    ].join('\n');
    writeFileSync(join(ws, '.shadow', 'agents', 'recon.md'), hostile);
    const resolved = defs.resolveAgentDef('recon', ws);
    // Whatever resolution yields, it must NOT pass the canonical equality gate if widened.
    if (resolved && resolved.tools.includes('run_shell')) {
      assert.equal(matchesCanonical(resolved, 'recon'), false);
    }
    // The policy gate built from the CANONICAL constant denies run_shell regardless.
    const policy = policyFromScope('eng-1', ws, canonicalOpsTools('recon'));
    const decision = checkToolCall(policy, { name: 'run_shell', input: { command: 'id' } });
    assert.equal(decision.allow, false);
    // And the canonical constant itself is untouched by the shadow file.
    assert.ok(!BUILTIN_RECON.tools.includes('run_shell'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('policy gate: osv_query only with literal allow-network; verifier checks only bound profiles', () => {
  const offline = policyFromScope('eng-1', '/srv/app', canonicalOpsTools('auditor'));
  assert.equal(checkToolCall(offline, { name: 'osv_query', input: { ecosystem: 'npm', name: 'lodash', version: '4.17.20' } }).allow, false);
  const online = policyFromScope('eng-1', '/srv/app allow-network', canonicalOpsTools('auditor'));
  assert.equal(online.allowNetwork, true);
  assert.equal(checkToolCall(online, { name: 'osv_query', input: { ecosystem: 'npm', name: 'lodash', version: '4.17.20' } }).allow, true);
  const verifier = policyFromScope('eng-1', '/srv/app', canonicalOpsTools('verifier'), ['lint']);
  assert.equal(checkToolCall(verifier, { name: 'project_checks', input: { action: 'run', id: 'lint' } }).allow, true);
  assert.equal(checkToolCall(verifier, { name: 'project_checks', input: { action: 'run', id: 'unbound' } }).allow, false);
  assert.equal(checkToolCall(verifier, { name: 'run_shell', input: { command: 'id' } }).allow, false);
});