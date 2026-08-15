// P3-07 — plugin manager (local-first): install/enable/remove lifecycle, copy semantics,
// manifest validation (fail-closed on executable surfaces), and the loader precedence contract
// (workspace < enabled plugins < the user's own ~ files). HOME is isolated BEFORE importing the
// manager so ~/.shadow/plugins resolves into a throwaway home.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome } from './helpers/isolateHome.js';

const { home, shadowDir } = isolateHome('plugins');

const {
  parseManifest, installPluginFromPath, installPluginFromArg, listPlugins, describePlugin,
  setPluginEnabled, removePlugin, enabledPluginDirs, pluginsDir, displaySafe, assertAllowedGitUrl,
} = await import('../src/plugins/manager.js');
const { discoverCustomCommands } = await import('../src/tui/customCommands.js');
const { discoverCustomStyles } = await import('../src/agent/outputStyles.js');
const { discoverSkills } = await import('../src/skills/loader.js');
const { loadAgentDefs } = await import('../src/agent/defs.js');

// Plugins derive ~/.shadow/plugins from homedir() at CALL time — prove it points at the test home.
assert.ok(pluginsDir().startsWith(shadowDir), 'plugins dir must live under the isolated home');

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `shadow-plug-${label}-`));
}

/** Build a complete plugin source dir with all five surfaces + noise that must NOT be copied. */
function makePluginSource(name: string, opts: { hooks?: boolean; unknownKey?: boolean } = {}): string {
  const dir = scratch(`src-${name}`);
  const manifest: Record<string, unknown> = {
    name,
    version: '1.0.0',
    description: `test plugin ${name}`,
  };
  if (opts.hooks) manifest.hooks = { pre_tool_use: [] };
  if (opts.unknownKey) manifest.flavor = 'surprise';
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\nSay hello to $ARGUMENTS.');
  mkdirSync(join(dir, 'output-styles'), { recursive: true });
  writeFileSync(join(dir, 'output-styles', 'pirate.md'), '---\nlabel: Pirate\n---\nTalk like a pirate.');
  mkdirSync(join(dir, 'skills', 'greet-skill'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'greet-skill', 'SKILL.md'), '# Greet skill\n\nGreets people warmly.');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(
    join(dir, 'agents', 'helper.md'),
    '---\nname: helper\ndescription: Plugin helper\ntools:\n  - read_file\n---\nYou are the plugin helper.',
  );
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'workflows', 'pack-flow.md'), '# Pack flow\n\n1. do the thing');
  // Noise: an executable-looking tree and dotfiles a data-only install must leave behind.
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'evil.js'), 'require("child_process").exec("id");');
  writeFileSync(join(dir, '.hidden'), 'dotfile');
  return dir;
}

// ── manifest validation ──────────────────────────────────────────────────────

test('parseManifest accepts a minimal valid manifest', () => {
  const m = parseManifest(JSON.stringify({ name: 'ok-pack', version: '0.1.0', description: 'fine' }));
  assert.equal(m.name, 'ok-pack');
  assert.equal(m.version, '0.1.0');
});

test('parseManifest REJECTS executable extension points (hooks/mcpServers/scripts) fail-closed', () => {
  for (const key of ['hooks', 'mcpServers', 'mcp', 'scripts', 'bin', 'postInstall']) {
    const raw = JSON.stringify({ name: 'x', version: '1', description: 'd', [key]: {} });
    assert.throws(() => parseManifest(raw), /DATA-only/, `${key} must be rejected`);
  }
});

test('parseManifest rejects unknown keys (strict) and malformed names', () => {
  assert.throws(
    () => parseManifest(JSON.stringify({ name: 'x', version: '1', description: 'd', flavor: 'nope' })),
    /invalid/,
  );
  assert.throws(() => parseManifest(JSON.stringify({ name: 'has space', version: '1', description: 'd' })), /invalid/);
  assert.throws(() => parseManifest(JSON.stringify({ version: '1', description: 'd' })), /invalid/);
  assert.throws(() => parseManifest('[1,2]'), /object/);
  assert.throws(() => parseManifest('{oops'), /JSON/);
});

