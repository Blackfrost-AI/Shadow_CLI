import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseAssembler, sseEvents, parseSseData, nonEmptyParts } from '../src/provider/sse.js';
import {
  streamWithRetry,
  rejectedParamsInMessage,
  looksLikeParamValueError,
  stripParamFromBody,
  STRIPPABLE_PARAMS,
} from '../src/provider/stream.js';
import { buildOpenAIBody, OpenAIProvider, parseOpenAISSE } from '../src/provider/openai.js';
import { parseAnthropicSSE } from '../src/provider/anthropic.js';
import { parseResponsesSSE, ResponsesProvider } from '../src/provider/responses.js';
import { parseSseResult } from '../src/mcp/client.js';
import type { CompletionRequest, ProviderEvent } from '../src/provider/provider.js';

// P2-03 — provider robustness ladder:
//  (F01-05) a 400 naming an optional request param retries once with the param stripped and
//           remembers it for the session (imagesStripped pattern, generalizing F11-01);
//  (F01-08) SSE events whose data field spans multiple `data:` lines parse as one unit
//           (WHATWG-spec reassembly) with a per-line defensive fallback for non-conforming
//           servers that skip the blank separator.

// ── helpers ──────────────────────────────────────────────────────────────────

async function* linesFrom(text: string): AsyncIterable<string> {
  for (const l of text.split('\n')) yield l;
}
async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const texts = (evs: ProviderEvent[]): string =>
  evs.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
// ── A. the assembler (unit) ──────────────────────────────────────────────────

test('SseAssembler reassembles multi-line data frames and dispatches EAGERLY on completion', () => {
  const asm = new SseAssembler();
  assert.deepEqual(asm.feed('data: {"a":'), [], 'a partial frame accumulates');
  const dispatched = asm.feed('data: 1}');
  assert.equal(dispatched.length, 1, 'the frame ships the moment it parses (no wait for blank)');
  const ev = dispatched[0]!;
  assert.equal(ev.kind, 'data');
  if (ev.kind === 'data') {
    assert.equal(ev.data, '{"a":\n1}');
    assert.deepEqual(ev.parts, ['{"a":', '1}']);
  }
  assert.deepEqual(
    asm.feed('').map((e) => e.kind),
    ['other'],
    'the blank line now passes through alone',
  );
});

test('SseAssembler flushes a trailing event when the final blank line is omitted', () => {
  const asm = new SseAssembler();
  assert.deepEqual(asm.feed('data: x'), []);
  const flushed = asm.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.kind, 'data');
  assert.deepEqual(asm.flush(), [], 'flush is idempotent');
});

test('SseAssembler strips one leading space after the colon and the CR of CRLF', () => {
  const asm = new SseAssembler();
  asm.feed('data:  double-spaced\r'); // two spaces: one is syntax, one is content
  const [ev] = asm.flush();
  assert.equal(ev!.kind, 'data');
  if (ev!.kind === 'data') assert.equal(ev!.data, ' double-spaced');
});

test('SseAssembler passes comments/fields through as other and bounds acc on them', () => {
  const asm = new SseAssembler();
  const out = [...asm.feed(': keepalive'), ...asm.feed('event: foo')];
  assert.deepEqual(
    out.map((e) => e.kind),
    ['other', 'other'],
  );
  // a field line after data lines dispatches the accumulating event early (documented simplification)
  const asm2 = new SseAssembler();
  asm2.feed('data: a');
  const mid = asm2.feed('id: 7');
  assert.equal(mid[0]!.kind, 'data');
  assert.equal(mid[1]!.kind, 'other');
});

test('sseEvents wraps an async line stream end-to-end', async () => {
  const events = [];
  for await (const ev of sseEvents(linesFrom('data: one\n\ndata: two'))) events.push(ev);
  const datas = events.filter((e) => e.kind === 'data');
  assert.deepEqual(datas.map((d) => (d as { data: string }).data), ['one', 'two']);
});

