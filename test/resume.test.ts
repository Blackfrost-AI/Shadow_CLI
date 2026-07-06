import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../src/agent/context.js';
import { SessionLog } from '../src/state/session.js';
import { serializeContext, hydrateContext } from '../src/state/snapshot.js';
import { listResumableSessions, resumeSession } from '../src/state/resume.js';
import { rewindToTurn } from '../src/state/rewind.js';
import { saveCheckpoint } from '../src/state/checkpoints.js';

const opts = { contextBudget: 10_000, triggerRatio: 0.75, keepLastTurns: 4 };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-resume-'));
}

test('serializeContext and hydrateContext round-trip messages', () => {
  const ctx = new Context(opts);
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'task' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });
  const data = serializeContext(ctx);
  const restored = hydrateContext(data, opts);
  assert.equal(restored.messages().length, 2);
  assert.equal(restored.messages()[1]!.content[0]!.type, 'text');
});

test('resumeSession hydrates from latest context_snapshot', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const ctx = new Context(opts);
    ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    log.recordSnapshot(ctx, 0);

    const sessions = listResumableSessions(root);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.id, SessionLog.sessionIdFromPath(log.path));

    const { context, meta } = resumeSession(log.path, opts);
    assert.equal(meta.sessionId, sessions[0]!.id);
    assert.equal(context.messages().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rewindToTurn restores context and checkpointed files', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const sessionId = SessionLog.sessionIdFromPath(log.path);

    const ctx0 = new Context(opts);
    ctx0.pinTask({ role: 'user', content: [{ type: 'text', text: 't0' }] });
    log.recordSnapshot(ctx0, 0);
    saveCheckpoint(root, sessionId, 0, 'file.txt', 'original');

    const ctx1 = new Context(opts);
    ctx1.pinTask({ role: 'user', content: [{ type: 'text', text: 't1' }] });
    ctx1.append({ role: 'assistant', content: [{ type: 'text', text: 'a1' }] });
    log.recordSnapshot(ctx1, 1);

    const { context, restoredFiles, turn } = rewindToTurn(log.path, 0, root, opts);
    assert.equal(turn, 0);
    assert.equal(context.messages().length, 1);
    assert.deepEqual(restoredFiles, ['file.txt']);
    const body = readFileSync(join(root, 'file.txt'), 'utf8');
    assert.equal(body, 'original');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subAgentTasks roundtrips through serialize + resumeSession (observable after bg launch)', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    const mainCtx = new Context(opts);
    mainCtx.pinTask({ role: 'user', content: [{ type: 'text', text: 'start' }] });
    // simulate what listener does on bg_agent_launched
    const tasks = (mainCtx as any)._subAgentTasks || ((mainCtx as any)._subAgentTasks = []);
    tasks.push({ taskId: 'bg1', prompt: 'do thing', subagentType: 'explore', ts: new Date().toISOString() });
    log.recordSnapshot(mainCtx, 0);

    const { context, meta } = resumeSession(log.path, opts);
    assert.ok(meta.subAgentTasks && meta.subAgentTasks.length === 1);
    assert.equal((context as any)._subAgentTasks.length, 1);
    assert.equal((context as any)._subAgentTasks[0].taskId, 'bg1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});