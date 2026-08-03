import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** T2-2 — build hygiene. Each assertion pins a guard that was missing or unreachable. */
const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  dependencies: Record<string, string>;
};

test('npm run lint can actually exit 0', () => {
  // It could not before: 49 no-undef errors for browser globals in src/web/ui/*.js meant lint was
  // permanently red, so nobody ran it, so 5 REAL errors sat hidden behind the noise.
  const out = execFileSync('npx', ['eslint', '.', '-f', 'json'], {
    cwd: rootPath,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const errors = (JSON.parse(out) as Array<{ messages: Array<{ severity: number }> }>)
    .flatMap((f) => f.messages)
    .filter((m) => m.severity === 2);
  assert.equal(errors.length, 0, `${errors.length} lint errors remain`);
});

test('.prettierignore exists and covers the generated files', () => {
  assert.ok(existsSync(new URL('.prettierignore', root)), 'without it, `npm run format` rewrites dist/');
  const ig = read('.prettierignore');
  for (const p of ['dist/', 'src/web/bundledAssets.ts', 'src/system/bundledPrompts.ts', 'src/web/ui/vendor/']) {
    assert.ok(ig.includes(p), `${p} must be ignored — it is generated or vendored`);
  }
});

test('the release gate runs from the artifact producer, not only from an unreachable hook', () => {
  const build = read('scripts/build-binary.sh');
  assert.match(build, /check-release-gate\.sh/, 'build-binary.sh must invoke the gate');
  // prepublishOnly is unreachable because the package is private — that was the whole problem.
  assert.equal(pkg.scripts.prepublishOnly?.includes('check-release-gate'), true);
});

test('the production build starts from a clean dist directory', () => {
  assert.match(
    pkg.scripts.build ?? '',
    /rmSync\(['"]dist['"],\{recursive:true,force:true\}\)/,
    'tsc does not remove outputs for deleted source files; building over dist/ can ship obsolete JavaScript',
  );
});

test('the test command includes quoted TS and TSX globs', () => {
  assert.match(pkg.scripts.test ?? '', /"test\/\*\*\/\*\.test\.ts"/);
  assert.match(
    pkg.scripts.test ?? '',
    /"test\/\*\*\/\*\.test\.tsx"/,
    'component regression tests were silently excluded from the nominal whole-suite command',
  );
});

test('the dist checker invokes npm-cli.js through Node, never a platform shell shim', () => {
  const checker = read('scripts/check-dist-fresh.mjs');
  assert.match(checker, /execFileSync\(process\.execPath, \[npmCli, 'run', 'build'\]/);
  assert.doesNotMatch(checker, /execFileSync\(['"]npm(?:\.cmd)?['"]/);
});

test('the release gate rejects stale dist artifacts without relying on a clean git worktree', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'shadow-dist-gate-test-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, 'dist'));
  writeFileSync(join(fixture, 'source.js'), 'console.log("current");\n');
  writeFileSync(join(fixture, 'dist', 'index.js'), 'console.log("current");\n');
  chmodSync(join(fixture, 'dist', 'index.js'), 0o755);
  writeFileSync(
    join(fixture, 'build.mjs'),
    "import { copyFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';\n" +
      "rmSync('dist', { recursive: true, force: true });\n" +
      "mkdirSync('dist', { recursive: true });\n" +
      "copyFileSync('source.js', 'dist/index.js');\n" +
      "chmodSync('dist/index.js', 0o755);\n",
  );
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({ private: true, scripts: { build: 'node build.mjs' } }),
  );

  const checker = fileURLToPath(new URL('../scripts/check-dist-fresh.mjs', import.meta.url));
  const fresh = spawnSync(process.execPath, [checker, fixture], { encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /dist\/ matches a fresh production build/);

  rmSync(join(fixture, 'dist'), { recursive: true, force: true });
  const initiallyAbsent = spawnSync(process.execPath, [checker, fixture], { encoding: 'utf8' });
  assert.equal(
    initiallyAbsent.status,
    0,
    `a clean clone that intentionally does not track dist/ has no stale bytes: ${initiallyAbsent.stderr}`,
  );
  assert.equal(
    readFileSync(join(fixture, 'dist', 'index.js'), 'utf8'),
    readFileSync(join(fixture, 'source.js'), 'utf8'),
    'the gate leaves the cleanly generated distribution in place',
  );

  writeFileSync(join(fixture, 'dist', 'obsolete.js'), 'old output with no source file\n');
  const obsolete = spawnSync(process.execPath, [checker, fixture], { encoding: 'utf8' });
  assert.equal(obsolete.status, 1, 'an obsolete generated file must block release');
  assert.match(obsolete.stderr, /build removed file: obsolete\.js/);
  assert.equal(existsSync(join(fixture, 'dist', 'obsolete.js')), false, 'the clean build removes obsolete output');

  writeFileSync(join(fixture, 'dist', 'index.js'), 'console.log("stale");\n');
  const stale = spawnSync(process.execPath, [checker, fixture], { encoding: 'utf8' });
  assert.equal(stale.status, 1, 'a stale package artifact must block release');
  assert.match(stale.stderr, /RELEASE BLOCKED: dist\/ was stale/);
  assert.equal(
    readFileSync(join(fixture, 'dist', 'index.js'), 'utf8'),
    readFileSync(join(fixture, 'source.js'), 'utf8'),
    'the gate should leave the regenerated artifact in place for review',
  );

  // A failed clean build may have deleted all of dist/ and written partial output. The checker
  // must put the exact pre-build tree back instead of turning a diagnostic into data loss.
  writeFileSync(join(fixture, 'dist', 'keep.txt'), 'preserve me\n');
  chmodSync(join(fixture, 'dist', 'index.js'), 0o755);
  const originalIndex = readFileSync(join(fixture, 'dist', 'index.js'), 'utf8');
  const originalMode = statSync(join(fixture, 'dist', 'index.js')).mode & 0o777;
  writeFileSync(
    join(fixture, 'fail-build.mjs'),
    "import { mkdirSync, rmSync, writeFileSync } from 'node:fs';\n" +
      "rmSync('dist', { recursive: true, force: true });\n" +
      "mkdirSync('dist', { recursive: true });\n" +
      "writeFileSync('dist/partial.js', 'incomplete\\n');\n" +
      "process.exit(7);\n",
  );
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({ private: true, scripts: { build: 'node fail-build.mjs' } }),
  );
  const failed = spawnSync(process.execPath, [checker, fixture], { encoding: 'utf8' });
  assert.equal(failed.status, 1, 'a failed diagnostic build must block release');
  assert.match(failed.stderr, /original dist\/ snapshot has been restored/i);
  assert.equal(readFileSync(join(fixture, 'dist', 'index.js'), 'utf8'), originalIndex);
  assert.equal(readFileSync(join(fixture, 'dist', 'keep.txt'), 'utf8'), 'preserve me\n');
  assert.equal(statSync(join(fixture, 'dist', 'index.js')).mode & 0o777, originalMode);
  assert.equal(existsSync(join(fixture, 'dist', 'partial.js')), false, 'partial failed-build output is removed');
});

test('the pre-push hook installs itself', () => {
  assert.match(pkg.scripts.prepare ?? '', /core\.hooksPath \.githooks/,
    'core.hooksPath was unset, so .githooks/pre-push had ZERO effect despite claiming to make a ' +
    'missing version bump "structurally impossible"');
});

test('@types/react matches the React actually installed', () => {
  const major = (v: string): string => v.replace(/^[^0-9]*/, '').split('.')[0]!;
  assert.equal(major(pkg.devDependencies['@types/react']!), major(pkg.dependencies.react!),
    'React 19 types over React 18 let `<Ctx value={x}>` typecheck and break at runtime');
});

test('mirror scrub tools are committed privately and excluded from the public mirror', () => {
  const hasPrivateReleaseRecipe = existsSync(new URL('deployment_instructions.md', root));
  const hasScrubber = existsSync(new URL('scripts/scrub-mirror.py', root));
  const hasScanner = existsSync(new URL('scripts/scan-mirror.py', root));
  if (!hasPrivateReleaseRecipe) {
    assert.equal(hasScrubber, false, 'the public mirror must not publish the private substitution map');
    assert.equal(hasScanner, false, 'the public mirror must not publish the private blocker map');
    return;
  }

  assert.equal(hasScrubber, true, 'the private release recipe requires a committed scrubber');
  assert.equal(hasScanner, true, 'the private release recipe requires a committed scanner');
  const scan = read('scripts/scan-mirror.py');
  assert.match(scan, /ls-files", "--others"|ls-files', '--others'|--others/, 'must scan UNTRACKED files too — a brand-new test file is exactly the risk');
  assert.match(scan, /return 1 if total else 0/, 'and exit non-zero so it can gate a script');
});

test('.gitignore closes the secret holes', () => {
  const ig = read('.gitignore');
  for (const p of ['.env.*', '*.key', '*.pem', '.shadow-signing/']) {
    assert.ok(ig.includes(p), `${p} must be ignored — the mirror sync uses a broad \`git add -A\``);
  }
});

test('the broken rc-finalize script is gone', () => {
  // GNU `sed -i` with no suffix: fails on BSD sed, and it ran AFTER npm version had already
  // bumped. It also grepped for `DEV_UNRESTRICTED = true`, the exact string the release gate
  // exists to block — dead code encoding an inverted model of the safety flag.
  assert.equal(existsSync(new URL('scripts/rc-finalize.sh', root)), false);
});
