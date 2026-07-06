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