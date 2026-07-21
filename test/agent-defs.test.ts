import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome } from './helpers/isolateHome.js';
import {
  resolveAgentDef,
  loadAgentDefs,
  saveAgentDef,
  deleteAgentDef,
  serializeAgentDef,
  isValidAgentName,
  isValidToolName,
} from '../src/agent/defs.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-agents-'));
}

test('built-in explore agent resolves with read-only tools', () => {
  const def = resolveAgentDef('explore', '/tmp');
  assert.ok(def);
  assert.equal(def!.name, 'explore');
  assert.deepEqual(def!.tools, ['read_file', 'grep', 'glob']);
  assert.match(def!.systemPrompt, /read-only|read the codebase/i);
});

test('workspace .shadow/agents/*.md overrides custom defs', () => {
  const root = tmp();
  try {
    const dir = join(root, '.shadow', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'reviewer.md'),
      `---
name: reviewer
description: Code review only
tools:
  - read_file
  - grep
maxIterations: 5
---

Review code carefully and report issues.`,
      'utf8',
    );
    const def = resolveAgentDef('reviewer', root);
    assert.ok(def);
    assert.equal(def!.name, 'reviewer');
    assert.equal(def!.maxIterations, 5);
    const names = loadAgentDefs(root).map((d) => d.name);
    assert.ok(names.includes('reviewer'));
    assert.ok(names.includes('explore'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('general-purpose returns null (no filter)', () => {
  assert.equal(resolveAgentDef('general-purpose', '/tmp'), null);
});

// ── write side (Phase C) ─────────────────────────────────────────────────────
// saveAgentDef / deleteAgentDef write to ~/.shadow/agents, so they need HOME isolation to
// avoid touching the operator's real agent files. Same discipline as the vault/config suites.

const home = isolateHome('agent-defs-write');

test('saveAgentDef round-trips through the loader', () => {
  const def = {
    name: 'security-auditor',
    description: 'Audits changes for security issues',
    tools: ['read_file', 'grep', 'glob'],
    model: 'claude-opus-4-8',
    maxIterations: 15,
    systemPrompt: 'You audit code for security issues. Be thorough.',
  };
  saveAgentDef(def);
  // The file exists, mode 0600, in ~/.shadow/agents.
  const path = join(home.shadowDir, 'agents', 'security-auditor.md');
  assert.ok(existsSync(path), 'agent file was written');
  const raw = readFileSync(path, 'utf8');
  assert.match(raw, /^---\nname: security-auditor/);
  assert.match(raw, /maxIterations: 15/);
  assert.match(raw, /^  - read_file$/m);
  // And it reloads with every field preserved.
  const loaded = loadAgentDefs(home.home).find((d) => d.name === 'security-auditor');
  assert.ok(loaded, 'saved agent appears in loadAgentDefs');
  assert.deepEqual(loaded!.tools, ['read_file', 'grep', 'glob']);
  assert.equal(loaded!.maxIterations, 15);
  assert.equal(loaded!.model, 'claude-opus-4-8');
});

test('saveAgentDef refuses built-in names', () => {
  assert.throws(
    () => saveAgentDef({ name: 'explore', description: 'x', tools: ['read_file'], systemPrompt: 'y' }),
    /built-in/i,
  );
  assert.throws(
    () => saveAgentDef({ name: 'reviewer', description: 'x', tools: ['read_file'], systemPrompt: 'y' }),
    /built-in/i,
  );
});

test('saveAgentDef rejects invalid names and tools', () => {
  assert.throws(
    () => saveAgentDef({ name: 'Bad Name', description: 'x', tools: ['read_file'], systemPrompt: 'y' }),
    /invalid agent name/i,
  );
  assert.throws(
    () => saveAgentDef({ name: 'ok', description: '', tools: ['read_file'], systemPrompt: 'y' }),
    /description/i,
  );
  assert.throws(
    () => saveAgentDef({ name: 'ok2', description: 'x', tools: ['BadToolName'], systemPrompt: 'y' }),
    /tools/i,
  );
});

test('deleteAgentDef removes the file and refuses builtins', () => {
  saveAgentDef({ name: 'temp-agent', description: 'x', tools: ['read_file'], systemPrompt: 'y' });
  const removed = deleteAgentDef('temp-agent');
  assert.equal(removed, true);
  assert.equal(existsSync(join(home.shadowDir, 'agents', 'temp-agent.md')), false);
  // Deleting again is a no-op (returns false), not an error.
  assert.equal(deleteAgentDef('temp-agent'), false);
  // Built-ins are never deletable.
  assert.throws(() => deleteAgentDef('explore'), /built-in/i);
});

test('serializeAgentDef produces frontmatter the parser reads back', () => {
  const md = serializeAgentDef({
    name: 'round-trip',
    description: 'desc',
    tools: ['read_file', 'grep'],
    systemPrompt: 'Do the thing.',
  });
  assert.match(md, /^---\n/);
  assert.match(md, /---\n\nDo the thing\.\n$/);
  assert.match(md, /^tools:\n  - read_file\n  - grep$/m);
});

test('isValidAgentName / isValidToolName', () => {
  assert.equal(isValidAgentName('explore'), true);
  assert.equal(isValidAgentName('security-auditor'), true);
  assert.equal(isValidAgentName('Bad Name'), false);
  assert.equal(isValidAgentName('UPPER'), false);
  assert.equal(isValidAgentName(''), false);
  assert.equal(isValidToolName('read_file'), true);
  assert.equal(isValidToolName('grep'), true);
  assert.equal(isValidToolName('1bad'), false);
  assert.equal(isValidToolName('has-dash'), false);
});