test('install REJECTS a manifest declaring executable surfaces, leaving nothing behind', () => {
  for (const opts of [{ hooks: true }, { unknownKey: true }]) {
    const src = makePluginSource('pack-exec', opts);
    assert.throws(() => installPluginFromPath(src), /DATA-only|invalid/, JSON.stringify(opts));
    assert.ok(!existsSync(join(pluginsDir(), 'pack-exec')), 'rejected install must leave nothing');
  }
});

// ── install-from-path: copy semantics ────────────────────────────────────────

test('installPluginFromPath copies ONLY manifest + readme + the five content dirs, installed DISABLED', () => {
  const src = makePluginSource('pack-one');
  const info = installPluginFromPath(src);
  assert.equal(info.name, 'pack-one');
  assert.equal(info.meta.enabled, false, 'install must NOT auto-enable');
  assert.equal(info.meta.source.kind, 'path');

  const dir = info.dir;
  assert.ok(existsSync(join(dir, 'manifest.json')));
  assert.ok(existsSync(join(dir, 'README.md')));
  assert.ok(existsSync(join(dir, 'commands', 'hello.md')));
  assert.ok(existsSync(join(dir, 'output-styles', 'pirate.md')));
  assert.ok(existsSync(join(dir, 'skills', 'greet-skill', 'SKILL.md')));
  assert.ok(existsSync(join(dir, 'agents', 'helper.md')));
  assert.ok(existsSync(join(dir, 'workflows', 'pack-flow.md')));
  // The noise never crosses the install boundary.
  assert.ok(!existsSync(join(dir, 'src')), 'arbitrary dirs must not be copied');
  assert.ok(!existsSync(join(dir, '.hidden')), 'dotfiles must not be copied');
  assert.deepEqual(info.counts, { commands: 1, 'output-styles': 1, skills: 1, agents: 1, workflows: 1 });
});

test('install refuses a symlinked manifest and skips symlinks inside content dirs', () => {
  const secret = scratch('secret');
  writeFileSync(join(secret, 'id_ed25519'), 'TOP SECRET KEY MATERIAL');

  const src = makePluginSource('pack-sym');
  symlinkSync(join(secret, 'id_ed25519'), join(src, 'commands', 'leak.md'));
  const info = installPluginFromPath(src);
  assert.ok(!existsSync(join(info.dir, 'commands', 'leak.md')), 'symlinked .md must be skipped');
  assert.equal(info.counts.commands, 1, 'only the real command counts');

  const src2 = makePluginSource('pack-sym2');
  rmSync(join(src2, 'manifest.json'));
  symlinkSync(join(secret, 'id_ed25519'), join(src2, 'manifest.json'));
  assert.throws(() => installPluginFromPath(src2), /symlink/);
});

test('a name collision refuses and tells you to remove first', () => {
  const src = makePluginSource('pack-dup');
  installPluginFromPath(src);
  const again = makePluginSource('pack-dup');
  assert.throws(() => installPluginFromPath(again), /already installed/);
});

test('the byte cap stops a disk-bomb and leaves NOTHING behind', () => {
  const src = makePluginSource('pack-bomb');
  writeFileSync(join(src, 'commands', 'big.md'), 'x'.repeat(9 * 1024 * 1024));
  assert.throws(() => installPluginFromPath(src), /cap/);
  assert.ok(!existsSync(join(pluginsDir(), 'pack-bomb')), 'failed install must clean up');
});

test('installPluginFromArg routes an existing directory to the path installer', () => {
  const src = makePluginSource('pack-arg');
  const info = installPluginFromArg(src);
  assert.equal(info.name, 'pack-arg');
  assert.equal(info.meta.source.kind, 'path');
});

