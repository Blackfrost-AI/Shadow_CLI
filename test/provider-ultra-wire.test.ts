import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnthropicBody, mapAnthropicStop } from '../src/provider/anthropic.js';
import type { CompletionRequest } from '../src/provider/provider.js';

/**
 * Wire-level tests for the two provider defects the audit found.
 *
 * These assert on the BODY that would be sent, not on a helper's return value, because both bugs
 * lived in the gap between "the config says max" and "the request says max".
 */

const BASE: CompletionRequest = {
  // Must resolve adaptive thinking, or the effort assertions silently skip and pass for
  // the wrong reason (which is exactly how this test was first written, and it lied).
  model: 'claude-opus-4-6',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  system: '',
  maxOutputTokens: 4096,
} as CompletionRequest;

const body = (req: Partial<CompletionRequest>, caps?: Parameters<typeof buildAnthropicBody>[3]) =>
  buildAnthropicBody({ ...BASE, ...req } as CompletionRequest, 'fb', true, caps);

// ── effort must respect the declared scale ──────────────────────────────────────────────────

test('effort: an UNDECLARED endpoint keeps prior behaviour (nothing regresses)', () => {
  const b = body({ effort: 'max' } as Partial<CompletionRequest>);
  // No capabilities passed at all: this is every existing caller, and it must be byte-identical
  // to what shipped before ultra mode.
  assert.deepEqual(b.thinking, { type: 'adaptive', display: 'summarized' }, 'fixture must be adaptive');
  assert.deepEqual(b.output_config, { effort: 'max' });
});

test('effort: a declared Claude-shaped scale clamps max down to xhigh on the wire', () => {
  const b = body({ effort: 'max' } as Partial<CompletionRequest>, {
    capabilities: { effortScale: ['low', 'medium', 'xhigh'], adaptiveThinking: true },
  });
  assert.deepEqual(b.thinking, { type: 'adaptive', display: 'summarized' }, 'fixture must be adaptive');
  assert.deepEqual(b.output_config, { effort: 'xhigh' }, 'max must never be sent to a 3-tier scale');
});

test('effort: a declared full ladder passes max through untouched', () => {
  const b = body({ effort: 'max' } as Partial<CompletionRequest>, {
    capabilities: { effortScale: ['low', 'medium', 'high', 'xhigh', 'max'], adaptiveThinking: true },
  });
  assert.deepEqual(b.thinking, { type: 'adaptive', display: 'summarized' }, 'fixture must be adaptive');
  assert.deepEqual(b.output_config, { effort: 'max' });
});

test('effort: a declared block WITHOUT a scale omits output_config entirely', () => {
  // Fail closed: the endpoint declared capabilities but no effort ladder, which is an assertion
  // that it takes no effort parameter. Sending one anyway is the over-claiming bug.
  const b = body({ effort: 'max' } as Partial<CompletionRequest>, {
    capabilities: { adaptiveThinking: true, promptCache: true },
  });
  assert.deepEqual(b.thinking, { type: 'adaptive', display: 'summarized' }, 'fixture must be adaptive');
  assert.equal(b.output_config, undefined, 'no declared scale means no effort param');
});

// ── refusal is a distinct stop reason ───────────────────────────────────────────────────────

test('stop reason: refusal is NOT collapsed into end_turn', () => {
  // Collapsed, a refusal reads to the loop as a normal finish: the turn looks complete, an empty
  // answer reaches the user with no explanation, and nothing records that the endpoint declined.
  assert.equal(mapAnthropicStop('refusal'), 'refusal');
  assert.notEqual(mapAnthropicStop('refusal'), 'end_turn');
});

test('stop reason: the ordinary reasons still map as before', () => {
  assert.equal(mapAnthropicStop('end_turn'), 'end_turn');
  assert.equal(mapAnthropicStop('tool_use'), 'tool_use');
  assert.equal(mapAnthropicStop('max_tokens'), 'max_tokens');
  assert.equal(mapAnthropicStop('pause_turn'), 'pause_turn');
  assert.equal(mapAnthropicStop('stop_sequence'), 'end_turn');
  assert.equal(mapAnthropicStop('something-new'), 'end_turn', 'unknown reasons degrade to end_turn');
});

// ── premium channels are fail-closed, not merely reported ──────────────────────────────────
//
// The first pass at ultra mode computed `unavailable` and then sent the premium channel anyway:
// `req.fastMode` and `cacheTtl:'1h'` were honoured unconditionally further down the body. A
// declaration that only decorates a notice is not a contract, so these assert the WIRE.

