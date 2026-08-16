#!/usr/bin/env node
/**
 * Verify that the Node distribution (dist/) matches a fresh `npm run build`.
 *
 * Compare the bytes that existed immediately before the build with the bytes after it. This is
 * deliberately independent of Git status: a developer can validate an uncommitted source change
 * as long as they already regenerated dist/, while unrelated dirty files do not block the gate.
 * When stale, the newly generated dist/ is left in place so the diagnostic is directly actionable.
 * A repository that intentionally does not track dist/ starts with no stale bytes, so a successful
 * clean build is accepted and becomes the artifact being checked.
 */
import {
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(process.argv[2] ?? scriptRoot);
const dist = join(root, 'dist');

function hashFile(path) {
  const hash = createHash('sha256');
  return new Promise((resolveHash, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function manifest(dir) {
  const entries = new Map();
  if (!existsSync(dir)) return entries;

  async function visit(path) {
    const names = readdirSync(path).sort();
    for (const name of names) {
      const full = join(path, name);
      const rel = relative(dir, full).split('\\').join('/');
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        entries.set(`${rel}/`, 'directory');
        await visit(full);
      } else if (stat.isSymbolicLink()) {
        entries.set(rel, `symlink:${readlinkSync(full)}`);
      } else if (stat.isFile()) {
        // Executability is package behavior for dist/index.js, so compare it with the bytes.
        entries.set(rel, `file:${stat.mode & 0o111}:${await hashFile(full)}`);
      } else {
        entries.set(rel, `other:${stat.mode}`);
      }
    }
  }

  await visit(dir);
  return entries;
}

function compare(before, after) {
  const differences = [];
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of [...names].sort()) {
    if (!before.has(name)) differences.push(`generated new file: ${name}`);
    else if (!after.has(name)) differences.push(`build removed file: ${name}`);
    else if (before.get(name) !== after.get(name)) differences.push(`generated content changed: ${name}`);
  }
  return differences;
}

/**
 * Resolve npm's JavaScript entrypoint instead of executing the `npm` shell shim. In particular,
 * Node cannot execute npm.cmd directly on Windows without `shell: true`; using the current Node
 * binary with npm-cli.js is portable and does not interpolate any arguments through a shell.
 */
function resolveNpmCli() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];

  // npm normally sits beside node (Windows) or is a symlink on PATH to npm-cli.js (Unix/nvm/Homebrew).
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    candidates.push(join(dir, 'npm'), join(dir, 'npm-cli.js'), join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const real = realpathSync(candidate);
      if (basename(real).toLowerCase() === 'npm-cli.js') return real;
    } catch {
      // A broken PATH shim is not fatal if another npm installation is usable.
    }
  }
  throw new Error("could not locate npm's npm-cli.js; run the gate from an npm-enabled Node installation");
}

function restoreDist(snapshot, existed) {
  rmSync(dist, { recursive: true, force: true });
  if (existed) cpSync(snapshot, dist, { recursive: true, preserveTimestamps: true });
}

async function main() {
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'shadow-dist-check-'));
  const snapshot = join(snapshotRoot, 'dist');
  const existed = existsSync(dist);
  if (existed) cpSync(dist, snapshot, { recursive: true, preserveTimestamps: true });
  let keepGenerated = false;
  let buildCompleted = false;

  try {
    const npmCli = resolveNpmCli();
    execFileSync(process.execPath, [npmCli, 'run', 'build'], { cwd: root, stdio: 'inherit' });
    buildCompleted = true;

    const differences = existed ? compare(await manifest(snapshot), await manifest(dist)) : [];
    if (differences.length > 0) {
      // The build itself succeeded: preserve the useful regenerated output for review.
      keepGenerated = true;
      console.error('RELEASE BLOCKED: dist/ was stale relative to the current source.');
      for (const line of differences.slice(0, 20)) console.error(`  - ${line}`);
      if (differences.length > 20) console.error(`  - …and ${differences.length - 20} more change(s)`);
      console.error('The build regenerated dist/ in place. Review the change against the source, then rerun the gate.');
      console.error('(dist/ is untracked — F06-11: it is built at release time and never committed, so no git step is needed.)');
      return false;
    }

    keepGenerated = true;
    console.log('release-gate OK: dist/ matches a fresh production build.');
    return true;
  } catch (error) {
    console.error(
      buildCompleted
        ? 'RELEASE BLOCKED: dist/ freshness comparison failed unexpectedly.'
        : 'RELEASE BLOCKED: `npm run build` failed while checking dist/ freshness.',
    );
    if (error instanceof Error && (!('status' in error) || error.message)) console.error(error.message);
    console.error('The original dist/ snapshot has been restored.');
    return false;
  } finally {
    if (!keepGenerated) restoreDist(snapshot, existed);
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

process.exitCode = (await main()) ? 0 : 1;