test('data-only is literal: non-markdown files in content dirs are never copied or counted', () => {
  const src = makePluginSource('pack-mdonly');
  writeFileSync(join(src, 'commands', 'evil.sh'), '#!/bin/sh\nid'); // executable-looking, wrong ext
  writeFileSync(join(src, 'commands', 'notes.txt'), 'not markdown');
  writeFileSync(join(src, 'workflows', 'script.py'), 'import os');
  const info = installPluginFromPath(src);
  assert.ok(!existsSync(join(info.dir, 'commands', 'evil.sh')), '.sh must not cross the install boundary');
  assert.ok(!existsSync(join(info.dir, 'commands', 'notes.txt')), '.txt must not cross the install boundary');
  assert.ok(!existsSync(join(info.dir, 'workflows', 'script.py')), '.py must not cross the install boundary');
  assert.equal(info.counts.commands, 1, 'only the .md command counts');
  assert.equal(info.counts.workflows, 1, 'only the .md workflow counts');
});

// ── lifecycle ────────────────────────────────────────────────────────────────

test('enable/disable round-trip + enabledPluginDirs only surfaces ENABLED plugins', () => {
  const src = makePluginSource('pack-toggle');
  installPluginFromPath(src);
  assert.ok(!enabledPluginDirs('commands').some((d) => d.includes('pack-toggle')), 'disabled by default');

  const on = setPluginEnabled('pack-toggle', true);
  assert.equal(on.meta.enabled, true);
  assert.ok(enabledPluginDirs('commands').some((d) => d.includes('pack-toggle')));
  assert.ok(enabledPluginDirs('skills').some((d) => d.includes('pack-toggle')));

  const off = setPluginEnabled('pack-toggle', false);
  assert.equal(off.meta.enabled, false);
  assert.ok(!enabledPluginDirs('commands').some((d) => d.includes('pack-toggle')));

  assert.throws(() => setPluginEnabled('ghost', true), /not installed/);
});

test('listPlugins is name-sorted and skips broken dirs; describePlugin is null for them', () => {
  const before = listPlugins().map((p) => p.name);
  assert.deepEqual(before, [...before].sort((a, b) => a.localeCompare(b)));

  const broken = join(pluginsDir(), 'pack-broken');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'manifest.json'), '{not json');
  assert.equal(describePlugin('pack-broken'), null);
  assert.ok(!listPlugins().some((p) => p.name === 'pack-broken'));
});

test('removePlugin ARCHIVES (never deletes) and frees the name for re-add', () => {
  const src = makePluginSource('pack-rm');
  installPluginFromPath(src);
  const archive = removePlugin('pack-rm');
  assert.ok(archive.includes(join('.removed', '')), 'archive lives under .removed/');
  assert.ok(existsSync(join(archive, 'manifest.json')));
  assert.ok(!existsSync(join(pluginsDir(), 'pack-rm')));

  const again = makePluginSource('pack-rm');
  const info = installPluginFromPath(again);
  assert.equal(info.meta.enabled, false, 're-add installs disabled again');
});

test('displaySafe strips control chars and caps length', () => {
  // Build the hostile input with fromCharCode so no literal control byte sits in this source file.
  const bell = String.fromCharCode(7);
  const esc = String.fromCharCode(27);
  assert.equal(displaySafe(`a${bell}b`, 100), 'a b');
  assert.equal(displaySafe(`${esc}[31mred${esc}[0m`, 100), '[31mred [0m'); // each isolated run -> one space
  const capped = displaySafe('y'.repeat(50), 10);
  assert.equal(capped.length, 11); // 10 chars + ellipsis
  assert.ok(capped.endsWith('…'));
});

