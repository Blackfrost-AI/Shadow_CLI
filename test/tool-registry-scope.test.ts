import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { ToolRegistry } from '../src/tools/registry.js';
import { ok, type Tool } from '../src/tools/types.js';

function tool(name: string, deferred = false): Tool {
  return {
    name,
    description: name,
    risk: 'read',
    deferred,
    inputSchema: z.object({}),
    async run() {
      return ok(name, 'read', 0, name);
    },
  };
}

test('session tool subtraction covers schemas, aliases, search and dispatch', () => {
  const registry = new ToolRegistry();
  registry.register(tool('run_shell'));
  registry.register(tool('secret_probe', true));
  registry.setDenied(['run_shell', 'secret_probe']);

  assert.equal(registry.get('run_shell'), undefined);
  assert.equal(registry.get('bash'), undefined, 'foreign alias cannot recover a denied canonical tool');
  assert.equal(registry.get('secret_probe'), undefined);
  assert.deepEqual(registry.list({ includeDeferred: true }), []);
  assert.deepEqual(registry.searchDeferred('probe'), []);
  assert.deepEqual(registry.toSchemas(), []);

  assert.equal(registry.getUnscoped('run_shell')?.name, 'run_shell', 'host wiring keeps access to compiled implementation');
});
