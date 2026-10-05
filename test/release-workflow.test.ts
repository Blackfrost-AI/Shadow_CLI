import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const zero = '0'.repeat(40);

function fixture(t: { after(fn: () => void): void }, version = '9.0.0-dev.0') {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-release-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const dir of ['scripts', '.githooks', 'src']) mkdirSync(join(cwd, dir));
  for (const file of [
    'scripts/release-version.mjs',
    'scripts/check-push.mjs',
    'scripts/check-release-gate.sh',
    '.githooks/pre-push',
  ]) {
    copyFileSync(join(root, file), join(cwd, file));
  }
  const pkg = {
    version,
    scripts: { test: 'node --test --test-timeout=60000 "test/**/*.test.ts" "test/**/*.test.tsx"' },
  };
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(cwd, 'README.md'), `Current build: **v${version}** (previous v8.7.0)\n`);
  writeFileSync(
    join(cwd, 'src/safe.ts'),
    "export const DEV_UNRESTRICTED = process.env.SHADOW_DEV_UNRESTRICTED === '1';\n",
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.test');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  const hook = (
    ref = 'refs/heads/main',
    url = 'https://github.com/example/public.git',
    env = process.env,
    pushedSha = sha,
  ) =>
    spawnSync('bash', ['.githooks/pre-push', 'origin', url], {
      cwd,
      env,
      encoding: 'utf8',
      input: `HEAD ${pushedSha} ${ref} ${zero}\n`,
    });
  return { cwd, git, sha, hook, pkg };
}

for (const version of ['9.0.0', '9.0.0-dev.0', '9.0.0-rc.2+build.42']) {
  test(`release gate and push accept full SemVer ${version}`, (t) => {
    const f = fixture(t, version);
    const gate = spawnSync('bash', ['scripts/check-release-gate.sh'], {
      cwd: f.cwd,
      encoding: 'utf8',
    });
    assert.equal(gate.status, 0, gate.stderr);
    f.git('tag', '-a', `v${version}`, '-m', `release: ${version}`);
    assert.equal(f.hook().status, 0);
    const tagObject = f.git('rev-parse', `refs/tags/v${version}`);
    assert.equal(f.hook(`refs/tags/v${version}`, undefined, undefined, tagObject).status, 0);
  });
}

test('release gate rejects stale, missing, and invalid versions', (t) => {
  const f = fixture(t);
  for (const line of [
    'Current build: v9.0.0 (next v9.0.0-dev.0)',
    'No current build here',
    'Current build: v9.0.0-dev.00',
  ]) {
    writeFileSync(join(f.cwd, 'README.md'), line);
    const res = spawnSync(process.execPath, ['scripts/release-version.mjs'], {
      cwd: f.cwd,
      encoding: 'utf8',
    });
    assert.equal(res.status, 1, line);
  }
  for (const version of ['09.0.0', '9.0.0-01', '9.0.0-', '9.0.0+']) {
    writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ ...f.pkg, version }));
    writeFileSync(join(f.cwd, 'README.md'), `Current build: v${version}`);
    const res = spawnSync(process.execPath, ['scripts/release-version.mjs'], {
      cwd: f.cwd,
      encoding: 'utf8',
    });
    assert.equal(res.status, 1, version);
  }
});

test('version preparation updates only the current build and never pushes', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, 'README.md'), 'Current build: **v8.7.0** — previously v8.6.0\n');
  const res = spawnSync(process.execPath, ['scripts/release-version.mjs', '--sync'], {
    cwd: f.cwd,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(
    readFileSync(join(f.cwd, 'README.md'), 'utf8'),
    'Current build: **v9.0.0-dev.0** — previously v8.6.0\n',
  );
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const key of ['release:dev', 'release:patch', 'release:minor'])
    assert.doesNotMatch(pkg.scripts[key], /\bpush\b/);
});

test('public main requires its own version tag at the pushed commit', (t) => {
  const f = fixture(t);
  assert.equal(f.hook().status, 1, 'untagged main must fail');
  f.git('tag', 'arbitrary-checkpoint');
  f.git('tag', 'v8.7.0');
  assert.equal(f.hook().status, 1, 'unrelated tags must fail');
  assert.equal(f.hook('refs/tags/v8.7.0').status, 1, 'mismatched release tag must fail');
  f.git('tag', 'v9.0.0-dev.0');
  writeFileSync(join(f.cwd, 'package.json'), '{"version":"99.0.0"}');
  assert.equal(f.hook().status, 0, 'validate the pushed commit, not the worktree');
  f.git('add', 'package.json');
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'next');
  f.git('tag', '-f', 'v9.0.0-dev.0');
  assert.equal(f.hook().status, 1, 'correct name on another commit must fail');
});

test('private backup pushes fail closed on wrong destination, public visibility, and lookup failure', { skip: process.platform === 'win32' ? 'fixture gh is an executable POSIX shebang script' : false }, (t) => {
  const f = fixture(t);
  const internal = join(f.cwd, 'docs/internal');
  mkdirSync(internal, { recursive: true });
  writeFileSync(join(internal, 'deployment_instructions.md'), 'private marker');
  const url = 'https://github.com/example/private.git';
  assert.equal(
    f.hook('refs/heads/main', url).status,
    1,
    'fresh private clone needs explicit setup',
  );
  f.git('config', 'shadow.privateRepository', 'example/private');
  const bin = join(f.cwd, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    '#!/usr/bin/env node\nif(process.env.LOOKUP_FAIL)process.exit(1);console.log(JSON.stringify({nameWithOwner:"example/private",isPrivate:process.env.VISIBILITY==="private"}));\n',
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, VISIBILITY: 'private' };
  assert.equal(
    f.hook('refs/heads/main', url, env).status,
    0,
    'private backups need no fake release tag',
  );
  assert.equal(f.hook('refs/heads/main', 'https://github.com/example/public.git', env).status, 1);
  assert.equal(f.hook('refs/heads/main', url, { ...env, VISIBILITY: 'public' }).status, 1);
  assert.equal(f.hook('refs/heads/main', url, { ...env, LOOKUP_FAIL: '1' }).status, 1);
});
