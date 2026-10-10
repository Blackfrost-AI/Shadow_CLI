import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context } from '../src/agent/context.js';
import { resumeSession, trustLegacySession } from '../src/state/resume.js';
import { SessionLog } from '../src/state/session.js';
import {
  captureSessionState,
  type SessionHarnessSnapshot,
  type SessionStateSnapshot,
} from '../src/state/sessionState.js';
import {
  MAX_LEGACY_SESSION_BYTES,
  recordSessionHarnessBinding,
  sessionHarnessBindingPath,
} from '../src/state/sessionHarnessBinding.js';

const contextOptions = { contextBudget: 10_000, triggerRatio: 0.75, keepLastTurns: 4 };

function harness(): SessionHarnessSnapshot {
  return {
    foundation: { id: 'shadow-security', version: '1', digest: 'foundation-digest' },
    addons: [{ id: 'incident-response', version: '1.0.0', digest: 'addon-digest' }],
    digest: 'stack-digest',
  };
}

function assertOwnerOnlyBindingFile(path: string): void {
  const stat = statSync(path);
  assert.equal(stat.isFile(), true);
  // Windows reports synthesized POSIX mode bits (typically 0666); production uses the owning
  // user's profile directory there and deliberately applies the 0600 check only on POSIX.
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
}

function seed(
  root: string,
  state: SessionStateSnapshot,
): SessionLog {
  const log = SessionLog.open(root);
  const context = new Context(contextOptions);
  context.append({ role: 'user', content: [{ type: 'text', text: 'continue' }] });
  log.bindSessionState(context, () => state);
  log.recordSnapshot(context, 0);
  log.close();
  return log;
}

test('a valid current-format snapshot resumes only with its matching owner-only binding', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-valid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bindingsDir = join(root, 'outside-workspace-bindings');
  const savedHarness = harness();
  const state = captureSessionState({ harness: savedHarness });
  assert.equal(state.version, 2);
  const log = seed(join(root, 'workspace'), state);
  recordSessionHarnessBinding(log.path, savedHarness, { bindingsDir });

  const resumed = resumeSession(log.path, { ...contextOptions, bindingsDir });
  assert.equal(resumed.state.version, 2);
  assert.deepEqual(resumed.state.harness, savedHarness);
  assertOwnerOnlyBindingFile(sessionHarnessBindingPath(log.path, { bindingsDir }));
});

test('a marked-current snapshot with malformed harness metadata fails closed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-malformed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bindingsDir = join(root, 'bindings');
  const savedHarness = harness();
  const malformed = {
    ...captureSessionState({ harness: savedHarness }),
    harness: { ...savedHarness, digest: '' },
  } as SessionStateSnapshot;
  const log = seed(join(root, 'workspace'), malformed);
  recordSessionHarnessBinding(log.path, savedHarness, { bindingsDir });

  assert.throws(
    () => resumeSession(log.path, { ...contextOptions, bindingsDir }),
    /current-format harness metadata is missing or malformed/,
  );
});

test('deleting harness metadata from a marked-current snapshot cannot become legacy', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bindingsDir = join(root, 'bindings');
  const savedHarness = harness();
  const missing = captureSessionState({ harness: savedHarness });
  delete missing.harness;
  const log = seed(join(root, 'workspace'), missing);
  recordSessionHarnessBinding(log.path, savedHarness, { bindingsDir });

  assert.throws(
    () => resumeSession(log.path, { ...contextOptions, bindingsDir }),
    /current-format harness metadata is missing or malformed/,
  );
});

test('a current-format snapshot without its external binding fails closed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-absent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bindingsDir = join(root, 'bindings');
  const log = seed(join(root, 'workspace'), captureSessionState({ harness: harness() }));

  assert.throws(
    () => resumeSession(log.path, { ...contextOptions, bindingsDir }),
    /owner-only session harness binding is missing/,
  );
});

test('a bound current session cannot be downgraded to a forged legacy state', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-downgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bindingsDir = join(root, 'bindings');
  const savedHarness = harness();
  const log = seed(join(root, 'workspace'), captureSessionState({}));
  recordSessionHarnessBinding(log.path, savedHarness, { bindingsDir });

  assert.throws(
    () => resumeSession(log.path, { ...contextOptions, bindingsDir }),
    /owner-only harness binding exists.*lost its current-format harness metadata/,
  );
});

test('a genuine pre-harness v1 session needs one explicit owner-side migration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bindingsDir = join(root, 'bindings');
  const legacy = captureSessionState({});
  assert.equal(legacy.version, 1);
  const log = seed(join(root, 'workspace'), legacy);

  assert.throws(
    () => resumeSession(log.path, { ...contextOptions, bindingsDir }),
    /unbound log cannot be authenticated as pre-harness.*--trust-legacy/,
  );
  trustLegacySession(log.path, { bindingsDir });
  const resumed = resumeSession(log.path, { ...contextOptions, bindingsDir });
  assert.equal(resumed.state.version, 1);
  assert.equal(resumed.state.harness, undefined);
  assertOwnerOnlyBindingFile(sessionHarnessBindingPath(log.path, { bindingsDir }));
});