test('fast mode: a declared endpoint that lacks it never gets speed or the beta', () => {
  const b = body({ fastMode: true } as Partial<CompletionRequest>, {
    capabilities: { effortScale: ['low', 'medium', 'xhigh'] },
  });
  assert.equal(b.speed, undefined, 'declared-but-absent fast mode must not be sent');
  // Mutually-exclusive guard: dropping fast mode must not have silently dropped thinking too.
  assert.deepEqual(b.thinking, { type: 'adaptive', display: 'summarized' });
});

test('fast mode: a declared endpoint that HAS it still gets speed', () => {
  const b = body({ fastMode: true } as Partial<CompletionRequest>, {
    capabilities: { fastMode: true },
  });
  assert.equal(b.speed, 'fast');
  // Fast mode and extended thinking are mutually exclusive on the wire; fast wins, no 400.
  assert.equal(b.thinking, undefined, 'fast mode must disable adaptive thinking');
});

test('fast mode: an undeclared endpoint keeps prior behaviour (nothing regresses)', () => {
  const b = body({ fastMode: true } as Partial<CompletionRequest>);
  assert.equal(b.speed, 'fast');
});

test('extended cache: a declared endpoint that lacks the 1h TTL downgrades to 5m', () => {
  const b = body({ cacheTtl: '1h', system: 'you are shadow' } as Partial<CompletionRequest>, {
    capabilities: { effortScale: ['low', 'high'], promptCache: true },
  });
  const sys = b.system as Array<{ cache_control?: { ttl?: string } }>;
  assert.ok(sys?.[0], 'fixture must produce a system block, or this asserts nothing');
  assert.equal(sys[0].cache_control?.ttl, undefined, 'undeclared 1h TTL must not be requested');
});

test('extended cache: a declared endpoint that HAS it keeps the 1h TTL', () => {
  const b = body({ cacheTtl: '1h', system: 'you are shadow' } as Partial<CompletionRequest>, {
    capabilities: { promptCache: true, extendedCache: true },
  });
  assert.ok(b.system, 'fixture must produce a system block, or this asserts nothing');
  assert.match(JSON.stringify(b.system), /"ttl":"1h"/);
});

// ── adaptiveThinking is a real channel, not dead metadata ──────────────────────────────────
// It was declared in ModelCapabilities and folded into plan.enabled, then never consulted when
// building the request: the wire came from a model-id regex alone. These pin the declaration as
// the authority so a future id the regex predates still behaves correctly.

test('adaptive: declared true enables thinking even on an id the regex does not know', () => {
  const b = body({ model: 'future-model-9000' } as Partial<CompletionRequest>, {
    capabilities: { adaptiveThinking: true },
  });
  assert.deepEqual(b.thinking, { type: 'adaptive', display: 'summarized' });
  assert.ok(b.max_tokens, 'adaptive lifts max_tokens to the thinking floor');
});

test('adaptive: declared false suppresses thinking even on a matching id', () => {
  // claude-opus-4-6 DOES match supportsAdaptiveThinking; the explicit false must win.
  const b = body({}, { capabilities: { adaptiveThinking: false } });
  assert.equal(b.thinking, undefined);
});

test('adaptive: undeclared falls back to the model-id regex (no behaviour change)', () => {
  const b = body({}, undefined);
  assert.deepEqual(b.thinking, { type: 'adaptive', display: 'summarized' });
});

// ── promptCache gates the breakpoints themselves ──────────────────────────────────────────
// Previously the field was declared and ignored, so an endpoint that explicitly said
// `promptCache: false` still received cache_control markers on system, tools AND the last message.

test('promptCache:false emits NO cache_control anywhere in the body', () => {
  const b = body(
    { system: 'you are shadow', tools: [{ name: 't', description: 'd', parameters: {} }] } as Partial<CompletionRequest>,
    { capabilities: { promptCache: false, adaptiveThinking: false } },
  );
  const serialized = JSON.stringify(b);
  assert.equal(serialized.includes('cache_control'), false, serialized.slice(0, 400));
});

test('promptCache:true (and undeclared) still emits breakpoints', () => {
  for (const caps of [{ capabilities: { promptCache: true } }, undefined]) {
    const b = body({ system: 'you are shadow' } as Partial<CompletionRequest>, caps);
    assert.match(JSON.stringify(b.system), /cache_control/, 'system block must stay cacheable');
  }
});

// ── volatile suffix rides at the MESSAGE TAIL (iteration-budget counter) ─────────────────────
// The per-turn budget counter must not enter the cached prefix. Anthropic matches a cached prefix
// against the START of the next request, so a breakpoint may only terminate on bytes that RECUR next
// turn. The rolling breakpoint therefore sits on the last PERSISTED history block; the request-only
// counter is appended AFTER it, uncached. The whole tools+system+persisted-history prefix cache-hits
// every turn; only the small trailing counter is re-processed. (A breakpoint ON the counter would
// write an entry ending in bytes that never recur — unhittable — re-writing history every turn.)

