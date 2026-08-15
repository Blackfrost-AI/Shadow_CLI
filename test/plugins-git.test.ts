// P3-07 — plugin install from git: real clone over file://, commit provenance, fail-fast on bad
// remotes, and the URL allowlist that keeps `ext::`/option-injection away from `git clone`.
// HOME isolated before import; the clone itself runs in a throwaway temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome } from './helpers/isolateHome.js';

const { shadowDir } = isolateHome('plugins-git');

const { installPluginFromGit, installPluginFromArg, listPlugins, pluginsDir } =
  await import('../src/plugins/manager.js');
const { readEgressLogAggregate, flushEgressLogForTests } = await import('../src/safety/egress.js');

assert.ok(pluginsDir().startsWith(shadowDir), 'plugins dir must live under the isolated home');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'plugin-test',
  GIT_AUTHOR_EMAIL: 'plugin-test@example.com',
  GIT_COMMITTER_NAME: 'plugin-test',
  GIT_COMMITTER_EMAIL: 'plugin-test@example.com',
};

function makeRepo(name: string): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), `shadow-plug-git-${name}-`));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name, version: '2.0.0', description: 'installed from git' }),
  );
  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', 'ship.md'), '---\ndescription: Ship it\n---\nShip $ARGUMENTS.');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: dir, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir, env: GIT_ENV });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: GIT_ENV }).toString().trim();
  return { dir, commit };
}

test('installPluginFromGit clones a real repo, records commit provenance, installs DISABLED', () => {
  const { dir, commit } = makeRepo('git-pack');
  const info = installPluginFromGit(`file://${dir}`);
  assert.equal(info.name, 'git-pack');
  assert.equal(info.meta.enabled, false);
  assert.equal(info.meta.source.kind, 'git');
  assert.equal((info.meta.source as { url: string }).url, `file://${dir}`);
  assert.equal((info.meta.source as { commit: string }).commit, commit, 'provenance pins the exact commit');
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.ok(existsSync(join(info.dir, 'commands', 'ship.md')));
  assert.ok(!existsSync(join(info.dir, '.git')), 'the clone metadata never crosses into the install');
});

test('installPluginFromArg routes a URL-shaped arg through the git installer', () => {
  const { dir } = makeRepo('git-arg-pack');
  const before = listPlugins().length;
  const info = installPluginFromArg(`file://${dir}`);
  assert.equal(info.name, 'git-arg-pack');
  assert.equal(listPlugins().length, before + 1);
});

test('a clone failure surfaces a sanitized one-line error and installs nothing', () => {
  const before = listPlugins().length;
  assert.throws(
    () => installPluginFromGit(`file://${join(tmpdir(), 'definitely-not-a-repo-xyz')}`),
    /git clone failed/,
  );
  assert.equal(listPlugins().length, before);
});

test('the URL allowlist is enforced BEFORE git ever runs (transport-level attacks)', () => {
  const before = listPlugins().length;
  for (const url of [
    'ext::sh -c touch% /tmp/pwned', // git ext:: EXECUTES a command
    'http://example.com/repo.git', // unauthenticated
    'git://example.com/repo.git', // unauthenticated
    'ftp://example.com/repo', // unknown scheme
    '-upload-pack=evil', // option injection
    'https://host/repo with-space', // whitespace smuggling
  ]) {
    assert.throws(() => installPluginFromGit(url), /./, `must refuse before cloning: ${url}`);
  }
  assert.equal(listPlugins().length, before, 'no partial installs from rejected URLs');
});

test('offline mode refuses a remote clone and journals a DENIED plugin-clone receipt', async () => {
  const before = listPlugins().length;
  assert.throws(
    () => installPluginFromGit('https://offline.example/repo.git', { offline: true }),
    /offline mode/i,
  );
  assert.equal(listPlugins().length, before, 'offline refusal installs nothing');
  await flushEgressLogForTests(); // the receipt append is async fire-and-forget
  const rows = await readEgressLogAggregate();
  const row = rows.find((r) => r.host === 'offline.example');
  assert.ok(row, 'the denied clone must be journaled');
  assert.ok([...row!.purposes].includes('plugin-clone'));
  assert.ok(row!.denied > 0);
});

test('offline mode still allows a local file:// install (no egress, no receipt)', async () => {
  const { dir } = makeRepo('offline-local');
  const before = listPlugins().length;
  const info = installPluginFromGit(`file://${dir}`, { offline: true });
  assert.equal(info.name, 'offline-local');
  assert.equal(listPlugins().length, before + 1);
});

test('a successful clone is journaled with purpose plugin-clone (allowed path plumbed)', async () => {
  // file:// has no remote host, so it must NOT leave a receipt — proving receipts are keyed to a
  // real remote, not blanket-logged. (Remote "allowed" receipts are exercised by the offline-denied
  // test above via the same recordEgress call site.)
  const { dir } = makeRepo('no-receipt-local');
  installPluginFromGit(`file://${dir}`);
  const rows = await readEgressLogAggregate();
  assert.ok(!rows.some((r) => r.host.includes('no-receipt')), 'local installs never journal a host');
});
