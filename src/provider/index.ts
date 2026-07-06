import type { Provider } from './provider.js';
import { demoMock, dialectMock, errorMock, recoveryMock } from './mock.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { ResponsesProvider, useResponsesWire } from './responses.js';

export type ProviderName = 'anthropic' | 'openai' | 'mock';

export interface ProviderOptions {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
}

/**
 * Factory. Wires the mock (M0) and the real streaming adapters: native Anthropic
 * Messages API and OpenAI-compatible Chat Completions. Callers are unchanged.
 */
export function createProvider(opts: ProviderOptions): Provider {
  switch (opts.provider) {
    case 'mock':
      if (process.env.SHADOW_MOCK_ERROR === '1') return errorMock();
      if (process.env.SHADOW_MOCK_RECOVERY) return recoveryMock();
      if (process.env.SHADOW_MOCK_DIALECT === '1') return dialectMock();
      return demoMock();
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: opts.apiKey,
        authToken: opts.authToken,
        baseUrl: opts.baseUrl,
        model: opts.model,
      });
    case 'openai':
      // SHADOW_WIRE_API=responses selects /v1/responses (Codex-class); default is chat completions.
      return useResponsesWire()
        ? new ResponsesProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model })
        : new OpenAIProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model });
  }
}