test('volatile suffix: system stays a single cached block; breakpoint on persisted history, counter uncached after it', () => {
  const b = body({
    system: 'you are shadow',
    systemVolatileSuffix: '## Iteration budget\nTurns used: 3/30 · 27 left.',
  } as Partial<CompletionRequest>);
  const sys = b.system as Array<Record<string, unknown>>;
  assert.equal(sys.length, 1, 'system must stay a single stable block (no volatile second block)');
  assert.equal(sys[0].text, 'you are shadow');
  assert.ok(sys[0].cache_control, 'the stable system keeps its cache breakpoint');
  const msgs = b.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const last = msgs[msgs.length - 1];
  // The persisted user text carries the breakpoint; the counter rides after it, UNCACHED.
  assert.equal(last.content[0].text, 'hi');
  assert.ok(last.content[0].cache_control, 'rolling breakpoint sits on the last PERSISTED block');
  const tail = last.content[last.content.length - 1];
  assert.match(String(tail.text), /## Iteration budget/, 'counter is the trailing message block');
  assert.equal(tail.cache_control, undefined, 'the volatile counter must NOT carry a breakpoint');
});

test('volatile suffix: the tools+system+history PREFIX is byte-stable across turns (cache hits)', () => {
  const mk = (counter: string) => body({
    system: 'you are shadow',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
    ],
    systemVolatileSuffix: counter,
  } as Partial<CompletionRequest>);
  const t1 = mk('## Iteration budget\nTurns used: 1/30 · 29 left.');
  const t2 = mk('## Iteration budget\nTurns used: 2/30 · 28 left.');
  // Strip ONLY the trailing counter block from the last message; everything before it must match.
  const prefix = (b: ReturnType<typeof body>) => {
    const msgs = structuredClone(b.messages) as Array<{ content: Array<Record<string, unknown>> }>;
    msgs[msgs.length - 1].content.pop(); // remove the volatile tail
    return JSON.stringify({ system: b.system, tools: b.tools, messages: msgs });
  };
  assert.equal(prefix(t1), prefix(t2), 'the cached prefix must be identical turn-to-turn');
  assert.notEqual(JSON.stringify(t1.messages), JSON.stringify(t2.messages), 'only the tail differs');
});

