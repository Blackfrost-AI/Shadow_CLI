import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { CompletionRequest } from '../src/provider/provider.js';

const { home: HOME } = isolateHome('chat-template-thinking');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const { ModelEntrySchema } = await import('../src/config.js');
const { entryStreamContract } = await import('../src/provider/index.js');
const { OpenAIProvider, buildOpenAIBody } = await import('../src/provider/openai.js');

const request = (model = 'local-security-9b'): CompletionRequest => ({
  model,
  system: 'system',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'run the pipeline' }] }],
  tools: [],
  maxOutputTokens: 1024,
});

test('model-entry schema preserves the explicit chat-template thinking capability', () => {
  const entry = ModelEntrySchema.parse({
    label: 'Local Security 9B',
    provider: 'openai',
    model: 'local-security-9b',
    baseUrl: 'http://127.0.0.1:8908/v1',
    capabilities: { chatTemplateEnableThinking: false },
  });

  assert.equal(entry.capabilities?.chatTemplateEnableThinking, false);
  assert.equal(
    entryStreamContract(entry).capabilities?.chatTemplateEnableThinking,
    false,
    'the per-model capability must reach provider construction without a truthiness drop',
  );
  assert.equal(ModelEntrySchema.safeParse({
    label: 'bad', provider: 'openai', model: 'bad',
    capabilities: { chatTemplateEnableThinking: 'false' },
  }).success, false);
});

test('Chat Completions emits the exact SGLang kwarg only for an explicit self-hosted capability', () => {
  const explicit = buildOpenAIBody(request(), 'fallback', true, {
    selfHosted: true,
    capabilities: { chatTemplateEnableThinking: false },
  });
  assert.deepEqual(explicit.chat_template_kwargs, { enable_thinking: false });

  const unset = buildOpenAIBody(request('Qwen/Qwen3-9B'), 'fallback', true, { selfHosted: true });
  assert.equal(
    unset.chat_template_kwargs,
    undefined,
    'a Qwen-like model name must never guess the non-standard request field',
  );

  const cloud = buildOpenAIBody(request(), 'fallback', true, {
    capabilities: { chatTemplateEnableThinking: false },
  });
  assert.equal(
    cloud.chat_template_kwargs,
    undefined,
    'a misplaced capability block must not send the extension to an unverified public endpoint',
  );
});

test('OpenAIProvider classifies the selected LAN endpoint as self-hosted', () => {
  const provider = new OpenAIProvider({
    model: 'local-security-9b',
    baseUrl: 'http://127.0.0.1:8908/v1',
    capabilities: { chatTemplateEnableThinking: false },
  });
  assert.equal(
    (provider as unknown as { selfHosted: boolean }).selfHosted,
    true,
    'the provider passes this endpoint identity into Chat Completions request construction',
  );
});
