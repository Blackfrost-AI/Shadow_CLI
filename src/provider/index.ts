import type { Provider } from './provider.js';
import { demoMock, dialectMock, errorMock, recoveryMock } from './mock.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { ResponsesProvider, useResponsesWire } from './responses.js';
import { ChatGPTProvider } from './chatgpt.js';
import { ClaudeCodeProvider } from './claudeCode.js';
import type { AccountConnection, ModelCapabilities, ModelEntry } from '../config.js';

export type ProviderName = 'anthropic' | 'openai' | 'mock';

export interface ProviderOptions {
  connection?: AccountConnection;
  provider: ProviderName;
  model: string;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  /**
   * Identity headers the endpoint requires, from a subscription credential
   * (`chatgpt-account-id`, `OpenAI-Beta`, …). They are part of the credential, not configuration:
   * a request carrying the bearer without them is refused by that host.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Force a wire regardless of `SHADOW_WIRE_API`. A subscription credential names the wire its
   * backend serves (see ProviderAuthSpec.subscriptionWire) — the Codex backend is Responses-only,
   * so letting the env default pick chat-completions would post to a path it does not serve.
   */
  wire?: 'chat' | 'responses';
  /** Explicit opt-in for a remote self-hosted endpoint; local/LAN URLs are detected automatically. */
  selfHosted?: boolean;
  /** P1A-06: declarative per-model capability block (see config.ts ModelCapabilities). Consulted
   *  by the OpenAI adapter BEFORE id-regex guessing; overrides the guess where declared. */
  capabilities?: ModelCapabilities;
  // --- P1A-04: per-endpoint stream resilience knobs (primarily for self-hosted endpoints) ---
  /** Mid-stream silence tolerated before the watchdog aborts the SSE. */
  idleTimeoutMs?: number;
  /** Max wait for the first byte/flushed chunk of a response stream. */
  firstByteTimeoutMs?: number;
  /** SSE retry ceiling for 5xx / connection-reset storm suppression. */
  streamRetries?: number;
  /** F06-08: reasoning round-trip mode from config. 'last' (default) replays preserved
   *  provider reasoning only on the newest qualifying assistant turn; 'none' disables the
   *  round trip entirely. */
  reasoningRoundtrip?: 'last' | 'none';
}

/**
 * F10-01: the slice of ProviderOptions that must ALWAYS travel with a ModelEntry — the P1A-04
 * stream-resilience knobs (SHADOW_IDLE_MS env override wins; validated `^\d+$` and > 0, else
 * ignored fail-closed) and the P1A-06 declarative capability block. Bootstrap AND every
 * interactive rebuild (TUI /model switch, in-TUI fallback, /model test) spread this into their
 * createProvider call, so a live switch can never silently shed the entry's wire contract.
 *
 * T2: `defaults` carries the session-wide `stream` block from config.json — the fallback for
 * setups that configure provider/model/baseUrl DIRECTLY (no `models[]` preset), which
 * previously had no config knob at all. Precedence: SHADOW_IDLE_MS env > per-model entry >
 * top-level stream block > self-hosted-aware default (300s local/LAN, 120s public) >
 * built-in default. Capabilities stay entry-specific and never fall through to the top
 * level. The global `~/.shadow/config.json` stream block reaches here through loadConfig's
 * deep merge into `cfg.stream` — resolved at the call site, NOT inside this module (this
 * file must stay globalStore-free so provider-only imports never pin GLOBAL_DIR early).
 */
export interface StreamDefaults {
  idleTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  retries?: number;
}

export function entryStreamContract(
  entry?: Pick<ModelEntry, 'idleTimeoutMs' | 'firstByteTimeoutMs' | 'streamRetries' | 'capabilities' | 'connection'>,
  defaults?: StreamDefaults,
): Pick<ProviderOptions, 'idleTimeoutMs' | 'firstByteTimeoutMs' | 'streamRetries' | 'capabilities' | 'connection'> {
  const raw = process.env.SHADOW_IDLE_MS;
  const trimmed = raw?.trim();
  const envIdleMs =
    trimmed != null && /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? Number(trimmed) : undefined;
  return {
    ...(entry?.connection ? { connection: entry.connection } : {}),
    idleTimeoutMs: envIdleMs ?? entry?.idleTimeoutMs ?? defaults?.idleTimeoutMs,
    firstByteTimeoutMs: entry?.firstByteTimeoutMs ?? defaults?.firstByteTimeoutMs,
    streamRetries: entry?.streamRetries ?? defaults?.retries,
    capabilities: entry?.capabilities,
  };
}

/**
 * Factory. Wires the mock (M0) and the real streaming adapters: native Anthropic
 * Messages API and OpenAI-compatible Chat Completions. Callers are unchanged.
 */
export function createProvider(opts: ProviderOptions): Provider {
  // Account selection is explicit. Never send these requests with an API key, a configured
  // gateway, or a different transport just because one exists in the environment.
  if (opts.connection) {
    if (opts.baseUrl && opts.connection.kind === 'chatgpt' && opts.baseUrl.replace(/\/+$/, '') !== 'https://api.openai.com/v1') {
      throw new Error('ChatGPT account connections use the official OpenAI endpoint. Remove the custom base URL.');
    }
    if (opts.connection.kind === 'chatgpt' && opts.provider === 'openai') {
      return new ChatGPTProvider({ profileId: opts.connection.profileId, model: opts.model });
    }
    if (opts.connection.kind === 'claude-code' && opts.provider === 'anthropic' && !opts.baseUrl) {
      return new ClaudeCodeProvider({ model: opts.model });
    }
    throw new Error('The selected subscription connection does not match this provider or endpoint. Run shadow onboard.');
  }
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
        // P1A-04: explicit marker — remote proxies in front of Anthropic Messages are not
        // detected by URL, so forward the factory's selfHosted through (mirrors OpenAIProvider).
        selfHosted: opts.selfHosted,
        idleTimeoutMs: opts.idleTimeoutMs,
        firstByteTimeoutMs: opts.firstByteTimeoutMs,
        streamRetries: opts.streamRetries,
      });
    case 'openai':
      // SHADOW_WIRE_API=responses selects /v1/responses (Codex-class); default is chat completions.
      // `opts.wire` is the credential's own requirement and therefore outranks the env default: a
      // Codex subscription token only exists on the Responses backend, so honouring an env that
      // says otherwise would post a valid token to a path that host does not serve.
      return opts.wire === 'responses' || (opts.wire !== 'chat' && useResponsesWire())
        ? new ResponsesProvider({
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl,
            extraHeaders: opts.extraHeaders,
            model: opts.model,
            selfHosted: opts.selfHosted,
            idleTimeoutMs: opts.idleTimeoutMs,
            firstByteTimeoutMs: opts.firstByteTimeoutMs,
            streamRetries: opts.streamRetries,
            reasoningRoundtrip: opts.reasoningRoundtrip,
          })
        : new OpenAIProvider({
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl,
            extraHeaders: opts.extraHeaders,
            model: opts.model,
            selfHosted: opts.selfHosted,
            idleTimeoutMs: opts.idleTimeoutMs,
            firstByteTimeoutMs: opts.firstByteTimeoutMs,
            streamRetries: opts.streamRetries,
            capabilities: opts.capabilities,
            reasoningRoundtrip: opts.reasoningRoundtrip,
          });
  }
}
