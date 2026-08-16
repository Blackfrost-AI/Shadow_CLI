import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeToolChoiceUnsupported, setToolChoiceNone } from '../src/provider/stream.js';
import { buildOpenAIBody, OpenAIProvider } from '../src/provider/openai.js';
import { providerErrorHint } from '../src/util/errorHints.js';
import type { CompletionRequest, ProviderEvent } from '../src/provider/provider.js';

// F11-01 — a self-hosted vLLM/SGLang serve started WITHOUT --enable-auto-tool-choice /
// --tool-call-parser rejects `tool_choice: "auto"` with a 400. Shadow must retry once with
// "none" (tools stay rendered; a tool-trained model emits calls as text that Shadow recovers)
// instead of dying on turn 1, and remember the limitation for the session.

const REAL_400 = '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set';

test('looksLikeToolChoiceUnsupported matches the real vLLM 400 (and not unrelated 400s)', () => {
  assert.ok(looksLikeToolChoiceUnsupported(REAL_400));
  assert.ok(looksLikeToolChoiceUnsupported('tool_choice "auto" is not supported by this server'));
  assert.equal(looksLikeToolChoiceUnsupported('max_tokens exceeds context window'), false);
  assert.equal(looksLikeToolChoiceUnsupported('unknown model'), false);
});

test('setToolChoiceNone downgrades auto→none, leaves tools attached, and is idempotent', () => {
  const body: Record<string, unknown> = { tools: [{ type: 'function' }], tool_choice: 'auto' };
  assert.equal(setToolChoiceNone(body), true);
  assert.equal(body.tool_choice, 'none');
  assert.ok(Array.isArray(body.tools), 'tools stay attached so the chat template still renders them');
  assert.equal(setToolChoiceNone(body), false, 'already none → no-op');
  assert.equal(setToolChoiceNone({}), false, 'no tools/tool_choice → nothing to do');
});

test('buildOpenAIBody emits tool_choice:"none" when the endpoint is known to reject auto', () => {
  const req: CompletionRequest = {
    model: 'qwen', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'echo', description: 'e', parameters: { type: 'object' } }], maxOutputTokens: 64,
  };
  assert.equal(buildOpenAIBody(req, 'qwen', true).tool_choice, 'auto', 'default is auto');
  assert.equal(buildOpenAIBody(req, 'qwen', true, { toolChoiceNone: true }).tool_choice, 'none');
});

test('the provider retries a tool_choice 400 with "none" and then remembers it (no second 400)', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    // First request (tool_choice:auto) → the real vLLM 400. Any "none" request → a clean stream.
    if (body.tool_choice === 'auto') {
      return new Response(JSON.stringify({ error: { message: REAL_400 } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ model: 'qwen', baseUrl: 'http://10.0.0.9:8001/v1', selfHosted: true });
    const req: CompletionRequest = {
      model: 'qwen', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'echo', description: 'e', parameters: { type: 'object' } }], maxOutputTokens: 64,
    };
    const drain = async () => { const out: ProviderEvent[] = []; for await (const e of provider.send(req)) out.push(e); return out; };

    const turn1 = await drain();
    // Turn 1: auto 400 → retry none → success. No terminal error surfaced.
    assert.equal(bodies[0]!.tool_choice, 'auto');
    assert.equal(bodies[1]!.tool_choice, 'none', 'retried with none');
    assert.ok(!turn1.some((e) => e.type === 'error' && !e.recoverable), 'no terminal error — the run continues');
    assert.ok(turn1.some((e) => e.type === 'text'), 'content streamed after the fallback');

    // Turn 2: the endpoint limitation is remembered → builds with none directly, NO wasted 400.
    bodies.length = 0;
    await drain();
    assert.equal(bodies.length, 1, 'exactly one request on turn 2 (no 400+retry)');
    assert.equal(bodies[0]!.tool_choice, 'none', 'turn 2 builds with none directly');
  } finally {
    globalThis.fetch = orig;
  }
});

test('the error hint names the vLLM tool-parser flags for this 400', () => {
  const hint = providerErrorHint(`http_400: ${REAL_400}`);
  assert.ok(hint, 'a hint is produced');
  assert.match(hint!, /enable-auto-tool-choice/);
  assert.match(hint!, /tool-call-parser/);
});