test('displaySafe strips bidi overrides + zero-width chars (visual URL spoofing)', () => {
  const rlo = String.fromCharCode(0x202e); // right-to-left override
  const zwsp = String.fromCharCode(0x200b); // zero-width space
  const isolate = String.fromCharCode(0x2066); // left-to-right isolate
  assert.equal(displaySafe(`https://exa${rlo}mple.com`, 100), 'https://exa mple.com');
  assert.equal(displaySafe(`git${zwsp}hub.com`, 100), 'git hub.com');
  assert.equal(displaySafe(`${isolate}host`, 100), 'host'); // stripped run collapses, then trims
});

test('lifecycle ops reject traversal/invalid names before touching the filesystem', () => {
  for (const name of ['../evil', '..', 'a/b', 'has space', '-flag', '']) {
    assert.throws(() => setPluginEnabled(name, true), /not installed/, `enable must refuse: ${name}`);
    assert.throws(() => removePlugin(name), /not installed/, `remove must refuse: ${name}`);
    assert.equal(describePlugin(name), null);
  }
});

test('a corrupt meta provenance block is treated as broken, not a crash', () => {
  const src = makePluginSource('pack-badmeta');
  installPluginFromPath(src);
  const metaFile = join(pluginsDir(), 'pack-badmeta', '.shadow-plugin-meta.json');
  // numeric commit + wrong shapes — previously reached `.slice()` in display surfaces
  writeFileSync(metaFile, JSON.stringify({ enabled: true, installedAt: 'x', source: { kind: 'git', url: 'u', commit: 123 } }));
  assert.equal(describePlugin('pack-badmeta'), null, 'malformed source shape reads as broken');
  assert.ok(!listPlugins().some((p) => p.name === 'pack-badmeta'));
});

// ── git URL allowlist ────────────────────────────────────────────────────────

test('assertAllowedGitUrl allows the four reasoned-about shapes and rejects every transport that executes or smuggles', () => {
  for (const ok of [
    'https://example.com/repo.git',
    'ssh://git@example.com/repo.git',
    'file:///tmp/repo',
    'git@example.com:org/repo.git',
  ]) {
    assert.doesNotThrow(() => assertAllowedGitUrl(ok), ok);
  }
  for (const bad of [
    'ext::sh -c touch% /tmp/pwned', // executes a command
    'http://example.com/repo.git', // unauthenticated transport
    'git://example.com/repo.git', // unauthenticated transport
    'ftp://example.com/repo',
    '-upload-pack=evil', // option injection
    '--upload-pack=evil',
    'https://example.com/ with space', // smuggling
    `https://exa${String.fromCharCode(7)}mple.com/`, // control char
    '', // empty
  ]) {
    assert.throws(() => assertAllowedGitUrl(bad), /./, `must reject: ${JSON.stringify(bad)}`);
  }
});

// ── loader precedence: workspace < enabled plugins < user's ~ ───────────────

test('custom commands: home beats plugin beats workspace; disabled plugins contribute nothing', () => {
  const ws = scratch('ws-cmd');
  mkdirSync(join(ws, '.shadow', 'commands'), { recursive: true });
  writeFileSync(join(ws, '.shadow', 'commands', 'shared.md'), 'WORKSPACE version');
  writeFileSync(join(ws, '.shadow', 'commands', 'ws-only.md'), 'workspace only');

  const src = makePluginSource('pack-cmds');
  writeFileSync(join(src, 'commands', 'shared.md'), 'PLUGIN version');
  writeFileSync(join(src, 'commands', 'plug-only.md'), 'plugin only');
  installPluginFromPath(src);

  // disabled: the plugin is invisible to discovery (home has no commands yet either)
  let cmds = discoverCustomCommands(ws, home);
  assert.ok(!cmds.some((c) => c.name === 'plug-only'));
  assert.equal(cmds.find((c) => c.name === 'shared')?.body, 'WORKSPACE version');

  mkdirSync(join(home, '.shadow', 'commands'), { recursive: true });
  writeFileSync(join(home, '.shadow', 'commands', 'shared.md'), 'HOME version');

  setPluginEnabled('pack-cmds', true);
  cmds = discoverCustomCommands(ws, home);
  assert.equal(cmds.find((c) => c.name === 'shared')?.body, 'HOME version', 'home beats plugin');
  assert.equal(cmds.find((c) => c.name === 'plug-only')?.body, 'plugin only');

  // remove the home override → the plugin now beats the workspace copy
  rmSync(join(home, '.shadow', 'commands', 'shared.md'));
  cmds = discoverCustomCommands(ws, home);
  assert.equal(cmds.find((c) => c.name === 'shared')?.body, 'PLUGIN version', 'plugin beats workspace');
  setPluginEnabled('pack-cmds', false);
});

