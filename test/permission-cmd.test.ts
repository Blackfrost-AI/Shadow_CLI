import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPermissionCommand } from '../src/safety/permissionCmd.js';

const BASE = [{ tool: 'run_shell', pattern: 'rm -rf', action: 'ask' as const }];

test('applyPermissionCommand lists rules with indices', () => {
  const r = applyPermissionCommand(BASE, '');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.message, /#0.*ask.*run_shell/);
});

test('applyPermissionCommand add/remove/set mutate rules', () => {
  const added = applyPermissionCommand(BASE, 'add deny read_file');
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(added.rules.length, 2);
  assert.equal(added.rules[1]!.action, 'deny');

  const removed = applyPermissionCommand(added.rules, 'remove 0');
  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.equal(removed.rules.length, 1);
  assert.equal(removed.rules[0]!.tool, 'read_file');

  const set = applyPermissionCommand(removed.rules, 'set 0 allow grep /foo/');
  assert.equal(set.ok, true);
  if (!set.ok) return;
  assert.deepEqual(set.rules[0], { action: 'allow', tool: 'grep', pattern: 'foo' });
});

test('applyPermissionCommand clear wipes rules', () => {
  const r = applyPermissionCommand(BASE, 'clear');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.rules.length, 0);
});