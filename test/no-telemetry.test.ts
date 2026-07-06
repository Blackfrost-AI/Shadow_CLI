import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

test('CLI and TUI provider creation do not attach persistent user metadata', () => {
  const runtimeSources = ['src/index.ts', 'src/tui.tsx'].map(read).join('\n');

  assert.doesNotMatch(runtimeSources, /\bmetadataUserId\b/);
  assert.doesNotMatch(runtimeSources, /\binstallUserId\b|\bgetInstallId\b/);
});

test('global state does not create install identifiers', () => {
  const source = read('src/state/globalStore.ts');

  assert.doesNotMatch(source, /\binstallId\b/);
  assert.doesNotMatch(source, /\binstallUserId\b|\bgetInstallId\b/);
  assert.doesNotMatch(source, /\brandomUUID\b/);
});

test('Anthropic request shaping has no user identifier metadata wiring', () => {
  const source = read('src/provider/anthropic.ts');

  assert.doesNotMatch(source, /\bmetadataUserId\b/);
  assert.doesNotMatch(source, /metadata\s*=\s*\{\s*user_id/);
});
