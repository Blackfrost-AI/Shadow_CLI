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
        let validTool = false;
        let completed = false;
        let incompleteStream = false;
        for await (const event of provider.send({
          model: options.model,
          system: '',
          tools: [{ name: 'shadow_connection_test', description: 'Return this setup check. It performs no actions.',
            parameters: { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false } }],
          toolChoice: { type: 'tool', name: 'shadow_connection_test' },
          maxOutputTokens: 1024,
          effort: 'low',
          signal,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Call shadow_connection_test with {"ok":true}. This only verifies the connection; no tool will be executed.' }] }],
        })) {
          if (event.type === 'error')
            return { ok: false, error: safeError(`${event.code}: ${event.message}`) };
          if (event.type === 'diagnostic' && event.code === 'openai_stream_summary') {
            incompleteStream = !['tool_calls', 'function_call', 'stop'].includes(event.data.finishReason);
          }
          if (event.type === 'tool_call') {
            const input = event.call.input;
            if (event.call.name !== 'shadow_connection_test' || !input || typeof input !== 'object' ||
                Array.isArray(input) || (input as Record<string, unknown>).ok !== true || Object.keys(input).length !== 1) {
              return { ok: false, error: 'The model returned an invalid setup tool call. Choose a model with tool support.' };
            }
            validTool = true;
          }
          if (event.type === 'done') completed = event.stopReason === 'tool_use' || event.stopReason === 'end_turn';
        }
        if (completed && validTool && !incompleteStream) return { ok: true };
        return {
          ok: false,
          error: completed && !incompleteStream
            ? 'The model did not return the requested tool call. Choose a model with tool support.'
            : 'The endpoint did not complete its response. Check the model ID, output budget and streaming support.',
        };
      },
      timeoutMs,
      signal,
    );
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}