test('parseSseData parses the joined multi-line document, falls back per line, else empty', () => {
  // spec-compliant: one document split across lines parses joined
  assert.deepEqual(parseSseData('{"a":\n1}', ['{"a":', '1}']), [{ a: 1 }]);
  // non-conforming: two packed events parse per line
  assert.deepEqual(parseSseData('{"a":1}\n{"b":2}', ['{"a":1}', '{"b":2}']), [{ a: 1 }, { b: 2 }]);
  // garbage: nothing
  assert.deepEqual(parseSseData('ping', ['ping']), []);
  // mixed: one JSON + one junk line → the JSON survives the fallback
  assert.deepEqual(parseSseData('{"a":1}\nping', ['{"a":1}', 'ping']), [{ a: 1 }]);
});

test('nonEmptyParts drops whitespace-only entries', () => {
  assert.deepEqual(nonEmptyParts(['a', '  ', '', 'b']), ['a', 'b']);
});

// ── B. parsers consume multi-line frames (F01-08 acceptance) ─────────────────

test('parseOpenAISSE parses a spec-compliant multi-line data frame (pretty-printed JSON)', async () => {
  const stream = 'data: {"choices":[{"delta":\n' + 'data: {"content":"hello"}}]}\n' + '\n' + 'data: [DONE]\n\n';
  const evs = await collect(parseOpenAISSE(linesFrom(stream), 'test-model'));
  assert.equal(texts(evs), 'hello');
});

test('parseOpenAISSE still parses NON-conforming back-to-back events with no blank separator', async () => {
  const stream =
    'data: {"choices":[{"delta":{"content":"a"}}]}\n' +
    'data: {"choices":[{"delta":{"content":"b"}}]}\n' +
    'data: [DONE]\n\n';
  const evs = await collect(parseOpenAISSE(linesFrom(stream), 'test-model'));
  assert.equal(texts(evs), 'ab', 'both packed events recovered via the per-line fallback');
});

test('parseOpenAISSE ignores keepalive comments between events', async () => {
  const stream =
    ': keepalive\n\n' +
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
    ': ping\n\n' +
    'data: [DONE]\n\n';
  const evs = await collect(parseOpenAISSE(linesFrom(stream), 'test-model'));
  assert.equal(texts(evs), 'ok');
});

test('parseAnthropicSSE parses a multi-line content_block_delta', async () => {
  const stream =
    'data: {"type":"content_block_delta","index":0,\n' +
    'data: "delta":{"type":"text_delta","text":"hi"}}\n' +
    '\n' +
    'data: {"type":"message_stop"}\n\n';
  const evs = await collect(parseAnthropicSSE(linesFrom(stream)));
  assert.equal(texts(evs), 'hi');
});

test('parseSseResult (MCP Streamable HTTP) reassembles a multi-line JSON-RPC result', () => {
  const body = 'data: {"jsonrpc":"2.0","id":1,\ndata: "result":{"tools":["a"]}}\n\n';
  assert.deepEqual(parseSseResult(body), { tools: ['a'] });
});

// ── C. 400 param-strip ladder helpers (F01-05) ───────────────────────────────

test('STRIPPABLE_PARAMS is exactly the documented ladder set', () => {
  assert.deepEqual([...STRIPPABLE_PARAMS], ['stream_options', 'tool_choice', 'temperature']);
});

test('rejectedParamsInMessage reads the named params out of real-world 400 shapes', () => {
  assert.deepEqual(rejectedParamsInMessage("Unsupported parameter: 'stream_options'"), ['stream_options']);
  assert.deepEqual(rejectedParamsInMessage('Unknown parameter: stream_options'), ['stream_options']);
  assert.deepEqual(rejectedParamsInMessage('unknown parameter: tool_choice'), ['tool_choice']);
  assert.deepEqual(rejectedParamsInMessage('temperature is not supported for this model'), ['temperature']);
  // a gateway policy banner naming several params returns them ALL, in ladder order
  assert.deepEqual(
    rejectedParamsInMessage('bad request: stream_options, tool_choice and temperature are rejected'),
    ['stream_options', 'tool_choice', 'temperature'],
  );
  // NOT ladder business: token overflow has its own shrink ladder; generic errors strip nothing
  assert.deepEqual(rejectedParamsInMessage('max_tokens exceeds the context window'), []);
  assert.deepEqual(rejectedParamsInMessage('invalid model id'), []);
  assert.deepEqual(rejectedParamsInMessage(''), []);
});

