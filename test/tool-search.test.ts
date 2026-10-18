import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tools/registry.js';
import { makeToolSearch } from '../src/tools/toolSearch.js';
import { z } from 'zod';
import type { Tool } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';

const stub: Tool = {
  name: 'hidden_widget',
  description: 'hidden',
  risk: 'read',
  deferred: true,
  inputSchema: z.object({}),
  async run() {
    return ok('hidden_widget', 'read', 0, 'ok');
  },
};

test('deferred tools are excluded from default schemas', () => {
  const reg = new ToolRegistry();
  reg.register(stub);
  reg.register(makeToolSearch(reg));
  assert.equal(reg.toSchemas().length, 1, 'tool_search is always active');
  assert.equal(reg.listDeferred().length, 1);
});

test('tool_search finds deferred tools by query', async () => {
  const reg = new ToolRegistry();
  reg.register(stub);
  const search = makeToolSearch(reg);
  reg.register(search);
  const result = await search.run({ query: 'widget' }, {
    workspaceRoot: '/tmp',
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.tools, ['hidden_widget']);
});

test('registry.searchDeferred matches substrings', () => {
  const reg = new ToolRegistry();
  reg.register(stub);
  assert.equal(reg.searchDeferred('hidden').length, 1);
  assert.equal(reg.searchDeferred('missing').length, 0);
});

// Discoverability regression: the security toolbelt was registered but unreachable. Deferred
// lookup matched the tool NAME only, so a model asked to "analyze this malware sample" could not
// reach `bin_recon` without already knowing the word "recon". These pin the alias path.
const aliased: Tool = {
  name: 'bin_recon',
  description: 'binary recon',
  risk: 'read',
  deferred: true,
  searchAliases: ['malware', 'reverse', 'disassemble', 'macho'],
  inputSchema: z.object({}),
  async run() {
    return ok('bin_recon', 'read', 0, 'ok');
  },
};

test('searchDeferred matches searchAliases, not just the tool name', () => {
  const reg = new ToolRegistry();
  reg.register(aliased);
  for (const q of ['malware', 'reverse', 'disassemble', 'macho', 'MALWARE', 'Recon']) {
    assert.equal(reg.searchDeferred(q).length, 1, `expected a hit for ${q}`);
  }
});

test('searchDeferred still returns nothing for an unmatched query', () => {
  const reg = new ToolRegistry();
  reg.register(aliased);
  assert.equal(reg.searchDeferred('kubernetes').length, 0);
});

test('searchDeferred requires every word of a multi-word query to match', () => {
  const reg = new ToolRegistry();
  reg.register(aliased);
  reg.register(stub);
  // Both words hit bin_recon's own name/aliases -> it stays; hidden_widget matches neither.
  assert.deepEqual(
    reg.searchDeferred('recon malware').map((t) => t.name),
    ['bin_recon'],
  );
  // A query whose words split across DIFFERENT tools must not union them.
  assert.equal(reg.searchDeferred('malware widget').length, 0);
});

test('searchDeferred ignores an empty or whitespace-only query', () => {
  const reg = new ToolRegistry();
  reg.register(aliased);
  assert.equal(reg.searchDeferred('').length, 0);
  assert.equal(reg.searchDeferred('   ').length, 0);
});

// A bare substring test over short strings is how search goes vague. Two guards keep the
// alias lists honest; both were added after "pe" matched four of five security tools at once.

test('a 1-2 char query matches a whole word, not a substring', () => {
  const reg = new ToolRegistry();
  reg.register(aliased); // name bin_recon, alias "macho"
  // "re" is inside "recon" but is not a token -> no match. That is the point: short queries
  // are otherwise unsatisfiable noise.
  assert.equal(reg.searchDeferred('re').length, 0);
  // An exact short alias still resolves.
  reg.register({ ...aliased, name: 'pe_tool', searchAliases: ['pe'] });
  assert.deepEqual(
    reg.searchDeferred('pe').map((t) => t.name),
    ['pe_tool'],
  );
  // ...and must NOT bleed into the longer names it is a substring of.
  assert.ok(!reg.searchDeferred('pe').some((t) => t.name === 'bin_recon'));
});

test('a 3-char query matches as a prefix, so "rat" cannot hit "restore"', () => {
  const reg = new ToolRegistry();
  reg.register({ ...aliased, name: 'snapshotter', searchAliases: ['restore'] });
  // "rat" is not a prefix of "restore", so no match — the old substring test matched it.
  assert.equal(reg.searchDeferred('rat').length, 0);
  // A real prefix of 3 chars still matches.
  reg.register({ ...aliased, name: 'rat_tool', searchAliases: ['rat'] });
  assert.deepEqual(
    reg.searchDeferred('rat').map((t) => t.name),
    ['rat_tool'],
  );
});

test('aliases are tokenised, so a multi-word alias matches its parts', () => {
  const reg = new ToolRegistry();
  reg.register({ ...aliased, searchAliases: ['attack surface'] });
  assert.deepEqual(
    reg.searchDeferred('surface').map((t) => t.name),
    ['bin_recon'],
  );
});