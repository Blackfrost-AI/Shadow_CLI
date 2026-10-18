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
// REGRESSION (2026-10-18 DWM eval): `tool_search` reimplemented its own filter
// (`name.includes(query) || every word in name`) and ignored `searchAliases` entirely. A live
// model asked to detonate a sample searched five times — "detonate sample in sandbox
// containment", "malware", "sample_run detonate binary sandbox" — got "No matching tools" for
// all but the exact-name query, then burned its remaining iterations shelling around looking for
// a CLI surface that does not exist. These are the verbatim queries from that transcript.
const detonator: Tool = {
  name: 'sample_run',
  description: 'contained detonation',
  risk: 'exec',
  deferred: true,
  searchAliases: ['detonate', 'sandbox', 'execution', 'malware', 'ransomware'],
  inputSchema: z.object({ path: z.string() }),
  async run() {
    return ok('sample_run', 'exec', 0, 'ok');
  },
};

function searchRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(detonator);
  reg.register(aliased);
  return reg;
}

test('tool_search resolves the natural-language queries from the DWM transcript', async () => {
  const reg = searchRegistry();
  const search = makeToolSearch(reg);
  reg.register(search);
  const ctx = { workspaceRoot: '/tmp', signal: new AbortController().signal, log: () => {}, dryRun: false };

  const cases: Array<[string, string]> = [
    ['detonate sample in sandbox containment', 'sample_run'],
    ['sample_run detonate binary sandbox', 'sample_run'],
    ['malware', 'bin_recon'],
    ['sample_run', 'sample_run'],
    ['detonate', 'sample_run'],
    ['malware reverse disassemble', 'bin_recon'],
  ];
  for (const [query, expected] of cases) {
    const r = await search.run({ query }, ctx as never);
    assert.ok(
      r.data!.tools.includes(expected),
      `query ${JSON.stringify(query)} should reach ${expected}, got [${r.data!.tools.join(', ')}]`,
    );
  }
});

test('tool_search returns a callable schema, not a bare name', async () => {
  const reg = searchRegistry();
  const search = makeToolSearch(reg);
  const ctx = { workspaceRoot: '/tmp', signal: new AbortController().signal, log: () => {}, dryRun: false };
  const r = await search.run({ query: 'detonate' }, ctx as never);
  const first = r.data!.schemas[0];
  assert.equal(first.name, 'sample_run');
  assert.equal(first.risk, 'exec');
  assert.ok(first.description.length > 0, 'description must be included so the model can choose');
  assert.equal((first.parameters as { type?: string }).type, 'object');
  assert.ok(
    JSON.stringify(first.parameters).includes('path'),
    'the argument schema must be present or the model cannot construct a valid call',
  );
  assert.ok(!('$schema' in (first.parameters as object)), 'providers want a bare object schema');
});

test('an unmatched query returns no tools and a usable hint', async () => {
  const reg = searchRegistry();
  const search = makeToolSearch(reg);
  const ctx = { workspaceRoot: '/tmp', signal: new AbortController().signal, log: () => {}, dryRun: false };
  const r = await search.run({ query: 'kubernetes' }, ctx as never);
  assert.deepEqual(r.data!.tools, []);
  assert.match(String(r.summary), /No deferred tool matches/);
});

test('searchDeferredRanked drops filler words and ranks by matched word count', () => {
  const reg = searchRegistry();
  // "in"/"the" carry no intent; they must not decide the result.
  assert.deepEqual(reg.searchDeferredRanked('detonate in the sandbox').map((t) => t.name), ['sample_run']);
  // Three hits outrank one hit. `bin_recon` still appears — it legitimately carries the
  // "malware" alias — but below `sample_run`, and ties fall back to name order.
  reg.register({ ...detonator, name: 'zzz_other', searchAliases: ['detonate'] });
  assert.deepEqual(reg.searchDeferredRanked('malware detonate sandbox').map((t) => t.name), [
    'sample_run',
    'bin_recon',
    'zzz_other',
  ]);
});

// REGRESSION (2026-10-18 DWM eval): discovery was a dead end. `tool_search` returned a bare name
// and never added the tool to `toSchemas()`, so the model had to emit a call for a tool whose
// arguments it had never seen. Live models instead shelled out to `otool`/`xxd` for 15 iterations
// and never touched `bin_recon`. Search must promote.
test('tool_search promotes a match into the active schema', async () => {
  const reg = searchRegistry();
  const search = makeToolSearch(reg);
  reg.register(search);

  assert.ok(!reg.toSchemas().some((s) => s.name === 'sample_run'), 'starts hidden');
  assert.deepEqual(reg.listRevealed(), []);

  await search.run({ query: 'detonate' }, { workspaceRoot: '/tmp', signal: new AbortController().signal, log: () => {}, dryRun: false } as never);

  const schemas = reg.toSchemas();
  assert.ok(schemas.some((s) => s.name === 'sample_run'), 'revealed tool must appear in the schema');
  assert.deepEqual(reg.listRevealed(), ['sample_run']);
  // The revealed schema must carry real arguments, or the model still cannot call it.
  const s = schemas.find((x) => x.name === 'sample_run')!;
  assert.ok(JSON.stringify(s.parameters).includes('path'));
});

test('revealed tools leave the deferred list and survive re-search', async () => {
  const reg = searchRegistry();
  const search = makeToolSearch(reg);
  reg.register(search);
  const ctx = { workspaceRoot: '/tmp', signal: new AbortController().signal, log: () => {}, dryRun: false } as never;

  await search.run({ query: 'detonate' }, ctx);
  assert.ok(!reg.listDeferred().some((t) => t.name === 'sample_run'), 'no longer deferred');
  await search.run({ query: 'detonate' }, ctx);
  assert.deepEqual(reg.listRevealed(), ['sample_run'], 'idempotent');
});

test('search cannot reveal a denied tool', async () => {
  const reg = searchRegistry();
  const search = makeToolSearch(reg);
  reg.register(search);
  reg.setDenied(['sample_run']);
  await search.run({ query: 'detonate' }, { workspaceRoot: '/tmp', signal: new AbortController().signal, log: () => {}, dryRun: false } as never);
  assert.deepEqual(reg.listRevealed(), []);
  assert.ok(!reg.toSchemas().some((s) => s.name === 'sample_run'));
});
