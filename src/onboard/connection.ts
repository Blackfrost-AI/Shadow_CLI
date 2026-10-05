import { createProvider, type ProviderOptions } from '../provider/index.js';
import { registerSecret, redactString } from '../util/redact.js';
import { withDeadline } from './deadline.js';

export interface ConnectionResult {
  ok: boolean;
  error?: string;
}

export async function testConnection(
  options: ProviderOptions,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<ConnectionResult> {
  registerSecret(options.apiKey);
  registerSecret(options.authToken);
  const safeError = (error: unknown) =>
    redactString(error instanceof Error ? error.message : String(error)).slice(0, 500);
  try {
    return await withDeadline(
      async (signal) => {
        const provider = createProvider({ ...options, streamRetries: 0 });
        for await (const event of provider.send({
          model: options.model,
          system: '',
          tools: [],
          maxOutputTokens: 16,
          signal,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with: ok' }] }],
        })) {
          if (event.type === 'error')
            return { ok: false, error: safeError(`${event.code}: ${event.message}`) };
          if (event.type === 'text' && event.delta.trim()) return { ok: true };
          if (event.type === 'tool_call') return { ok: true };
          if (event.type === 'usage' && event.outputTokens > 0) return { ok: true };
        }
        return {
          ok: false,
          error: 'The endpoint returned no output. Check the model ID and streaming support.',
        };
      },
      timeoutMs,
      signal,
    );
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}
