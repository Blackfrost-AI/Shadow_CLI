import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBashReadOnly, READ_ONLY_PREFIXES } from '../src/safety/bashReadOnly.js';

test('READ_ONLY_PREFIXES is exported and non-empty', () => {
  assert.ok(READ_ONLY_PREFIXES.length > 0);
  assert.ok(READ_ONLY_PREFIXES.includes('git status'));
});

test('isBashReadOnly allows common read-only commands', () => {
  assert.equal(isBashReadOnly('git status'), true);
  assert.equal(isBashReadOnly('git log --oneline -5'), true);
  assert.equal(isBashReadOnly('git diff HEAD~1'), true);
  assert.equal(isBashReadOnly('rg pattern src/'), true);
  assert.equal(isBashReadOnly('grep -r foo .'), true);
  assert.equal(isBashReadOnly('ls -la'), true);
  assert.equal(isBashReadOnly('cat README.md'), true);
  assert.equal(isBashReadOnly('head -n 20 file.txt'), true);
  assert.equal(isBashReadOnly('tail -f log.txt'), true);
  assert.equal(isBashReadOnly('find . -name "*.ts"'), true);
  assert.equal(isBashReadOnly('docker ps'), true);
  assert.equal(isBashReadOnly('npm test'), true);
});

test('isBashReadOnly rejects destructive or mutating commands', () => {
  assert.equal(isBashReadOnly('rm -rf /'), false);
  assert.equal(isBashReadOnly('git push origin main'), false);
  assert.equal(isBashReadOnly('npm install lodash'), false);
  assert.equal(isBashReadOnly('find . -delete'), false);
  assert.equal(isBashReadOnly('find . -exec rm {} \\;'), false);
});

test('isBashReadOnly normalizes leading $ and uses first pipeline segment', () => {
  assert.equal(isBashReadOnly('$ git status'), true);
  assert.equal(isBashReadOnly('git status | wc -l'), true);
  assert.equal(isBashReadOnly('echo hi && rm -rf /'), false);
});

test('isBashReadOnly never auto-allows a command substitution / subshell', () => {
  // A subshell can hide arbitrary work behind a read-only-looking prefix, so it
  // must fall through to the gate rather than ride the no-confirm fast path.
  assert.equal(isBashReadOnly('grep TODO $(git ls-files)'), false);
  assert.equal(isBashReadOnly('cat $(which node)'), false);
  assert.equal(isBashReadOnly('echo `id`'), false);
  assert.equal(isBashReadOnly('ls <(sort a.txt)'), false);
  // ...but plain parameter expansion does not execute, so it stays read-only.
  assert.equal(isBashReadOnly('echo ${HOME}'), true);
});