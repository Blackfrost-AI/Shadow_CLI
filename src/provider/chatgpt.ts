import type { CompletionRequest, Message, Provider, ProviderEvent } from './provider.js';
import { estimateTokensFromMessages } from './provider.js';
import { ResponsesProvider } from './responses.js';
import { getChatGPTAccessToken } from '../auth/chatgpt.js';

/** Shadow-owned SIWC registration, refreshed before each request. No API-key fallback. */
export class ChatGPTProvider implements Provider {
  readonly name = 'openai';
  readonly allowAutomaticFallback = false;
  constructor(private options: { profileId: string; model: string }) {}
  estimateTokens(messages: Message[]): number { return estimateTokensFromMessages(messages); }
  async *send(request: CompletionRequest): AsyncIterable<ProviderEvent> {
    try {
      request.signal?.throwIfAborted();
      const token = await getChatGPTAccessToken(this.options.profileId, request.signal);
      const provider = new ResponsesProvider({
        apiKey: token, model: this.options.model, baseUrl: 'https://api.openai.com/v1',
        chatgptPlan: true, streamRetries: 0,
      });
      for await (const event of provider.send(request)) {
        yield event.type === 'usage' ? { ...event, billing: 'subscription' } : event;
      }
    } catch (error) {
      if (request.signal?.aborted) return;
      // Auth helpers expose only safe errors, never raw OAuth responses or tokens.
      yield { type: 'error', code: 'chatgpt_account', recoverable: false,
        message: error instanceof Error ? error.message : 'ChatGPT account unavailable. Run shadow login chatgpt.' };
    }
  }
}
