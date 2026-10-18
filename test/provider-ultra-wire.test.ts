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
