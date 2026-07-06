import { test } from 'node:test';
import assert from 'node:assert/strict';
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
