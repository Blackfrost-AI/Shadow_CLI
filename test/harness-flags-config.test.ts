import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseArgs } from '../src/cli/flags.js';
import { loadConfig } from '../src/config.js';

test('--harness and --addon select repeatable provider-neutral add-ons', () => {
  assert.deepEqual(parseArgs(['--harness', 'incident-response', '--addon=forensics,reporting']).harnesses, [
    'incident-response',
    'forensics',
    'reporting',
  ]);
});

test('a project config cannot activate a trusted local harness', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-config-'));
  try {
    writeFileSync(join(root, 'shadow.config.json'), JSON.stringify({ harnesses: ['repo-planted'] }));
    assert.equal(loadConfig(root).harnesses.includes('repo-planted'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
