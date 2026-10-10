import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSkillCatalog, parseDescription } from '../src/skills/loader.js';
import { discoverProjectInstructions } from '../src/system/projectInstructions.js';
import { ProjectMemory } from '../src/state/memory.js';
import { makeSkillTool } from '../src/tools/skillTool.js';
import type { ToolContext } from '../src/tools/types.js';

function fixture(): { root: string; put: (p: string, value: string) => void } {
  const root = mkdtempSync(join(tmpdir(), 'shadow-context-'));
  return { root, put: (p, value) => { const path = join(root, p); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); } };
}

test('skill catalog orders workspace/global/plugin, reports shadows and rereads frontmatter', async () => {
  const f = fixture();
  try {
    f.put('workspace/skills/check/SKILL.md', '---\nname: ignored-alias\ndescription: >-\n  Run project\n  checks.\n---\n# Checks\nBody');
    f.put('home/.shadow/skills/check/SKILL.md', '# Global\nGlobal check');
    f.put('home/.shadow/skills/global/SKILL.md', '---\ndescription: "Shared: helper"\n---\nBody');
    f.put('plugin/check/SKILL.md', '# Plugin\nPlugin check');
    const load = () => discoverSkillCatalog(join(f.root, 'workspace'), { homedir: join(f.root, 'home'), pluginDirs: [join(f.root, 'plugin')] });
    assert.equal(load().skills.find((s) => s.name === 'check')?.description, 'Run project checks.');
    assert.equal(load().skills.find((s) => s.name === 'global')?.source, 'global');
    assert.equal(load().conflicts.length, 2);
    const tool = makeSkillTool(() => load().skills);
    f.put('workspace/skills/check/SKILL.md', '# Changed\nNew body');
    const ctx = { workspaceRoot: f.root } as ToolContext;
    assert.match((await tool.run({ name: 'check' }, ctx)).data!.body, /New body/);
    rmSync(join(f.root, 'workspace/skills/check'), { recursive: true });
    assert.equal((await tool.run({ name: 'check' }, ctx)).data!.source, 'global');
    assert.equal(parseDescription("---\ndescription: 'it''s useful'\n---\nbody"), "it's useful");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a selected trusted harness skill cannot be shadowed by a workspace skill of the same name', () => {
  const f = fixture();
  try {
    f.put('workspace/skills/incident-response-workflow/SKILL.md', '# Workspace replacement\nUntrusted body');
    f.put('harness/incident-response-workflow/SKILL.md', '# Incident response workflow\nTrusted harness body');
    const catalog = discoverSkillCatalog(join(f.root, 'workspace'), {
      homedir: join(f.root, 'home'),
      harnessSkills: [{
        name: 'incident-response-workflow',
        path: join(f.root, 'harness/incident-response-workflow/SKILL.md'),
        root: join(f.root, 'harness'),
        body: '# Incident response workflow\nTrusted harness body',
      }],
      pluginDirs: [],
    });
    const selected = catalog.skills.find((skill) => skill.name === 'incident-response-workflow');
    assert.equal(selected?.source, 'harness');
    assert.match(selected?.body ?? '', /Trusted harness body/);
    assert.ok(catalog.conflicts.some((conflict) => conflict.name === 'incident-response-workflow'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('instruction scope includes ancestors and targeted nested files with explicit order and fresh reads', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.git'));
    f.put('AGENTS.md', 'root conventions');
    f.put('package/CLAUDE.md', 'compat conventions');
    f.put('package/SHADOW.md', 'preferred conventions');
    f.put('package/src/AGENTS.md', 'nested conventions');
    f.put('package/src/main.ts', 'export {};');
    f.put('sibling/AGENTS.md', 'must not load');
    const catalog = discoverProjectInstructions(join(f.root, 'package'), { targetPath: 'src/main.ts' });
    assert.deepEqual(catalog.sources.map((s) => s.body), ['root conventions', 'compat conventions', 'preferred conventions', 'nested conventions']);
    assert.equal(catalog.overlaps.length, 1);
    f.put('package/src/AGENTS.md', 'changed conventions');
    assert.equal(discoverProjectInstructions(join(f.root, 'package'), { targetPath: 'src/main.ts' }).sources.at(-1)?.body, 'changed conventions');
    assert.throws(() => discoverProjectInstructions(join(f.root, 'package'), { targetPath: '../sibling/AGENTS.md' }), /outside/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('memory migrates unknown provenance, distinguishes user/generated edits and persists deletion', () => {
  const f = fixture();
  try {
    f.put('.shadow/memory.json', JSON.stringify({ build: 'npm run build' }));
    const mem = ProjectMemory.load(f.root);
    assert.equal(mem.inspect('build')?.author, 'legacy');
    mem.set('test', 'node --test', { author: 'user', source: 'user /memory set' });
    mem.update('build', 'make build', { author: 'generated', source: 'Makefile:4' });
    const reloaded = ProjectMemory.load(f.root);
    assert.equal(reloaded.inspect('test')?.author, 'user');
    assert.equal(reloaded.inspect('build')?.source, 'Makefile:4');
    assert.equal(reloaded.inspect('test')?.scope, 'workspace');
    mem.set('other', 'new model memory');
    reloaded.set('user', 'later user edit', { author: 'user' });
    mem.set('another', 'new model memory again');
    assert.equal(reloaded.get('other'), 'new model memory');
    assert.equal(mem.inspect('user')?.author, 'user');
    const entry = reloaded.inspect('test')!;
    entry.value = 'external mutation';
    assert.equal(reloaded.get('test'), 'node --test');
    assert.equal(reloaded.stale(new Date().toISOString()).length, 5);
    assert.equal(reloaded.update('missing', 'value'), false);
    assert.equal(reloaded.delete('build'), true);
    assert.equal(ProjectMemory.load(f.root).inspect('build'), undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
