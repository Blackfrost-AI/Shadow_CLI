import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Context } from '../src/agent/context.js';
import { SessionLog } from '../src/state/session.js';
import { captureSessionState } from '../src/state/sessionState.js';

const CLI = resolve('src/index.ts');
const contextOptions = { contextBudget: 10_000, triggerRatio: 0.75, keepLastTurns: 4 };

function fixture(prefix: string): {
  root: string;
  home: string;
  workspace: string;
  sessionPath: string;
  sessionId: string;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const log = SessionLog.open(workspace);
  const context = new Context(contextOptions);
  context.append({ role: 'user', content: [{ type: 'text', text: 'resume this verified legacy session' }] });
  log.bindSessionState(context, () => captureSessionState({}));
  log.recordSnapshot(context, 0);
  log.close();

  return {
    root,
    home,
    workspace,
    sessionPath: log.path,
    sessionId: SessionLog.sessionIdFromPath(log.path),
  };
}

function run(
  f: ReturnType<typeof fixture>,
  args: string[],
): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: f.home,
    USERPROFILE: f.home,
    // The override names the parent; SessionLog appends its own `sessions/` directory.
    SHADOW_SESSION_DIR: dirname(dirname(f.sessionPath)),
    NO_COLOR: '1',
  };
  delete env.SHADOW_HARNESSES;
  delete env.SHADOW_PROFILE;
  return spawnSync(process.execPath, ['--import', 'tsx/esm', CLI, ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function legacyReceiptPath(f: ReturnType<typeof fixture>): string {
  const digest = createHash('sha256').update(resolve(f.sessionPath)).digest('hex');
  return join(f.home, '.shadow', 'session-harness-bindings', `${digest}.json`);
}

const headlessArgs = ['--provider', 'mock', '--model', 'mock', '--task', 'reply ok', '--log-level', 'silent'];

test('shadow resume accepts an explicit id before --trust-legacy and persists its exact receipt', (t) => {
  const f = fixture('shadow-trust-legacy-cli-after-');
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const migrated = run(f, ['resume', f.sessionId, '--trust-legacy', ...headlessArgs]);
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
  assert.match(migrated.stdout, /Trusted one legacy session/);

  const receiptPath = legacyReceiptPath(f);
  assert.equal(existsSync(receiptPath), true);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
    kind?: string;
    sessionId?: string;
    sessionDigest?: string;
  };
  assert.equal(receipt.kind, 'legacy');
  assert.equal(receipt.sessionId, f.sessionId);
  assert.match(receipt.sessionDigest ?? '', /^[a-f0-9]{64}$/);

  const resumed = run(f, ['resume', f.sessionId, ...headlessArgs]);
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.doesNotMatch(resumed.stdout, /Trusted one legacy session/);
});

test('shadow resume accepts --trust-legacy before an explicit id', (t) => {
  const f = fixture('shadow-trust-legacy-cli-before-');
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const migrated = run(f, ['resume', '--trust-legacy', f.sessionId, ...headlessArgs]);
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
  assert.match(migrated.stdout, /Trusted one legacy session/);
  assert.equal(existsSync(legacyReceiptPath(f)), true);
});

test('shadow resume accepts an explicit --session path for legacy migration', (t) => {
  const f = fixture('shadow-trust-legacy-cli-path-');
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const migrated = run(f, [
    'resume',
    '--session',
    f.sessionPath,
    '--trust-legacy',
    ...headlessArgs,
  ]);
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
  assert.match(migrated.stdout, /Trusted one legacy session/);
  assert.equal(existsSync(legacyReceiptPath(f)), true);
});

test('--trust-legacy requires an explicit target and never trusts the newest session implicitly', (t) => {
  const f = fixture('shadow-trust-legacy-cli-explicit-');
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const rejected = run(f, ['resume', '--trust-legacy', ...headlessArgs]);
  assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
  assert.match(rejected.stderr, /--trust-legacy requires an explicit session id or --session <path>/);
  assert.equal(existsSync(legacyReceiptPath(f)), false, 'bare trust must not mint a receipt for newest');
});
