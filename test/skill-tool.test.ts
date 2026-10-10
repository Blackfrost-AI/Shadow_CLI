import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSkillTool } from '../src/tools/skillTool.js';
import type { SkillEntry } from '../src/skills/loader.js';
import type { ToolContext } from '../src/tools/types.js';

const ctx: ToolContext = { workspaceRoot: '/tmp', signal: new AbortController().signal, log: () => {}, dryRun: false };

const skills: SkillEntry[] = [
  { name: 'deploy', path: '/x/deploy/SKILL.md', description: 'ship it', body: '# Deploy\nstep one\nstep two' },
];

test('skill tool returns the full body for a known skill', async () => {
  const tool = makeSkillTool(skills);
  const r = await tool.run({ name: 'deploy' }, ctx);
  assert.ok(r.ok);
  assert.equal(r.data?.body, '# Deploy\nstep one\nstep two');
  assert.match(r.summary, /step two/, 'the body is surfaced to the model');
});

test('skill tool fails clearly for an unknown skill and lists what exists', async () => {
  const tool = makeSkillTool(skills);
  const r = await tool.run({ name: 'nope' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.summary, /deploy/, 'lists available skills');
});

test('an array catalog keeps the session-start skill body after its source changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-fixed-skill-'));
  const path = join(root, 'fixed', 'SKILL.md');
  try {
    mkdirSync(join(root, 'fixed'), { recursive: true });
    writeFileSync(path, '# Captured\nSession-start body');
    const tool = makeSkillTool([
      { name: 'fixed', path, root, description: 'fixed session skill', body: '# Captured\nSession-start body' },
    ]);
    writeFileSync(path, '# Changed\nMust wait for a new session');
    const result = await tool.run({ name: 'fixed' }, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.data?.body, '# Captured\nSession-start body');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
