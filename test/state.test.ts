import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactString, redact } from '../src/util/redact.js';
import { SessionLog } from '../src/state/session.js';
import { ProjectMemory } from '../src/state/memory.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-state-'));
}

// ── redact ────────────────────────────────────────────────────────────────

test('redactString masks sk- keys, Bearer tokens, and KEY=VALUE secrets', () => {
  const sk = redactString('my anthropic key is sk-ant-api03-abcdEFGH1234_zzz, do not log it');
  assert.match(sk, /\[REDACTED\]/);
  assert.doesNotMatch(sk, /sk-ant-api03-abcdEFGH1234/, 'the raw sk- key must be gone');

  const bearer = redactString('Authorization: Bearer abcdEFGH12345678.tok99');
  assert.match(bearer, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(bearer, /abcdEFGH12345678/, 'the raw bearer token must be gone');

  const kv = redactString('run with FOO_API_KEY=secret123 set');
  assert.match(kv, /FOO_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(kv, /secret123/, 'the KEY=VALUE secret must be gone');
});

test('redact masks strings nested in objects and arrays', () => {
  const out = redact({
    note: 'token sk-abcdEFGH123456 leaked',
    list: ['Bearer abcdEFGH1234', { n: 5, t: 'plain text' }],
  });
  assert.equal(out.note, 'token [REDACTED] leaked');
  assert.match(out.list[0] as string, /Bearer \[REDACTED\]/);
  // Non-string values and benign strings survive the deep clone unchanged.
  const nested = out.list[1] as { n: number; t: string };
  assert.equal(nested.n, 5);
  assert.equal(nested.t, 'plain text');
});

// ── SessionLog ──────────────────────────────────────────────────────────────

test('SessionLog records, redacts on disk, and round-trips via load', () => {
  const root = tmp();
  try {
    const log = SessionLog.open(root);
    log.record({ type: 'user_input', text: 'set up the project' });
    log.record({ type: 'tool_result', tool: 'run_shell', out: 'using key sk-secretKEY1234567' });
    log.record({ type: 'final', text: 'done' });
    assert.equal(log.lastError, undefined, 'writes succeeded');

    // The fake secret must never appear on disk; it is replaced by [REDACTED].
    const raw = readFileSync(log.path, 'utf8');
    assert.doesNotMatch(raw, /sk-secretKEY1234567/, 'secret must be redacted on disk');
    assert.match(raw, /\[REDACTED\]/);

    // load() reconstructs the events in order, with the injected ts.
    const events = SessionLog.load(log.path) as Array<Record<string, unknown>>;
    assert.equal(events.length, 3);
    assert.equal(events[0]!.type, 'user_input');
    assert.equal(events[0]!.text, 'set up the project');
    assert.equal(events[2]!.type, 'final');
    assert.equal(typeof events[0]!.ts, 'string');
    assert.equal((events[1]!.out as string).includes('[REDACTED]'), true);

    // list() finds the freshly opened session.
    assert.ok(SessionLog.list(root).includes(log.path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── ProjectMemory ─────────────────────────────────────────────────────────

test('ProjectMemory set/get/delete persists across a fresh load', () => {
  const root = tmp();
  try {
    const mem = ProjectMemory.load(root);
    assert.equal(mem.get('build'), undefined, 'starts empty');
    assert.equal(mem.asContext(), '', 'empty store renders no context');

    mem.set('build', 'npm run build');
    mem.set('test', 'npm test');
    assert.equal(mem.get('build'), 'npm run build');

    // A fresh load from the same dir sees the persisted facts.
    const reloaded = ProjectMemory.load(root);
    assert.equal(reloaded.get('build'), 'npm run build');
    assert.equal(reloaded.get('test'), 'npm test');
    assert.deepEqual(reloaded.all(), { build: 'npm run build', test: 'npm test' });
    assert.match(reloaded.asContext(), /- \*\*build\*\*: npm run build/);

    // delete reports existence and persists.
    assert.equal(reloaded.delete('build'), true);
    assert.equal(reloaded.delete('missing'), false);
    const afterDelete = ProjectMemory.load(root);
    assert.equal(afterDelete.get('build'), undefined, 'delete persisted');
    assert.equal(afterDelete.get('test'), 'npm test', 'other facts survive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