test('volatile suffix: CROSS-TURN cache hit — turn N breakpoint prefix is a byte-exact prefix of turn N+1', () => {
  // Turn N: history q1/a1/q2 with counter_N. Turn N+1: history GROWS (q1/a1/q2/a2/q3) with counter_{N+1};
  // counter_N is request-only and absent. The breakpoint-terminated prefix written at turn N must be a
  // byte-exact prefix of turn N+1's messages, or the rolling cache entry is unhittable.
  const histN = [
    { role: 'user', content: [{ type: 'text', text: 'q1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    { role: 'user', content: [{ type: 'text', text: 'q2' }] },
  ];
  const histN1 = [
    ...histN,
    { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    { role: 'user', content: [{ type: 'text', text: 'q3' }] },
  ];
  const turnN = body({ system: 'you are shadow', messages: histN, systemVolatileSuffix: '## Iteration budget\nTurns used: 1/30 · 29 left.' } as Partial<CompletionRequest>);
  const turnN1 = body({ system: 'you are shadow', messages: histN1, systemVolatileSuffix: '## Iteration budget\nTurns used: 2/30 · 28 left.' } as Partial<CompletionRequest>);
  // Extract turn N's messages up to and including the breakpoint block (the cached prefix it writes).
  const msgsN = turnN.messages as Array<{ content: Array<Record<string, unknown>> }>;
  const cachedPrefix: Array<{ content: Array<Record<string, unknown>> }> = [];
  let found = false;
  for (const m of msgsN) {
    const blocks: Array<Record<string, unknown>> = [];
    for (const blk of m.content) {
      blocks.push(blk);
      if (blk.cache_control) { found = true; break; }
    }
    cachedPrefix.push({ content: blocks });
    if (found) break;
  }
  assert.ok(found, 'turn N must place a message breakpoint');
  // Flatten to block sequences; every cached-prefix block must equal the corresponding turn N+1 block
  // in order. Compare CONTENT only: the cache_control marker is transient (the rolling breakpoint moves
  // to the new last persisted block each turn) and is not part of the cached content key.
  const strip = (b: Record<string, unknown>) => { const c = { ...b }; delete c.cache_control; return c; };
  const flat = (ms: Array<{ content: Array<Record<string, unknown>> }>) => ms.flatMap((m) => m.content.map(strip));
  const msgsN1 = turnN1.messages as Array<{ content: Array<Record<string, unknown>> }>;
  const prefixBlocks = flat(cachedPrefix);
  const n1Blocks = flat(msgsN1);
  assert.ok(n1Blocks.length > prefixBlocks.length, 'turn N+1 history grew beyond the cached prefix');
  prefixBlocks.forEach((blk, i) => {
    assert.deepEqual(blk, n1Blocks[i], `cached prefix block ${i} content must recur byte-exact in turn N+1`);
  });
  // The counter must NOT be inside the cached prefix (it is request-only and would break the hit).
  assert.ok(!JSON.stringify(cachedPrefix).includes('## Iteration budget'), 'the volatile counter must be OUTSIDE the cached prefix');
  // And the breakpoint must be on PERSISTED content (the user's q2), not on the counter.
  const lastCached = cachedPrefix[cachedPrefix.length - 1].content;
  const tagged = lastCached.find((b) => b.cache_control);
  assert.equal(tagged?.text, 'q2', 'breakpoint sits on the last persisted history block, not the counter');
});

test('volatile suffix: no suffix ⇒ single cached system block, no stray tail (byte-identical to before)', () => {
  const b = body({ system: 'you are shadow' } as Partial<CompletionRequest>);
  const sys = b.system as Array<Record<string, unknown>>;
  assert.equal(sys.length, 1);
  assert.ok(sys[0].cache_control);
  const msgs = b.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal(msgs[msgs.length - 1].content.length, 1, 'no extra tail block when suffix absent');
  assert.ok(msgs[msgs.length - 1].content[0].cache_control, 'breakpoint still on the persisted block');
});

test('volatile suffix: promptCache:false still delivers the counter at the tail, no breakpoints', () => {
  const b = body(
    { system: 'you are shadow', systemVolatileSuffix: '## Iteration budget\nTurns used: 1/5 · 4 left.' } as Partial<CompletionRequest>,
    { capabilities: { promptCache: false, adaptiveThinking: false } },
  );
  const msgs = b.messages as Array<{ content: Array<Record<string, unknown>> }>;
  const last = msgs[msgs.length - 1];
  assert.match(String(last.content[last.content.length - 1].text), /## Iteration budget/);
  assert.equal(JSON.stringify(b).includes('cache_control'), false, 'no breakpoints when caching is off');
});

test('volatile suffix: empty/whitespace suffix is ignored (no stray block)', () => {
  for (const suffix of ['', '   ', undefined]) {
    const b = body({ system: 'you are shadow', systemVolatileSuffix: suffix } as Partial<CompletionRequest>);
    assert.equal((b.system as Array<unknown>).length, 1, `suffix ${JSON.stringify(suffix)} must not add a system block`);
    const msgs = b.messages as Array<{ content: Array<unknown> }>;
    assert.equal(msgs[msgs.length - 1].content.length, 1, `suffix ${JSON.stringify(suffix)} must not add a tail block`);
  }
});

test('volatile suffix: empty history ⇒ fresh uncached user turn hosts the counter, no message breakpoint', () => {
  const b = body({ system: 'you are shadow', messages: [], systemVolatileSuffix: '## Iteration budget\nTurns used: 1/30 · 29 left.' } as Partial<CompletionRequest>);
  const msgs = b.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(msgs.length, 1, 'a fresh user turn is added for the counter');
  assert.equal(msgs[0].role, 'user');
  assert.match(String(msgs[0].content[0].text), /## Iteration budget/);
  assert.equal(msgs[0].content[0].cache_control, undefined, 'no persisted history ⇒ no message breakpoint to protect');
  assert.ok((b.system as Array<Record<string, unknown>>)[0].cache_control, 'system still cached');
});

test('volatile suffix: assistant-prefill tail ⇒ counter in a fresh user turn, breakpoint stays on persisted assistant', () => {
  const b = body({
    system: 'you are shadow',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial prefill' }] },
    ],
    systemVolatileSuffix: '## Iteration budget\nTurns used: 2/30 · 28 left.',
  } as Partial<CompletionRequest>);
  const msgs = b.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  // The persisted assistant prefill keeps the breakpoint; the counter rides in a NEW user turn after it.
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, 'assistant');
  assert.ok(msgs[1].content[0].cache_control, 'breakpoint stays on the last persisted (assistant) block');
  assert.equal(msgs[2].role, 'user');
  assert.match(String(msgs[2].content[0].text), /## Iteration budget/);
  assert.equal(msgs[2].content[0].cache_control, undefined, 'the counter turn is uncached');
});
