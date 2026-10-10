import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome } from './helpers/isolateHome.js';
import { resolveFakeHosts } from './helpers/fakeHostEgress.js';
import type { CompletionRequest, ProviderEvent } from '../src/provider/provider.js';

const { home, shadowDir } = isolateHome('chatgpt-provider');
const { ChatGPTProvider } = await import('../src/provider/chatgpt.js');
const profileId = 'chatgpt-00000000-0000-0000-0000-000000000001';
const directory = join(shadowDir, 'chatgpt-auth');
mkdirSync(directory, { mode: 0o700 });
writeFileSync(join(directory, profileId + '.json'), JSON.stringify({
  version: 1, profileId, clientId: 'oaiapp_fixture', issuer: 'https://auth.openai.com',
  subject: 'fixture', createdAt: Date.now(), tokens: {
    accessToken: 'fixture-access-token', idToken: 'fixture-id-token', authorizationNonce: 'fixture-nonce',
    expiresAt: Date.now() + 3_600_000, scopes: ['chatgpt.tokens.use.direct'],
  },
}), { mode: 0o600 });
test.after(() => rmSync(home, { recursive: true, force: true }));

const request: CompletionRequest = { model: 'fixture-model', system: 'Fixture',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Fixture' }] }],
  tools: [], maxOutputTokens: 100 };

for (const status of ['completed', 'failed', 'incomplete']) {
  test(`ChatGPT marks ${status} response usage as subscription without retry or API fallback`, async () => {
    const original = globalThis.fetch;
    const restore = resolveFakeHosts();
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-access-token');
      const response = { status, output: [], usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10 } },
        ...(status === 'failed' ? { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Fixture limit' } } : {}),
        ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) };
      return new Response(`data: ${JSON.stringify({ type: 'response.' + status, response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const provider = new ChatGPTProvider({ profileId, model: 'fixture-model' });
      const events: ProviderEvent[] = [];
      for await (const event of provider.send(request)) events.push(event);
      assert.equal(calls, 1);
      assert.equal(provider.allowAutomaticFallback, false);
      assert.deepEqual(events.filter((event) => event.type === 'usage'), [{
        type: 'usage', billing: 'subscription', inputTokens: 90, outputTokens: 20, cacheReadTokens: 10,
      }]);
      assert.equal(events.some((event) => event.type === 'error'), status !== 'completed');
    } finally { globalThis.fetch = original; restore(); }
  });
}
