import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentDef, loadAgentDefs } from '../src/agent/defs.js';

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