test('output styles: plugin styles load when enabled; home wins the collision', () => {
  const ws = scratch('ws-style');
  const src = makePluginSource('pack-styles');
  writeFileSync(join(src, 'output-styles', 'pirate.md'), '---\nlabel: Plugin Pirate\n---\nPlugin sails.');
  installPluginFromPath(src);
  setPluginEnabled('pack-styles', true);

  let styles = discoverCustomStyles(ws, home);
  assert.equal(styles.find((s) => s.name === 'pirate')?.label, 'Plugin Pirate');

  mkdirSync(join(home, '.shadow', 'output-styles'), { recursive: true });
  writeFileSync(join(home, '.shadow', 'output-styles', 'pirate.md'), '---\nlabel: Home Pirate\n---\nHome sails.');
  styles = discoverCustomStyles(ws, home);
  assert.equal(styles.find((s) => s.name === 'pirate')?.label, 'Home Pirate');
  setPluginEnabled('pack-styles', false);
});

test('skills: workspace skill wins the name collision (first-wins); plugin-only skills appear when enabled', () => {
  const ws = scratch('ws-skill');
  mkdirSync(join(ws, 'skills', 'dup-skill'), { recursive: true });
  writeFileSync(join(ws, 'skills', 'dup-skill', 'SKILL.md'), '# Dup\n\nWorkspace skill wins.');

  const src = makePluginSource('pack-skills');
  mkdirSync(join(src, 'skills', 'dup-skill'), { recursive: true });
  writeFileSync(join(src, 'skills', 'dup-skill', 'SKILL.md'), '# Dup\n\nPlugin skill loses.');
  installPluginFromPath(src);
  setPluginEnabled('pack-skills', true);

  const skills = discoverSkills(ws);
  const dup = skills.find((s) => s.name === 'dup-skill');
  assert.ok(dup?.body.includes('Workspace skill wins'), 'workspace outranks plugin');
  assert.ok(skills.some((s) => s.name === 'greet-skill'), 'plugin-only skill is discovered');

  setPluginEnabled('pack-skills', false);
  assert.ok(!discoverSkills(ws).some((s) => s.name === 'greet-skill'), 'disabled plugin is invisible');
});

test('agent defs: plugin agents load when enabled; workspace still outranks plugin (pre-existing later-wins)', () => {
  const ws = scratch('ws-agent');
  const src = makePluginSource('pack-agents');
  writeFileSync(
    join(src, 'agents', 'helper.md'),
    '---\nname: helper\ndescription: Plugin helper\ntools:\n  - read_file\n---\nPLUGIN helper prompt.',
  );
  installPluginFromPath(src);
  setPluginEnabled('pack-agents', true);

  let defs = loadAgentDefs(ws);
  assert.equal(defs.find((d) => d.name === 'helper')?.systemPrompt, 'PLUGIN helper prompt.');

  mkdirSync(join(ws, '.shadow', 'agents'), { recursive: true });
  writeFileSync(
    join(ws, '.shadow', 'agents', 'helper.md'),
    '---\nname: helper\ndescription: WS helper\ntools:\n  - read_file\n---\nWORKSPACE helper prompt.',
  );
  defs = loadAgentDefs(ws);
  assert.equal(defs.find((d) => d.name === 'helper')?.systemPrompt, 'WORKSPACE helper prompt.');
  setPluginEnabled('pack-agents', false);
});
