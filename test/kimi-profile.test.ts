import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenAIBody,
  isKimiThinkingModel,
  parseOpenAISSE,
  shouldPreserveProviderReasoning,
  shouldPreserveQwenReasoning,
} from '../src/provider/openai.js';
import { familyProfile } from '../src/config/familyProfiles.js';
import { findPreset, providersForMode } from '../src/onboard/catalog.js';
import type { CompletionRequest, Effort, Message, ProviderEvent } from '../src/provider/provider.js';

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function request(model: string): CompletionRequest {
  return {
    model,
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] }],
    tools: [{ name: 'read_file', description: 'Read one file', parameters: { type: 'object' } }],
    maxOutputTokens: 65_536,
    temperature: 0.2,
    effort: 'high',
  };
}

test('Kimi thinking detection is thinking-only and NEVER routes through the Qwen gate', () => {
  for (const id of ['kimi-k2-thinking', 'kimi-k2-thinking-turbo', 'moonshotai/kimi-k3-thinking', 'Kimi-K2-Thinking']) {
    assert.equal(isKimiThinkingModel(id), true, id);
  }
  for (const id of ['kimi-latest', 'kimi-k2-turbo-preview', 'moonshot-v1-128k', 'qwen3-thinking']) {
    assert.equal(isKimiThinkingModel(id), false, id);
  }
  // The replay contract is the MODEL's (chat template consumes prior reasoning), so the general
  // gate opens on the id alone — while the Qwen-specific gate stays closed for Kimi ids.
  assert.equal(shouldPreserveQwenReasoning('kimi-k2-thinking', {}), false, 'Kimi is not hacked into the Qwen path');
  assert.equal(shouldPreserveProviderReasoning('kimi-k2-thinking', {}), true, 'public endpoint, no flags needed');
  assert.equal(shouldPreserveProviderReasoning('kimi-latest', {}), false, 'non-thinking Kimi does not replay');
});

test('kimi-thinking family profile declares the low/high/max effort vocabulary only', () => {
  const prof = familyProfile('kimi-k2-thinking');
  assert.equal(prof?.family, 'kimi-thinking');
  assert.deepEqual(prof?.effortScale, ['low', 'high', 'max']);
  assert.equal(prof?.minOutputTokens, undefined, 'no output floor is claimed without documented evidence');
  assert.equal(familyProfile('kimi-latest'), undefined, 'non-thinking Kimi stays unprofiled');
});

test('kimi thinking captures reasoning_content and round-trips it in a follow-up request body', async () => {
  const model = 'kimi-k2-thinking';
  const events = await collect(parseOpenAISSE(fromLines([
    'data: {"choices":[{"delta":{"reasoning_content":"check the "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"file first","tool_calls":[{"index":0,"id":"k1","function":{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ]), model, shouldPreserveProviderReasoning(model, {})));
  assert.deepEqual(events.find((event) => event.type === 'reasoning_block'), {
    type: 'reasoning_block',
    text: 'check the file first',
    field: 'reasoning_content',
  });

  // Tool loop: the captured reasoning must reach the NEXT request byte-for-byte, on a plain
  // public endpoint (no selfHosted/dashScope/capabilities flags — Moonshot's documented contract).
  const history: Message[] = [{
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'k1', name: 'read_file', input: { path: 'x' } }],
    providerReasoning: { text: 'check the file first', field: 'reasoning_content', model },
  }];
  const body = buildOpenAIBody({ ...request(model), messages: history }, model, true, {});
  const assistant = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'assistant');
  assert.equal(assistant?.reasoning_content, 'check the file first');
  assert.equal(body.preserve_thinking, undefined, 'the Qwen-only wire flag is never sent to Kimi');

  // Model-bound: switching to another Kimi id drops the history instead of replaying it.
  const switched = buildOpenAIBody({ ...request('kimi-latest'), messages: history }, 'kimi-latest', true, {});
  const switchedAssistant = (switched.messages as Array<Record<string, unknown>>).find((m) => m.role === 'assistant');
  assert.equal(switchedAssistant?.reasoning_content, undefined);
});

test('kimi effort emission respects the declared scale — an undeclared tier is never sent', () => {
  const wire = (effort: Effort | undefined) =>
    buildOpenAIBody({ ...request('kimi-k2-thinking'), effort }, 'fallback', true, {}).reasoning_effort;
  // Every emitted value is a member of the family scale; medium/xhigh round UP onto it.
  assert.equal(wire('low'), 'low');
  assert.equal(wire('medium'), 'high', 'medium is not on the scale — rounds up to high');
  assert.equal(wire('high'), 'high');
  assert.equal(wire('xhigh'), 'max', 'xhigh is not on the scale — rounds up to max');
  assert.equal(wire('max'), 'max');
  assert.equal(wire(undefined), 'max', 'no /effort dial → highest declared tier');
  // An explicit capability scale still outranks family knowledge.
  const capped = buildOpenAIBody(request('kimi-k2-thinking'), 'fallback', true, {
    capabilities: { effortScale: ['low'] },
  });
  assert.equal(capped.reasoning_effort, 'low');
  // Non-thinking Kimi has no declared vocabulary → no effort param at all.
  assert.equal(buildOpenAIBody(request('kimi-latest'), 'fallback', true, {}).reasoning_effort, undefined);
});

test('kimi request shaping stays otherwise plain (no invented floor, no sampling leak)', () => {
  const body = buildOpenAIBody(request('kimi-k2-thinking'), 'fallback', true, {});
  assert.equal(body.max_tokens, 65_536, 'no undocumented output floor/cap is guessed — the ladder is the net');
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.temperature, undefined, 'cloud endpoint never receives the self-hosted sampling control');
  assert.equal(body.tool_choice, 'auto');
});

test('Moonshot onboarding preset exists with the right adapter, base URL, and a thinking default', () => {
  const preset = findPreset('moonshot');
  assert.ok(preset, 'moonshot preset present in the catalog');
  assert.equal(preset?.adapter, 'openai');
  assert.equal(preset?.baseUrl, 'https://api.moonshot.ai/v1');
  assert.equal(preset?.kind, 'cloud');
  assert.equal(preset?.defaultModel, 'kimi-k2-thinking');
  assert.equal(isKimiThinkingModel(preset!.defaultModel), true, 'default id activates the replay profile out of the box');
  assert.ok(preset?.keyUrl, 'key hint present');
  assert.ok(providersForMode('cloud').some((p) => p.id === 'moonshot'), 'shown on the cloud door');
  assert.ok(!providersForMode('server').some((p) => p.id === 'moonshot'), 'not a local-server preset');
});
