import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, truncateSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanClaudeSessions,
  importClaudeSession,
  convertClaudeTranscript,
  decodeClaudeProjectDir,
  shadowSessionIdForClaude,
  CLAUDE_MAX_IMPORT_BYTES,
} from '../src/state/claudeImport.js';
import { SessionLog } from '../src/state/session.js';
import { listResumableSessions, resumeSession } from '../src/state/resume.js';
import type { TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from '../src/provider/provider.js';

const CLAUDE_SESSION_ID = '9f3c1a2e-4b5d-4c6e-8f7a-0b1c2d3e4f5a';
const PROJECT_PATH = '/Users/craigmac/shadow-cli';

const opts = { contextBudget: 10_000, triggerRatio: 0.75, keepLastTurns: 4 };

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A realistic Claude Code transcript: user text, thinking+text+tool_use, tool_result,
 * a malformed line, a follow-up user text, an orphan tool_result, an edit, and a close. */
function buildFixture(baseDir: string, sessionId = CLAUDE_SESSION_ID): string {
  const projectDir = join(baseDir, '-Users-craigmac-shadow-cli');
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${sessionId}.jsonl`);
  const lines: Array<string | object> = [
    { type: 'summary', summary: 'Fixing the flaky test', leafUuid: 'leaf-1' },
    {
      type: 'user',
      isMeta: false,
      cwd: PROJECT_PATH,
      sessionId,
      timestamp: '2026-08-20T10:00:00.000Z',
      message: { role: 'user', content: 'Fix the flaky test in test/resume.test.ts' },
      uuid: 'u1',
    },
    {
      type: 'assistant',
      sessionId,
      timestamp: '2026-08-20T10:00:05.000Z',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [
          { type: 'thinking', thinking: 'Let me read the test first.', signature: 'EqQBCkgIBRABGAIiQStale' },
          { type: 'text', text: 'I will read the failing test.' },
          {
            type: 'tool_use',
            id: 'toolu_01read',
            name: 'Read',
            input: { file_path: `${PROJECT_PATH}/test/resume.test.ts` },
          },
        ],
      },
      uuid: 'a1',
    },
    {
      type: 'user',
      sessionId,
      timestamp: '2026-08-20T10:00:06.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01read',
            content: [{ type: 'text', text: '1\timport { test } from ...' }],
            is_error: false,
          },
        ],
      },
      uuid: 'u2',
    },
    '{this line is not json',
    {
      type: 'user',
      sessionId,
      timestamp: '2026-08-20T10:01:00.000Z',
      message: { role: 'user', content: 'Now continue with the fix' },
      uuid: 'u3',
    },
    {
      // orphan: no tool_use with this id ever appeared — must be dropped, not crash
      type: 'user',
      sessionId,
      timestamp: '2026-08-20T10:01:01.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_missing', content: 'orphan', is_error: false }],
      },
      uuid: 'u4',
    },
    {
      type: 'assistant',
      sessionId,
      timestamp: '2026-08-20T10:01:30.000Z',
      message: {
        id: 'msg_2',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Tightening the assertion now.' },
          {
            type: 'tool_use',
            id: 'toolu_02edit',
            name: 'Edit',
            input: { file_path: `${PROJECT_PATH}/test/resume.test.ts`, old_string: 'loose', new_string: 'strict' },
          },
        ],
      },
      uuid: 'a2',
    },
    {
      type: 'user',
      sessionId,
      timestamp: '2026-08-20T10:01:31.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_02edit', content: 'The file was edited.', is_error: false }],
      },
      uuid: 'u5',
    },
    {
      type: 'assistant',
      sessionId,
      timestamp: '2026-08-20T10:02:00.000Z',
      message: { id: 'msg_3', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      uuid: 'a3',
    },
  ];
  writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

test('scanClaudeSessions finds the session with decoded project path, title, and turns', () => {
  const baseDir = tmp('shadow-claude-scan-');
  try {
    buildFixture(baseDir);
    const scan = scanClaudeSessions(baseDir);
    assert.equal(scan.sessions.length, 1);
    assert.deepEqual(scan.warnings, []);
    const s = scan.sessions[0]!;
    assert.equal(s.sessionId, CLAUDE_SESSION_ID);
    assert.equal(s.projectPath, PROJECT_PATH); // from the transcript's own cwd
    assert.equal(s.title, 'Fix the flaky test in test/resume.test.ts');
    assert.equal(s.turns, 3); // assistant responses
    assert.ok(s.sizeBytes > 0 && s.mtimeMs > 0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('scanClaudeSessions falls back to dash-decoding the dir name when no cwd is present', () => {
  const baseDir = tmp('shadow-claude-decode-');
  try {
    const projectDir = join(baseDir, '-Users-craigmac-shadow-cli');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'no-cwd.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n',
    );
    const scan = scanClaudeSessions(baseDir);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0]!.projectPath, decodeClaudeProjectDir('-Users-craigmac-shadow-cli'));
    // best-effort decode: dashes inside a segment are ambiguous
    assert.equal(decodeClaudeProjectDir('-Users-craigmac-shadow-cli'), '/Users/craigmac/shadow/cli');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('scanClaudeSessions warns on a missing baseDir, unparseable files, and caps the listing', () => {
  const missing = scanClaudeSessions(join(tmpdir(), 'shadow-no-such-dir-claude'));
  assert.equal(missing.sessions.length, 0);
  assert.equal(missing.warnings.length, 1);

  const baseDir = tmp('shadow-claude-cap-');
  try {
    const projectDir = join(baseDir, '-tmp-proj');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'garbage.jsonl'), 'not json at all\nstill not json\n');
    for (const id of ['s1', 's2', 's3']) {
      writeFileSync(join(projectDir, `${id}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: id } }) + '\n');
    }
    const scan = scanClaudeSessions(baseDir, { maxListed: 2 });
    assert.equal(scan.sessions.length, 2);
    assert.equal(scan.truncated, true);
    assert.ok(scan.warnings.some((w) => w.includes('unparseable')));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('importClaudeSession produces a Shadow session the existing reader resumes', () => {
  const baseDir = tmp('shadow-claude-src-');
  const ws = tmp('shadow-claude-ws-');
  try {
    const file = buildFixture(baseDir);
    const targetStore = SessionLog.sessionsDir(ws);
    const r = importClaudeSession(file, targetStore);
    assert.equal(r.status, 'imported');
    assert.equal(r.skippedLines, 1); // the malformed line
    assert.equal(r.messageCount, 6);
    const targetBase = `${shadowSessionIdForClaude(CLAUDE_SESSION_ID)}.jsonl`;
    assert.ok(r.targetPath!.endsWith(targetBase));

    // Parseable by Shadow's own reader...
    const events = SessionLog.load(r.targetPath!) as Array<Record<string, unknown>>;
    assert.ok(events.length > 0);
    // ...with replay records for `shadow export`...
    const userRecs = events.filter((e) => e.kind === 'user');
    assert.ok(userRecs.some((e) => String(e.task).includes('Fix the flaky test')));
    const toolStarts = events.filter((e) => e.kind === 'event' && e.type === 'tool_start');
    assert.ok(toolStarts.some((e) => (e.call as { name: string }).name === 'read_file'));
    const toolEnds = events.filter((e) => e.kind === 'event' && e.type === 'tool_end');
    assert.ok(toolEnds.some((e) => (e.result as { ok: boolean }).ok === true));
    // ...and a context_snapshot the resume machinery hydrates.
    const sessions = listResumableSessions(ws);
    const listed = sessions.find((s) => s.id === shadowSessionIdForClaude(CLAUDE_SESSION_ID));
    assert.ok(listed, 'imported session must be listed as resumable');
    assert.ok(listed!.ts, 'snapshot record must carry a ts (filename is not an ISO stamp)');

    const { context, meta } = resumeSession(listed!.path, opts);
    assert.equal(meta.sessionId, shadowSessionIdForClaude(CLAUDE_SESSION_ID));
    const msgs = context.messages();
    assert.equal(msgs.length, 6);
    // Roles alternate (consecutive Claude user records merged).
    assert.deepEqual(
      msgs.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
    );

    // Text kept verbatim.
    assert.equal((msgs[0]!.content[0] as TextBlock).text, 'Fix the flaky test in test/resume.test.ts');

    // Thinking kept as Shadow's native thinking block — but the stale signature is dropped.
    const thinking = msgs[1]!.content[0] as ThinkingBlock;
    assert.equal(thinking.type, 'thinking');
    assert.equal(thinking.thinking, 'Let me read the test first.');
    assert.equal(thinking.signature, '');

    // tool_use normalized through the foreign adapter: Read → read_file with `path`.
    const readCall = msgs[1]!.content.find((b) => b.type === 'tool_use') as ToolUseBlock;
    assert.equal(readCall.name, 'read_file');
    assert.equal((readCall.input as { path: string }).path, `${PROJECT_PATH}/test/resume.test.ts`);

    // tool_result mapped to Shadow's shape.
    const readResult = msgs[2]!.content.find((b) => b.type === 'tool_result') as ToolResultBlock;
    assert.equal(readResult.toolCallId, 'toolu_01read');
    assert.equal(readResult.ok, true);
    assert.match(readResult.content, /import \{ test \}/);
    // The follow-up user text merged into the tool_result turn.
    assert.ok(msgs[2]!.content.some((b) => b.type === 'text' && b.text === 'Now continue with the fix'));

    // Orphan tool_result (toolu_missing) dropped entirely.
    assert.ok(!msgs.some((m) => m.content.some((b) => b.type === 'tool_result' && b.toolCallId === 'toolu_missing')));

    // Edit → edit_file with Shadow's arg names intact.
    const editCall = msgs[3]!.content.find((b) => b.type === 'tool_use') as ToolUseBlock;
    assert.equal(editCall.name, 'edit_file');
    assert.equal((editCall.input as { old_string: string }).old_string, 'loose');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('importClaudeSession dedupes re-imports and never touches the source', () => {
  const baseDir = tmp('shadow-claude-dup-');
  const ws = tmp('shadow-claude-dup-ws-');
  try {
    const file = buildFixture(baseDir);
    const targetStore = SessionLog.sessionsDir(ws);
    const sourceBefore = readFileSync(file, 'utf8');
    const first = importClaudeSession(file, targetStore);
    assert.equal(first.status, 'imported');
    const targetBefore = readFileSync(first.targetPath!, 'utf8');

    const second = importClaudeSession(file, targetStore);
    assert.equal(second.status, 'skipped-duplicate');
    assert.equal(second.targetPath, first.targetPath);
    assert.equal(readFileSync(first.targetPath!, 'utf8'), targetBefore);
    // Source tree is strictly read-only.
    assert.equal(readFileSync(file, 'utf8'), sourceBefore);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('importClaudeSession skips malformed lines without aborting and fails on empty transcripts', () => {
  const baseDir = tmp('shadow-claude-bad-');
  const ws = tmp('shadow-claude-bad-ws-');
  try {
    const projectDir = join(baseDir, '-tmp-proj');
    mkdirSync(projectDir, { recursive: true });
    const mixed = join(projectDir, 'mixed.jsonl');
    writeFileSync(
      mixed,
      [
        '{broken',
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'still works' } }),
        'also broken',
      ].join('\n') + '\n',
    );
    const r = importClaudeSession(mixed, SessionLog.sessionsDir(ws));
    assert.equal(r.status, 'imported');
    assert.equal(r.skippedLines, 2);
    assert.equal(r.messageCount, 1);

    const noise = join(projectDir, 'noise.jsonl'); // summary/system only — nothing convertible
    writeFileSync(noise, JSON.stringify({ type: 'summary', summary: 'x' }) + '\n');
    const r2 = importClaudeSession(noise, SessionLog.sessionsDir(ws));
    assert.equal(r2.status, 'failed');
    assert.match(r2.error!, /no convertible records/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('files over 50 MB are skipped with a warning (scan) and refused (import)', () => {
  const baseDir = tmp('shadow-claude-big-');
  const ws = tmp('shadow-claude-big-ws-');
  try {
    const projectDir = join(baseDir, '-tmp-proj');
    mkdirSync(projectDir, { recursive: true });
    const big = join(projectDir, 'whale.jsonl');
    writeFileSync(big, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
    truncateSync(big, CLAUDE_MAX_IMPORT_BYTES + 1); // sparse: cheap on disk

    const scan = scanClaudeSessions(baseDir);
    assert.equal(scan.sessions.length, 0);
    assert.ok(scan.warnings.some((w) => w.includes('exceeds')));

    const r = importClaudeSession(big, SessionLog.sessionsDir(ws));
    assert.equal(r.status, 'skipped-too-large');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('convertClaudeTranscript is pure and merges same-role runs', () => {
  const { messages, assistantTurns } = convertClaudeTranscript([
    { type: 'user', message: { role: 'user', content: 'a' } },
    { type: 'user', message: { role: 'user', content: 'b' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'c' }] } },
    { type: 'system', subtype: 'local_session_start' }, // noise — dropped
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.content.length, 2);
  assert.equal(assistantTurns, 1);
});
