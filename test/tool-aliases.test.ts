import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { canonicalToolName } from '../src/tools/aliases.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ok, type Tool } from '../src/tools/types.js';

test('canonicalToolName maps SAME-SHAPE aliases, passes unknowns through', () => {
  assert.equal(canonicalToolName('bash'), 'run_shell');
  assert.equal(canonicalToolName('sh'), 'run_shell');
  assert.equal(canonicalToolName('applypatch'), 'apply_patch');
  assert.equal(canonicalToolName('MULTIEDIT'), 'multi_edit'); // case-insensitive
  assert.equal(canonicalToolName('websearch'), 'web_search');
  assert.equal(canonicalToolName('read_file'), 'read_file'); // already canonical
  assert.equal(canonicalToolName('frobnicate'), 'frobnicate'); // unknown → passthrough
  // Schema-incompatible aliases were removed (review #15) — name-mapping str_replace/create_file
  // would only fail zod validation, so they are NOT aliases.
  assert.equal(canonicalToolName('str_replace'), 'str_replace');
  assert.equal(canonicalToolName('ripgrep'), 'ripgrep');
});

test('registry.get resolves an alias to the canonical tool, whose NAME is canonical (review #1/#2)', () => {
  const reg = new ToolRegistry();
  const stub: Tool = {
    name: 'run_shell',
    description: 'stub',
    risk: 'exec',
    inputSchema: z.object({}),
    run: async () => ok('run_shell', 'exec', 0, 'ok'),
  };
  reg.register(stub);
  assert.equal(reg.get('run_shell'), stub); // exact
  assert.equal(reg.get('bash'), stub); // alias
  // The loop canonicalizes call.name to tool.name; this is the value it uses for the
  // denylist / permission rules / gate — must be the real tool, never the alias.
  assert.equal(reg.get('bash')!.name, 'run_shell');
  assert.equal(reg.get('nonexistent'), undefined);
});
