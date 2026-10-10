import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  assertHarnessReady,
  harnessesDir,
  resolveHarnessStack,
} from '../src/harness/index.js';
import { discoverSkills } from '../src/skills/loader.js';
import { resolveSystem } from '../src/system/resolveSystem.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { makeSkillTool } from '../src/tools/skillTool.js';
import { ok, type Tool } from '../src/tools/types.js';

function tool(name: string): Tool {
  return {
    name,
    description: `${name} integration fixture`,
    risk: 'read',
    inputSchema: z.object({}),
    async run() {
      return ok(name, 'read', 0, name);
    },
  };
}

test('a selected harness composes instructions, skills, and canonical tool policy for one session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-integration-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const packageDir = join(harnessesDir(home), 'incident-response');

  try {
    mkdirSync(join(packageDir, 'instructions'), { recursive: true });
    mkdirSync(join(packageDir, 'skills', 'incident-triage'), { recursive: true });
    mkdirSync(workspace, { recursive: true });

    writeFileSync(
      join(packageDir, 'harness.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'incident-response',
        version: '1.0.0',
        title: 'Incident Response',
        description: 'Evidence-preserving incident response workflow.',
        instructions: ['instructions/root.md'],
        tools: {
          // Foreign-harness spellings must become Shadow's canonical tool names.
          add: ['Read'],
          remove: ['Bash'],
        },
      }),
    );
    writeFileSync(
      join(packageDir, 'instructions', 'root.md'),
      'INCIDENT_RESPONSE_ROOT_MARKER\nPreserve evidence before remediation.\n',
    );
    writeFileSync(
      join(packageDir, 'skills', 'incident-triage', 'SKILL.md'),
      [
        '---',
        'description: Triage an incident while preserving evidence.',
        '---',
        '# Incident triage',
        'INCIDENT_TRIAGE_SKILL_MARKER',
      ].join('\n'),
    );

    const registry = new ToolRegistry();
    registry.register(tool('read_file'));
    registry.register(tool('run_shell'));

    const stack = resolveHarnessStack(['incident-response'], {
      homeDir: home,
      availableTools: { has: (name) => registry.getUnscoped(name) !== undefined },
    });

    assert.deepEqual(stack.selectedIds, ['incident-response']);
    assert.deepEqual(stack.tools.required, ['read_file']);
    assert.deepEqual(stack.tools.remove, ['run_shell', 'acceptance_check', 'bash_output', 'kill_shell']);
    assert.equal(stack.ready, true);
    assert.doesNotThrow(() => assertHarnessReady(stack));

    // A package can be replaced immediately after resolution. This session must still expose the
    // bytes represented by its recorded digest, never a later body reopened from disk.
    writeFileSync(
      join(packageDir, 'skills', 'incident-triage', 'SKILL.md'),
      '# Mutated after resolution\nMUTATED_SKILL_BODY_MUST_NOT_LEAK',
    );
    const skills = discoverSkills(workspace, {
      homedir: home,
      harnessSkills: stack.skills.map((skill) => ({
        name: skill.name,
        path: skill.absolutePath,
        root: skill.root,
        body: skill.body,
      })),
      pluginDirs: [],
    });
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, 'incident-triage');
    assert.equal(skills[0]?.source, 'harness');
    assert.match(skills[0]?.body ?? '', /INCIDENT_TRIAGE_SKILL_MARKER/);
    assert.doesNotMatch(skills[0]?.body ?? '', /MUTATED_SKILL_BODY_MUST_NOT_LEAK/);
    assert.equal(skills[0]?.description, 'Triage an incident while preserving evidence.');
    assert.equal(
      stack.skills[0]?.sha256,
      stack.addons[0]?.files.find((file) => file.path === 'skills/incident-triage/SKILL.md')?.sha256,
      'the captured skill is tied to the file inventory used by the package digest',
    );
    const skillResult = await makeSkillTool(skills).run(
      { name: 'incident-triage' },
      {
        workspaceRoot: workspace,
        signal: new AbortController().signal,
        log: () => {},
        dryRun: false,
      },
    );
    assert.equal(skillResult.ok, true);
    assert.match(skillResult.data?.body ?? '', /INCIDENT_TRIAGE_SKILL_MARKER/);
    assert.doesNotMatch(skillResult.data?.body ?? '', /MUTATED_SKILL_BODY_MUST_NOT_LEAK/);

    const prompt = resolveSystem(workspace, {
      installDir: join(root, 'missing-install'),
      homedir: home,
      harnessInstructions: stack.instructions
        .filter((instruction) => instruction.source === 'addon')
        .map((instruction) => instruction.text),
    });
    assert.match(prompt, /## Selected harness add-ons/);
    assert.match(prompt, /INCIDENT_RESPONSE_ROOT_MARKER/);
    assert.match(prompt, /do not change the selected model, endpoint, credentials, permissions, sandbox, or user authority/);

    registry.setDenied(stack.tools.remove);
    assert.equal(registry.get('read')?.name, 'read_file', 'required foreign alias resolves to the canonical tool');
    assert.equal(registry.get('bash'), undefined, 'removed foreign alias cannot recover a denied canonical tool');
    assert.equal(registry.get('run_shell'), undefined, 'removed canonical tool is absent from model dispatch');
    assert.equal(
      registry.getUnscoped('run_shell')?.name,
      'run_shell',
      'host wiring retains the compiled implementation after model-facing removal',
    );
    assert.deepEqual(registry.toSchemas().map((schema) => schema.name), ['read_file']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
