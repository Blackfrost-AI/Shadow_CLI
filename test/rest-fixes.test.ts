import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { Interface as ReadlineInterface } from 'node:readline/promises';
import { ReplGate } from '../src/replGate.js';
import { raiseAutonomy } from '../src/safety/permissions.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRunShell } from '../src/tools/runShell.js';
import type { ToolContext } from '../src/tools/types.js';
import { Context } from '../src/agent/context.js';
import type { Message, Provider } from '../src/provider/provider.js';
import type { ApprovalRequest } from '../src/agent/approval.js';

// ── ReplGate: a present human gets real y/n/a, not a silent deny ───────────────
function fakeRl(answer: string): ReadlineInterface {
  return { question: async () => answer } as unknown as ReadlineInterface;
}
const REQ: ApprovalRequest = { id: 'ap_test_1', kind: 'permission', call: { id: '1', name: 'run_shell', input: {} }, risk: 'exec', reason: 'r', preview: '$ ls' };

test('ReplGate maps y/n/a to approve/deny/raise-autonomy', async () => {
  assert.equal(await new ReplGate(fakeRl('y'), () => 'full').request(REQ), 'approve');
  assert.equal(await new ReplGate(fakeRl('n'), () => 'full').request(REQ), 'deny');
  assert.equal(await new ReplGate(fakeRl(''), () => 'full').request(REQ), 'deny', 'default is deny');
  let raised = false;
  const a = await new ReplGate(fakeRl('a'), () => {
    raised = true;
    return 'auto-edit';
  }).request(REQ);
  assert.deepEqual(a, { setAutonomy: 'auto-edit' });
  assert.ok(raised, 'always raises autonomy');
});

// ── run_shell honors the configured env allowlist + default timeout ────────────
const ctx = (): ToolContext => ({
  workspaceRoot: tmpdir(),
  signal: new AbortController().signal,
  log: () => {},
  dryRun: false,
});

test('run_shell forwards only allowlisted env vars (secrets withheld)', async (t) => {
  if (process.platform === 'win32') return t.skip('unix env semantics');
  process.env.SHADOW_TEST_KEEP = 'keepme';
  process.env.SHADOW_TEST_SECRET = 'sekret';
  const tool = makeRunShell({ envAllowlist: ['PATH', 'SHADOW_TEST_KEEP'] });
  const res = await tool.run({ command: 'echo "[$SHADOW_TEST_KEEP][$SHADOW_TEST_SECRET]"' }, ctx());
  assert.ok(res.ok, res.summary);
  assert.match(res.data!.stdout, /\[keepme\]/, 'allowlisted var is forwarded');
  assert.match(res.data!.stdout, /\[\]/, 'non-allowlisted secret is withheld');
  delete process.env.SHADOW_TEST_KEEP;
  delete process.env.SHADOW_TEST_SECRET;
});

test('run_shell applies the configured default timeout', async (t) => {
  if (process.platform === 'win32') return t.skip('unix sleep');
  const tool = makeRunShell({ defaultTimeoutMs: 150 });
  const t0 = Date.now();
  const res = await tool.run({ command: 'sleep 5' }, ctx());
  assert.ok(Date.now() - t0 < 2000, 'killed at the 150ms default, not the 60s built-in');
  assert.equal(res.ok, false);
  assert.ok(res.data!.timedOut, 'reported as timed out');
});

// ── Context summarization never leaves an orphaned tool_result ─────────────────
const summarizer: Provider = {
  name: 'fake',
  estimateTokens: () => 10_000, // force the trigger
  async *send() {
    yield { type: 'text', delta: 'condensed' };
    yield { type: 'done', stopReason: 'end_turn' };
  },
} as unknown as Provider;

/** Every tool_result must have an earlier tool_use with the same id. */
function hasOrphanToolResult(msgs: Message[]): boolean {
  const seen = new Set<string>();
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type === 'tool_use') seen.add(b.id);
      if (b.type === 'tool_result' && !seen.has(b.toolCallId)) return true;
    }
  }
  return false;
}

test('summarization advances past tool_result turns (no orphaned tool_result → no provider 400)', async () => {
  const ctxw = new Context({ contextBudget: 100, triggerRatio: 0.75, keepLastTurns: 1 });
  ctxw.pinTask({ role: 'user', content: [{ type: 'text', text: 'task' }] });
  ctxw.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'run_shell', input: {} }] });
  ctxw.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'a', ok: true, content: 'out-a' }] });
  ctxw.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'run_shell', input: {} }] });
  ctxw.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'b', ok: true, content: 'out-b' }] });

  assert.ok(hasOrphanToolResult(ctxw.messages()) === false, 'sanity: intact before summarizing');
  const did = await ctxw.maybeSummarize(summarizer, 'fake');
  assert.ok(did, 'it summarized');
  assert.ok(!hasOrphanToolResult(ctxw.messages()), 'kept region does not begin on an orphaned tool_result');
});

// ── "always" approval raises autonomy, never wraps full→manual ─────────────────
test('raiseAutonomy steps up and clamps at full (never downgrades)', () => {
  assert.equal(raiseAutonomy('manual'), 'auto-read');
  assert.equal(raiseAutonomy('auto-read'), 'auto-edit');
  assert.equal(raiseAutonomy('auto-edit'), 'full');
  assert.equal(raiseAutonomy('full'), 'full', 'clamps — does NOT wrap to manual');
});

// ── piped multi-line stdin must process EVERY line (readline line-loss guard) ──
test('piped multi-line stdin processes every line and exits cleanly', { timeout: 30_000 }, async () => {
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx/esm', entry, '--provider', 'mock'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stdin.write('alpha\nbravo\ncharlie\nexit\n');
  child.stdin.end();
  const code: number = await new Promise((res) => child.on('close', (c) => res(c ?? -1)));
  assert.equal(code, 0, 'clean exit on EOF/exit');
  for (const line of ['alpha', 'bravo', 'charlie']) {
    assert.match(out, new RegExp(`received "${line}"`), `line "${line}" was processed (not dropped)`);
  }
});
