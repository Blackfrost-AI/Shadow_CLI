import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SkillCandidateStore } from '../src/skills/candidateStore.js';
import { makeSkillManageTool } from '../src/tools/skillManage.js';

const ctx = {
  workspaceRoot: '/',
  additionalRoots: [],
  signal: new AbortController().signal,
  dryRun: false,
  log: () => {},
};

test('skill_manage drafts candidates but exposes no activation action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-skill-manage-'));
  const store = new SkillCandidateStore({ skillsRoot: join(root, 'skills') });
  const tool = makeSkillManageTool(store);
  assert.equal(tool.inputSchema.safeParse({ action: 'activate' }).success, false);

  const result = await tool.run({
    action: 'draft',
    name: 'local-workflow',
    rationale: 'Captured from a local workflow for later validation.',
    skillMarkdown: '---\nname: local-workflow\ndescription: Repeat the locally observed workflow.\n---\n\n# Local workflow\n\nValidate before use.\n',
  }, ctx);
  assert.equal(result.ok, true);
  assert.equal(store.inspectCandidate('local-workflow').status, 'draft');
  assert.equal(store.readActiveSkill('local-workflow'), null);
});
