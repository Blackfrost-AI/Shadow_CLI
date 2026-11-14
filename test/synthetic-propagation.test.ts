import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toAnthropicMessages } from '../src/provider/anthropic.js';
import { toOpenAIMessages } from '../src/provider/openai.js';
import { buildResponsesBody } from '../src/provider/responses.js';
import type { CompletionRequest, Message } from '../src/provider/provider.js';

// Reviewer adjustments #1 and #2 for the F1 injection-safe-harvest release (11.6.1):
//   #1 every production harness-injected user turn must stamp synthetic:true so the
//      compaction harvester can exclude it (never launder a nudge into the objective).
//   #2 the synthetic flag is process-only and must never reach a provider wire payload.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const syntheticMsg: Message = {
  role: 'user',
  synthetic: true,
  content: [{ type: 'text', text: 'harness nudge — process-only, never an instruction' }],
};

// --- #2 wire omission: the flag must not survive into any provider request body ---

test('wire omission: Anthropic mapper drops the synthetic flag', () => {
  const out = toAnthropicMessages([syntheticMsg]);
  assert.ok(out.length > 0, 'mapper produced no messages');
  assert.ok(!JSON.stringify(out).includes('synthetic'), 'synthetic leaked into the Anthropic wire payload');
});

test('wire omission: OpenAI mapper drops the synthetic flag', () => {
  const req = {
    system: 'sys',
    messages: [syntheticMsg],
    model: 'test-model',
    tools: [],
  } as unknown as CompletionRequest;
  const out = toOpenAIMessages(req);
  assert.ok(out.length > 0, 'mapper produced no messages');
  assert.ok(!JSON.stringify(out).includes('synthetic'), 'synthetic leaked into the OpenAI wire payload');
});

test('wire omission: Responses body drops the synthetic flag', () => {
  const req = {
    system: 'sys',
    messages: [syntheticMsg],
    model: 'test-model',
    tools: [],
  } as unknown as CompletionRequest;
  const body = buildResponsesBody(req, 'test-model', false, {});
  assert.ok(!JSON.stringify(body).includes('synthetic'), 'synthetic leaked into the Responses wire payload');
});

test('wire omission: Claude Code history mapper copies explicit fields only (no raw-message spread)', () => {
  // requestContract is module-private, so prove omission structurally: the history
  // mapper builds { role, ..., content } explicitly and never spreads the Message
  // (a spread would carry the process-only synthetic flag onto the wire).
  const cc = src('src/provider/claudeCode.ts');
  const mapIdx = cc.indexOf('req.messages.map');
  assert.ok(mapIdx >= 0, 'claudeCode history mapper not found');
  const mapWindow = cc.slice(mapIdx, mapIdx + 400);
  assert.match(mapWindow, /role: message\.role/, 'mapper must construct an explicit role field');
  assert.ok(!/\.\.\.message\b/.test(mapWindow), 'mapper must not spread the raw Message (would leak synthetic)');
});

// --- #1 production-site propagation: each nudge/injection stamps synthetic:true ---
// Source-structural pins (same pattern as envelope.test.ts) prove the ACTUAL call sites
// carry the flag — stronger than a hand-built { synthetic:true } fixture, which could
// pass even if a production site forgot to stamp it.

test('propagation: loop.ts harness nudges all stamp synthetic:true', () => {
  const loop = src('src/agent/loop.ts');
  // Confirmed nudge markers (badJson / nameless share one append site via ternary).
  const markers = [
    'arguments were not valid JSON',
    'tool name was omitted',
    'You indicated a tool call but none was received',
  ];
  for (const marker of markers) {
    const idx = loop.indexOf(marker);
    assert.ok(idx >= 0, `nudge marker missing from loop.ts: ${marker}`);
    // The stamp follows the content array in the append literal, so look both ways.
    const window = loop.slice(Math.max(0, idx - 500), idx + 800);
    assert.match(window, /synthetic:\s*true/, `nudge not stamped synthetic: ${marker}`);
  }
  // Four distinct append sites: empty-response, badJson/nameless, tool_use, completion-check.
  const stamps = loop.match(/synthetic:\s*true/g) ?? [];
  assert.ok(stamps.length >= 4, `expected >=4 synthetic stamps in loop.ts, found ${stamps.length}`);
});

test('propagation: agentTool Project-messages injection stamps synthetic:true', () => {
  const t = src('src/tools/agentTool.ts');
  const idx = t.indexOf('Project messages');
  assert.ok(idx >= 0, 'Project-messages injection marker missing from agentTool.ts');
  const window = t.slice(Math.max(0, idx - 500), idx + 500);
  assert.match(window, /synthetic:\s*true/, 'agentTool injection not stamped synthetic');
});

test('propagation: bootstrap recovered-task note stamps synthetic:true', () => {
  assert.match(src('src/agent/bootstrap.ts'), /synthetic:\s*true/, 'bootstrap note not stamped synthetic');
});

test('propagation: index hook-denial note stamps synthetic:true', () => {
  assert.match(src('src/index.ts'), /synthetic:\s*true/, 'index hook-denial note not stamped synthetic');
});
