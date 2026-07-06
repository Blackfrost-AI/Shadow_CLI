import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/provider/mock.js';
import type { Message, ProviderEvent } from '../src/provider/provider.js';
import { runModelCheck, formatModelCheckReport } from '../src/doctor/modelCheck.js';

// ── Helpers to script a mock model by what the probe asked ────────────────────
function userText(messages: Message[]): string {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' '))
    .join(' ');
}
function hasToolResult(messages: Message[]): boolean {
  return messages.some((m) => m.content.some((b) => b.type === 'tool_result'));
}
function toolTurn(id: string, name: string, input: unknown): ProviderEvent[] {
  return [
    { type: 'tool_call', call: { id, name, input } },
    { type: 'usage', inputTokens: 5, outputTokens: 3 },
    { type: 'done', stopReason: 'tool_use' },
  ];
}
function textTurn(text: string): ProviderEvent[] {
  return [
    { type: 'text', delta: text },
    { type: 'usage', inputTokens: 5, outputTokens: 3 },
    { type: 'done', stopReason: 'end_turn' },
  ];
}

interface Behavior {
  toolCall: 'native' | 'prose';
  fileEdit: 'good' | 'none';
  recovery: 'adapt' | 'repeat' | 'none';
  autonomous: 'complete' | 'noop' | 'loop';
}

/** One stateless function-turn mock; replays per send and branches on the probe prompt. */
function makeMock(b: Behavior): MockProvider {
  return new MockProvider(
    [
      (messages: Message[]) => {
        const txt = userText(messages);
        const tr = hasToolResult(messages);

        // Probe 1: tool-call emission.
        if (txt.includes('ping')) {
          return b.toolCall === 'native'
            ? toolTurn('p1', 'ping', { message: 'hello' })
            : textTurn('I would call ping with {"message":"hello"} but here it is in prose.');
        }
        // Probe 3: file edit.
        if (txt.includes('hello.txt')) {
          return b.fileEdit === 'good'
            ? toolTurn('p3', 'write_file', { path: 'hello.txt', content: 'SHADOW_OK' })
            : textTurn('Sure, the file would contain SHADOW_OK.');
        }
        // Probe 4: error recovery (notes.txt does not exist).
        if (txt.includes('notes.txt')) {
          if (!tr) {
            return b.toolCall === 'native'
              ? toolTurn('p4a', 'read_file', { path: 'notes.txt' })
              : textTurn('I cannot read it.');
          }
          if (b.recovery === 'adapt') return toolTurn('p4b', 'read_file', { path: 'README.md' });
          if (b.recovery === 'repeat') return toolTurn('p4b', 'read_file', { path: 'notes.txt' });
          return textTurn('The file does not exist; I give up.');
        }
        // Probe 5: autonomous read -> edit on greeting.txt.
        if (txt.includes('greeting.txt')) {
          if (b.autonomous === 'noop') return textTurn('I would change world to shadow.');
          if (!tr) return toolTurn('p5read', 'read_file', { path: 'greeting.txt' });
          if (b.autonomous === 'loop') {
            // Never matches -> edit_file fails every turn; proves the loop is bounded.
            return toolTurn('p5edit', 'edit_file', { path: 'greeting.txt', old_string: 'planet', new_string: 'shadow' });
          }
          return toolTurn('p5edit', 'edit_file', { path: 'greeting.txt', old_string: 'world', new_string: 'shadow' });
        }
        return textTurn('done');
      },
    ],
    true,
  );
}

const FAST = { perTurnTimeoutMs: 2000, maxAutonomousTurns: 3 };

test('good tool-calling model -> Agentic, all probes pass', async () => {
  const provider = makeMock({ toolCall: 'native', fileEdit: 'good', recovery: 'adapt', autonomous: 'complete' });
  const r = await runModelCheck(provider, { model: 'good-mock', providerName: 'mock', ...FAST });
  assert.equal(r.verdict, 'agentic');
  assert.ok(r.probes.every((p) => p.status === 'pass'), `expected all pass, got ${JSON.stringify(r.probes)}`);
  assert.equal(r.probes.length, 5);
});

test('prose-only model -> Chat-only, no valid tool call', async () => {
  const provider = makeMock({ toolCall: 'prose', fileEdit: 'none', recovery: 'none', autonomous: 'noop' });
  const r = await runModelCheck(provider, { model: 'chat-mock', providerName: 'mock', ...FAST });
  assert.equal(r.verdict, 'chat-only');
  assert.ok(r.probes.every((p) => p.status === 'fail'));
  // The format probe should observe the prose-pasted call.
  const fmt = r.probes.find((p) => p.id === 'format')!;
  assert.match(fmt.detail, /prose|wire format/i);
});

test('partial model (tool calls but fails recovery) -> Limited', async () => {
  const provider = makeMock({ toolCall: 'native', fileEdit: 'good', recovery: 'repeat', autonomous: 'complete' });
  const r = await runModelCheck(provider, { model: 'limited-mock', providerName: 'mock', ...FAST });
  assert.equal(r.verdict, 'limited');
  assert.equal(r.probes.find((p) => p.id === 'tool_call')!.status, 'pass');
  assert.equal(r.probes.find((p) => p.id === 'file_edit')!.status, 'pass');
  assert.equal(r.probes.find((p) => p.id === 'error_recovery')!.status, 'fail');
  assert.match(r.probes.find((p) => p.id === 'error_recovery')!.detail, /repeated/i);
});

test('partial model (tool calls but no edit) -> Limited', async () => {
  const provider = makeMock({ toolCall: 'native', fileEdit: 'none', recovery: 'adapt', autonomous: 'noop' });
  const r = await runModelCheck(provider, { model: 'limited2-mock', providerName: 'mock', ...FAST });
  assert.equal(r.verdict, 'limited');
  assert.equal(r.probes.find((p) => p.id === 'file_edit')!.status, 'fail');
});

test('looping model is bounded by maxAutonomousTurns and still returns', async () => {
  const provider = makeMock({ toolCall: 'native', fileEdit: 'good', recovery: 'adapt', autonomous: 'loop' });
  const r = await runModelCheck(provider, { model: 'loop-mock', providerName: 'mock', perTurnTimeoutMs: 2000, maxAutonomousTurns: 3 });
  // It emitted valid calls but never completed the edit -> Limited, not hung.
  assert.equal(r.verdict, 'limited');
  assert.equal(r.probes.find((p) => p.id === 'autonomous')!.status, 'fail');
});

test('local gguf recommendation mentions ctx/gpu-layers for non-agentic verdicts', async () => {
  const provider = makeMock({ toolCall: 'prose', fileEdit: 'none', recovery: 'none', autonomous: 'noop' });
  const r = await runModelCheck(provider, { model: 'local-mock', providerName: 'mock', isLocal: true, ...FAST });
  assert.equal(r.isLocal, true);
  assert.match(r.recommendation, /--ctx|--gpu-layers/);
});

test('formatModelCheckReport renders probes, verdict, and recommendation', async () => {
  const provider = makeMock({ toolCall: 'native', fileEdit: 'good', recovery: 'adapt', autonomous: 'complete' });
  const r = await runModelCheck(provider, { model: 'good-mock', providerName: 'mock', ...FAST });
  const out = formatModelCheckReport(r); // no colors -> plain text
  assert.match(out, /shadow model check — mock\/good-mock/);
  assert.match(out, /Tool-call emission/);
  assert.match(out, /Verdict: AGENTIC/);
  assert.match(out, /Ready for autonomous coding/);
  assert.ok(out.includes('✓'));
});