test('looksLikeParamValueError separates value errors from field rejections', () => {
  // value errors stay TERMINAL — the user's knob must not be silently voided for the session
  assert.equal(looksLikeParamValueError('temperature 0.2 is below the minimum supported value of 0.5'), true);
  assert.equal(looksLikeParamValueError('temperature must be <= 2, got 5'), true);
  assert.equal(looksLikeParamValueError('temperature is out of range for this model'), true);
  assert.equal(looksLikeParamValueError('stream_options value must be an object'), true);
  // field rejections strip
  assert.equal(looksLikeParamValueError("Unsupported parameter: 'stream_options'"), false);
  assert.equal(looksLikeParamValueError('Unknown parameter: tool_choice'), false);
  assert.equal(looksLikeParamValueError('temperature is not supported for this model'), false);
  assert.equal(looksLikeParamValueError(''), false);
});

test('stripParamFromBody deletes a present param and reports it', () => {
  const body: Record<string, unknown> = { stream_options: { include_usage: true }, temperature: 1.0 };
  assert.equal(stripParamFromBody(body, 'stream_options'), true);
  assert.equal('stream_options' in body, false);
  assert.equal(stripParamFromBody(body, 'stream_options'), false, 'already gone → no-op');
  assert.equal(stripParamFromBody(null, 'temperature'), false);
});

// ── D. ladder integration (streamWithRetry + stubbed fetch) ──────────────────

const CLEAN_STREAM =
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n';

interface LadderCase {
  param: string;
  message400: string;
  body: Record<string, unknown>;
}

const LADDER_CASES: LadderCase[] = [
  {
    param: 'stream_options',
    message400: "Unsupported parameter: 'stream_options'",
    body: { model: 'm', messages: [], stream: true, stream_options: { include_usage: true } },
  },
  {
    param: 'tool_choice',
    // a server that rejects the FIELD itself (not just "auto") — the specialized none handler
    // does not match this shape, so the generic strip must carry it
    message400: 'Unknown parameter: tool_choice',
    body: {
      model: 'm',
      messages: [],
      stream: true,
      tools: [{ type: 'function', function: { name: 'echo' } }],
      tool_choice: 'auto',
    },
  },
  {
    param: 'temperature',
    message400: 'temperature is not supported for this model',
    body: { model: 'm', messages: [], stream: true, temperature: 1.0 },
  },
];

