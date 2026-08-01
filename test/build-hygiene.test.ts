import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** T2-2 — build hygiene. Each assertion pins a guard that was missing or unreachable. */
const root = new URL('../', import.meta.url);
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
    cwd: new URL('.', root).pathname,
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

test('the mirror scrub and scan are committed scripts, not doc snippets', () => {
  assert.ok(existsSync(new URL('scripts/scrub-mirror.py', root)));
  assert.ok(existsSync(new URL('scripts/scan-mirror.py', root)));
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
