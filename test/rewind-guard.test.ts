import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLog } from '../src/state/session.js';
import { saveCheckpoint, saveCheckpointAbsent } from '../src/state/checkpoints.js';
import { previewRewind, rewindToTurn } from '../src/state/rewind.js';
const HYDRATE = { contextBudget: 1000, triggerRatio: 0.9, keepLastTurns: 4 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shadow-rewind-guard-'));
  const log = SessionLog.open(root);
  log.record({ kind: 'context_snapshot', turn: 0, data: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Fixture task' }] }], pinnedPrefix: 1, lastActualTokens: 0 } });
  const id = SessionLog.sessionIdFromPath(log.path);
  const backup = saveCheckpoint(root, id, 0, 'a.txt', 'original');
  saveCheckpointAbsent(root, id, 0, 'created.txt');
  writeFileSync(join(root, 'a.txt'), 'agent change'); writeFileSync(join(root, 'created.txt'), 'new agent file');
  return { root, log, backup, close: () => { log.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('guarded rewind refuses a human edit before any other restore or deletion', () => {
  const f = fixture();
  try {
    const preview = previewRewind(f.log.path, 0, f.root, 'code');
    writeFileSync(join(f.root, 'a.txt'), 'human change after preview');
    assert.throws(() => rewindToTurn(f.log.path, 0, f.root, { ...HYDRATE, scope: 'code', previewGuardId: preview.guardId }), /File changed since preview/);
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'human change after preview');
    assert.equal(readFileSync(join(f.root, 'created.txt'), 'utf8'), 'new agent file');
  } finally { f.close(); }
});

test('guarded rewind retains current contents including files explicitly deleted by the rewind', () => {
  const f = fixture();
  try {
    const preview = previewRewind(f.log.path, 0, f.root, 'code');
    const result = rewindToTurn(f.log.path, 0, f.root, { ...HYDRATE, scope: 'code', previewGuardId: preview.guardId });
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'original'); assert.equal(existsSync(join(f.root, 'created.txt')), false);
    const backup = JSON.parse(readFileSync(result.safetyBackupPath!, 'utf8'));
    assert.equal(Buffer.from(backup.files.find((item: { path: string }) => item.path === 'a.txt').contentBase64, 'base64').toString(), 'agent change');
    assert.equal(Buffer.from(backup.files.find((item: { path: string }) => item.path === 'created.txt').contentBase64, 'base64').toString(), 'new agent file');
    assert.throws(() => rewindToTurn(f.log.path, 0, f.root, { ...HYDRATE, scope: 'code', previewGuardId: preview.guardId }), /expired/);
  } finally { f.close(); }
});

test('changed checkpoint source or session journal rejects stale approval', () => {
  const f = fixture();
  try {
    const preview = previewRewind(f.log.path, 0, f.root, 'code');
    writeFileSync(f.backup, 'tampered backup');
    assert.throws(() => rewindToTurn(f.log.path, 0, f.root, { ...HYDRATE, scope: 'code', previewGuardId: preview.guardId }), /evidence changed/);
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'agent change');
    const next = previewRewind(f.log.path, 0, f.root, 'chat');
    f.log.record({ kind: 'new_event', message: 'new context while preview open' });
    assert.throws(() => rewindToTurn(f.log.path, 0, f.root, { ...HYDRATE, scope: 'chat', previewGuardId: next.guardId }), /evidence changed/);
  } finally { f.close(); }
});

test('symlink replacement after approval cannot redirect a guarded rewind', { skip: process.platform === 'win32' ? 'File symlinks require Windows developer mode or elevation.' : false }, () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'shadow-rewind-outside-'));
  try {
    writeFileSync(join(outside, 'human.txt'), 'untouched');
    const preview = previewRewind(f.log.path, 0, f.root, 'code');
    unlinkSync(join(f.root, 'a.txt')); symlinkSync(join(outside, 'human.txt'), join(f.root, 'a.txt'));
    assert.throws(() => rewindToTurn(f.log.path, 0, f.root, { ...HYDRATE, scope: 'code', previewGuardId: preview.guardId }), /outside the workspace|symlink/);
    assert.equal(readFileSync(join(outside, 'human.txt'), 'utf8'), 'untouched');
    assert.equal(existsSync(join(f.root, 'created.txt')), true);
  } finally { f.close(); rmSync(outside, { recursive: true, force: true }); }
});