for (const c of LADDER_CASES) {
  test(`400 ladder strips ${c.param} when the message names it, then streams`, async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const stripped: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (c.param in body) {
        return new Response(JSON.stringify({ error: { message: c.message400 } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(CLEAN_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    try {
      const events: ProviderEvent[] = [];
      for await (const e of streamWithRetry({
        url: 'http://10.0.0.9:8001/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
        body: structuredClone(c.body),
        parse: (lines) => parseOpenAISSE(lines, 'test-model'),
        onParamStripped: (p) => stripped.push(p),
      })) {
        events.push(e);
      }
      assert.equal(bodies.length, 2, 'exactly one retry');
      assert.ok(c.param in bodies[0]!, 'first attempt sent the param');
      assert.equal(c.param in bodies[1]!, false, 'retry sent without the param');
      assert.deepEqual(stripped, [c.param], 'provider told exactly once');
      assert.ok(!events.some((e) => e.type === 'error' && !e.recoverable), 'no terminal error');
      assert.ok(events.some((e) => e.type === 'text'), 'content streamed after the strip');
    } finally {
      globalThis.fetch = orig;
    }
  });
}

test('400 ladder walks multiple rejected params one 400 at a time', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const stripped: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if ('stream_options' in body) {
      return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'stream_options'" } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    if ('temperature' in body) {
      return new Response(JSON.stringify({ error: { message: 'Unknown parameter: temperature' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(CLEAN_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const events: ProviderEvent[] = [];
    for await (const e of streamWithRetry({
      url: 'http://10.0.0.9:8001/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'm', messages: [], stream: true, stream_options: { include_usage: true }, temperature: 1.0 },
      parse: (lines) => parseOpenAISSE(lines, 'test-model'),
      onParamStripped: (p) => stripped.push(p),
    })) {
      events.push(e);
    }
    assert.equal(bodies.length, 3, 'two 400s walked, third request clean');
    assert.deepEqual(stripped, ['stream_options', 'temperature']);
    assert.ok(events.some((e) => e.type === 'text'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('a 400 naming nothing strippable stays terminal (no blind strip)', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const stripped: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ error: { message: 'invalid frobnicator value' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const events: ProviderEvent[] = [];
    for await (const e of streamWithRetry({
      url: 'http://10.0.0.9:8001/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'm', messages: [], stream: true, stream_options: { include_usage: true } },
      parse: (lines) => parseOpenAISSE(lines, 'test-model'),
      onParamStripped: (p) => stripped.push(p),
    })) {
      events.push(e);
    }
    assert.equal(bodies.length, 1, 'no retry for an unattributable 400');
    assert.deepEqual(stripped, []);
    const err = events.find((e) => e.type === 'error') as { recoverable: boolean; code: string } | undefined;
    assert.ok(err && err.recoverable === false && err.code === 'http_400');
  } finally {
    globalThis.fetch = orig;
  }
});

// ── E. session memory (no repeat 400s — F01-05 acceptance) ───────────────────

const baseReq: CompletionRequest = {
  model: 'qwen',
  system: 's',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'echo', description: 'e', parameters: { type: 'object' } }],
  maxOutputTokens: 64,
};

test('buildOpenAIBody strips remembered-rejected params LAST (wins over every emitter)', () => {
  const body = buildOpenAIBody(baseReq, 'qwen', true, {
    selfHosted: true,
    stripParams: new Set(['stream_options', 'temperature', 'tool_choice']),
  });
  assert.equal('stream_options' in body, false, 'stream emitter output removed');
  assert.equal('temperature' in body, false, 'self-hosted temperature emitter output removed');
  assert.equal('tool_choice' in body, false, 'tools emitter output removed');
  assert.ok(Array.isArray(body.tools), 'tools themselves stay attached');
});

for (const param of ['stream_options', 'temperature']) {
  test(`OpenAIProvider remembers a ${param} rejection for the session (no repeat 400)`, async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (param in body) {
        return new Response(JSON.stringify({ error: { message: `Unknown parameter: ${param}` } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(CLEAN_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    try {
      const provider = new OpenAIProvider({ model: 'qwen', baseUrl: 'http://10.0.0.9:8001/v1', selfHosted: true });
      const drain = async () => {
        const out: ProviderEvent[] = [];
        for await (const e of provider.send(baseReq)) out.push(e);
        return out;
      };

      const turn1 = await drain();
      assert.ok(param in bodies[0]!, 'turn 1 sent the param');
      assert.equal(param in bodies[1]!, false, 'turn 1 retried without it');
      assert.ok(!turn1.some((e) => e.type === 'error' && !e.recoverable), 'run continued');

      bodies.length = 0;
      await drain();
      assert.equal(bodies.length, 1, 'turn 2: exactly one request — the 400 is not paid again');
      assert.equal(param in bodies[0]!, false, 'turn 2 builds without the param directly');
    } finally {
      globalThis.fetch = orig;
    }
  });
}

// ── F. ladder hardening (adversarial-review fixes) ──────────────────────────

test('a 400 that is a VALUE error stays terminal (no silent re-default of the knob)', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const stripped: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ error: { message: 'temperature 0.2 is below the minimum supported value of 0.5' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const events: ProviderEvent[] = [];
    for await (const e of streamWithRetry({
      url: 'http://10.0.0.9:8001/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'm', messages: [], stream: true, temperature: 0.2 },
      parse: (lines) => parseOpenAISSE(lines, 'test-model'),
      onParamStripped: (p) => stripped.push(p),
    })) {
      events.push(e);
    }
    assert.equal(bodies.length, 1, 'no strip for a value error — it stays terminal');
    assert.deepEqual(stripped, []);
    const err = events.find((e) => e.type === 'error') as { recoverable: boolean; code: string } | undefined;
    assert.ok(err && err.recoverable === false && err.code === 'http_400', 'server words surfaced verbatim');
  } finally {
    globalThis.fetch = orig;
  }
});

test('a banner naming an ABSENT param first skips it and strips the present one', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const stripped: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if ('temperature' in body) {
      return new Response(
        JSON.stringify({ error: { message: 'rejected: stream_options and temperature are unsupported' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(CLEAN_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const events: ProviderEvent[] = [];
    for await (const e of streamWithRetry({
      url: 'http://10.0.0.9:8001/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'm', messages: [], stream: true, temperature: 1.0 },
      parse: (lines) => parseOpenAISSE(lines, 'test-model'),
      onParamStripped: (p) => stripped.push(p),
    })) {
      events.push(e);
    }
    assert.equal(bodies.length, 2, 'one retry');
    assert.deepEqual(stripped, ['temperature'], 'stream_options skipped (absent), temperature stripped');
    assert.ok(events.some((e) => e.type === 'text'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('a server naming ALL params every 400 walks one strip per attempt', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const stripped: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if ('stream_options' in body || 'tool_choice' in body || 'temperature' in body) {
      return new Response(
        JSON.stringify({ error: { message: 'stream_options, tool_choice, temperature all rejected' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(CLEAN_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const events: ProviderEvent[] = [];
    for await (const e of streamWithRetry({
      url: 'http://10.0.0.9:8001/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: 'm',
        messages: [],
        stream: true,
        stream_options: { include_usage: true },
        tools: [{ type: 'function', function: { name: 'echo' } }],
        tool_choice: 'auto',
        temperature: 1.0,
      },
      parse: (lines) => parseOpenAISSE(lines, 'test-model'),
      onParamStripped: (p) => stripped.push(p),
    })) {
      events.push(e);
    }
    assert.equal(bodies.length, 4, 'three strips walked, fourth request clean');
    assert.deepEqual(stripped, ['stream_options', 'tool_choice', 'temperature']);
    assert.ok(events.some((e) => e.type === 'text'));
  } finally {
    globalThis.fetch = orig;
  }
});

// ── G. Responses wire (F01-08 frame + F01-05 session-memory parity) ─────────

const RESPONSES_CLEAN_STREAM =
  'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
  'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n' +
  'data: [DONE]\n\n';

test('parseResponsesSSE parses a multi-line data frame (F01-08 on the fourth parser)', async () => {
  const stream =
    'data: {"type":"response.output_text.delta",\n' +
    'data: "delta":"hi"}\n' +
    '\n' +
    'data: [DONE]\n\n';
  const evs = await collect(parseResponsesSSE(linesFrom(stream)));
  assert.equal(texts(evs), 'hi');
});

test('ResponsesProvider remembers a temperature rejection for the session (no repeat 400)', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if ('temperature' in body) {
      return new Response(JSON.stringify({ error: { message: 'Unknown parameter: temperature' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(RESPONSES_CLEAN_STREAM, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
  try {
    const provider = new ResponsesProvider({ model: 'm', baseUrl: 'http://10.0.0.9:8001/v1', selfHosted: true });
    const drain = async () => {
      const out: ProviderEvent[] = [];
      for await (const e of provider.send(baseReq)) out.push(e);
      return out;
    };

    const turn1 = await drain();
    assert.ok('temperature' in bodies[0]!, 'turn 1 sent temperature');
    assert.equal('temperature' in bodies[1]!, false, 'turn 1 retried without it');
    assert.ok(!turn1.some((e) => e.type === 'error' && !e.recoverable), 'run continued');

    bodies.length = 0;
    await drain();
    assert.equal(bodies.length, 1, 'turn 2: exactly one request — the 400 is not paid again');
    assert.equal('temperature' in bodies[0]!, false, 'turn 2 builds without temperature directly');
  } finally {
    globalThis.fetch = orig;
  }
});

// ── H. SSE hardening (adversarial review: incremental delivery, error flush, BOM, null) ──

test('packed non-conforming streams dispatch eagerly — incremental delivery survives', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  async function* gated(): AsyncIterable<string> {
    yield 'data: {"choices":[{"delta":{"content":"a"}}]}';
    await gate; // second frame held back — the first must already be delivered
    yield 'data: {"choices":[{"delta":{"content":"b"}}]}';
    yield '';
  }
  const it = sseEvents(gated())[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.done, false, 'event 1 arrived while event 2 was still gated');
  assert.equal(first.value!.kind, 'data');
  release();
  const rest: unknown[] = [];
  for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value);
  const datas = rest.filter((e) => (e as { kind: string }).kind === 'data');
  assert.equal(datas.length, 1, 'the second frame follows after the gate opens');
});

test('a mid-stream error still flushes accumulated data (nothing buffered is lost)', async () => {
  async function* broken(): AsyncIterable<string> {
    yield 'data: {"partial":';
    throw new Error('connection reset');
  }
  const seen: Array<{ kind: string; data?: string }> = [];
  await assert.rejects(
    (async () => {
      for await (const ev of sseEvents(broken())) seen.push(ev as { kind: string; data?: string });
    })(),
    /connection reset/,
  );
  assert.equal(seen.length, 1, 'the buffered frame was surrendered before the error propagated');
  assert.equal(seen[0]!.kind, 'data');
  assert.equal(seen[0]!.data, '{"partial":');
});

test('BOM between the colon and the payload parses (pre-P2-03 line-trim parity)', () => {
  const bom = String.fromCharCode(0xfeff);
  assert.deepEqual(parseSseData(`${bom}{"a":1}`, [`${bom}{"a":1}`]), [{ a: 1 }]);
  assert.deepEqual(parseSseData(`${bom}{"a":1}\nx`, [`${bom}{"a":1}`, 'x']), [{ a: 1 }]);
});

test('non-object frames are filtered centrally — data: null keepalives cannot crash parsers', () => {
  assert.deepEqual(parseSseData('null', ['null']), []);
  assert.deepEqual(parseSseData('5', ['5']), []);
  assert.deepEqual(parseSseData('{"a":1}\nnull', ['{"a":1}', 'null']), [{ a: 1 }]);
  // arrays are objects and ride through
  assert.deepEqual(parseSseData('[1,2]', ['[1,2]']), [[1, 2]]);
});

test('parseSseResult: a null frame is a clean missing-result, not a TypeError crash', () => {
  assert.throws(() => parseSseResult('data: null\n\n'), /no JSON-RPC result/);
});

test('unparseable accumulation is bounded — the cap force-dispatches instead of buffering forever', () => {
  const asm = new SseAssembler();
  const chunk = 'x'.repeat(64 * 1024);
  let dispatched = 0;
  for (let i = 0; i < 40; i++) dispatched += asm.feed(`data: ${chunk}`).length;
  assert.ok(dispatched >= 1, '~2.5 MB of garbage produced force-dispatches, not one giant buffer');
  assert.deepEqual(asm.flush().length >= 0, true);
});