test('copying or renaming a bound v2 log and stripping it to v1 cannot inherit legacy trust', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-copy-downgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bindingsDir = join(root, 'bindings');
  const savedHarness = harness();

  const copiedSource = seed(join(root, 'copy-workspace'), captureSessionState({ harness: savedHarness }));
  recordSessionHarnessBinding(copiedSource.path, savedHarness, { bindingsDir });
  const copied = join(dirname(copiedSource.path), '2099-01-01T00-00-00.000Z.jsonl');
  copyFileSync(copiedSource.path, copied);
  const copiedRecord = JSON.parse(readFileSync(copied, 'utf8').trim()) as {
    data: { sessionState: SessionStateSnapshot };
  };
  copiedRecord.data.sessionState.version = 1;
  delete copiedRecord.data.sessionState.harness;
  writeFileSync(copied, `${JSON.stringify(copiedRecord)}\n`);
  assert.throws(
    () => resumeSession(copied, { ...contextOptions, bindingsDir }),
    /unbound log cannot be authenticated as pre-harness/,
  );

  const renamedSource = seed(join(root, 'rename-workspace'), captureSessionState({ harness: savedHarness }));
  recordSessionHarnessBinding(renamedSource.path, savedHarness, { bindingsDir });
  const renamed = join(dirname(renamedSource.path), '2099-01-02T00-00-00.000Z.jsonl');
  renameSync(renamedSource.path, renamed);
  const renamedRecord = JSON.parse(readFileSync(renamed, 'utf8').trim()) as {
    data: { sessionState: SessionStateSnapshot };
  };
  renamedRecord.data.sessionState.version = 1;
  delete renamedRecord.data.sessionState.harness;
  writeFileSync(renamed, `${JSON.stringify(renamedRecord)}\n`);
  assert.throws(
    () => resumeSession(renamed, { ...contextOptions, bindingsDir }),
    /unbound log cannot be authenticated as pre-harness/,
  );
});

test('a trusted legacy receipt is bound to exact content and cannot bless a copied path', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-legacy-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bindingsDir = join(root, 'bindings');
  const legacy = seed(join(root, 'workspace'), captureSessionState({}));
  trustLegacySession(legacy.path, { bindingsDir });

  const copied = join(dirname(legacy.path), '2099-01-03T00-00-00.000Z.jsonl');
  copyFileSync(legacy.path, copied);
  assert.throws(
    () => resumeSession(copied, { ...contextOptions, bindingsDir }),
    /unbound log cannot be authenticated as pre-harness/,
  );

  appendFileSync(legacy.path, `${JSON.stringify({ kind: 'event', type: 'tampered' })}\n`);
  assert.throws(
    () => resumeSession(legacy.path, { ...contextOptions, bindingsDir }),
    /legacy session log no longer matches its owner-only binding/,
  );
});

test('explicit legacy migration never blesses a v2 session with a missing current binding', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-no-v2-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bindingsDir = join(root, 'bindings');
  const current = seed(join(root, 'workspace'), captureSessionState({ harness: harness() }));

  assert.throws(
    () => trustLegacySession(current.path, { bindingsDir }),
    /refusing legacy migration because this log contains a current-format v2 snapshot/,
  );
});

test('a legacy-looking tail cannot hide an earlier v2 snapshot from migration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-v2-lineage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bindingsDir = join(root, 'bindings');
  const current = seed(join(root, 'workspace'), captureSessionState({ harness: harness() }));
  const legacyTail = {
    ts: new Date().toISOString(),
    kind: 'context_snapshot',
    turn: 1,
    data: {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'forged tail' }] }],
      pinnedPrefix: 0,
      lastActualTokens: 0,
      sessionState: captureSessionState({}),
    },
  };
  appendFileSync(current.path, `${JSON.stringify(legacyTail)}\n`);

  assert.throws(
    () => trustLegacySession(current.path, { bindingsDir }),
    /contains a current-format v2 snapshot/,
  );
});

test('legacy migration rejects oversized workspace logs before buffering them', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-oversized-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = SessionLog.open(join(root, 'workspace'));
  log.close();
  truncateSync(log.path, MAX_LEGACY_SESSION_BYTES + 1);

  assert.throws(
    () => trustLegacySession(log.path, { bindingsDir: join(root, 'bindings') }),
    /legacy session log is too large/,
  );
});

test('snapshot discovery drops an oversized sparse line without buffering it', {
  // Node 22 on Windows can spend longer than the suite deadline traversing this 8 GiB sparse
  // fixture. The same bounded-reader invariant is exercised on POSIX; Windows still runs the
  // authenticated message-allocation cap immediately below without a filesystem stress case.
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-session-snapshot-line-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = SessionLog.open(join(root, 'workspace'));
  log.close();

  // The first sparse record is 8 GiB. The small delta forces both paths under test: the tail
  // scanner finds it, then reconstruction follows baseOffset=0 and must stop at the 64 MiB
  // record cap instead of reading the rest of the sparse hole or growing memory without bound.
  truncateSync(log.path, (8 * 1024 * 1024 * 1024) + 1);
  appendFileSync(log.path, `\n${JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'context_snapshot',
    format: 'delta',
    baseOffset: 0,
    messageCount: 1,
    data: { appended: [{ role: 'user', content: [{ type: 'text', text: 'tail' }] }] },
    turn: 0,
  })}\n`);

  assert.equal(SessionLog.snapshotInfo(log.path).hasSnapshot, true);
  assert.equal(SessionLog.findLatestSnapshotRecord(log.path), null);
});

test('authenticated full snapshots enforce the message-count allocation cap', () => {
  const bytes = Buffer.from(JSON.stringify({
    kind: 'context_snapshot',
    format: 'full',
    data: { messages: new Array(1_000_001).fill(null) },
  }));
  assert.equal(SessionLog.findLatestSnapshotRecordFromBytes(bytes), null);
});

test('owner receipts reject a symlinked binding root', { skip: process.platform === 'win32' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-harness-binding-root-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'real-bindings');
  const alias = join(root, 'binding-link');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, alias, 'dir');
  const savedHarness = harness();
  const log = seed(join(root, 'workspace'), captureSessionState({ harness: savedHarness }));

  assert.throws(
    () => recordSessionHarnessBinding(log.path, savedHarness, { bindingsDir: alias }),
    /session binding root is not a regular directory/,
  );
});
