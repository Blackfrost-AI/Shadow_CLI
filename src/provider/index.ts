import type { Provider } from './provider.js';
import { demoMock, dialectMock, errorMock, recoveryMock } from './mock.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { ResponsesProvider, useResponsesWire } from './responses.js';
import type { ModelCapabilities, ModelEntry } from '../config.js';

export type ProviderName = 'anthropic' | 'openai' | 'mock';

export interface ProviderOptions {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
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
  entry?: Pick<ModelEntry, 'idleTimeoutMs' | 'firstByteTimeoutMs' | 'streamRetries' | 'capabilities'>,
  defaults?: StreamDefaults,
): Pick<ProviderOptions, 'idleTimeoutMs' | 'firstByteTimeoutMs' | 'streamRetries' | 'capabilities'> {
  const raw = process.env.SHADOW_IDLE_MS;
  const trimmed = raw?.trim();
  const envIdleMs =
    trimmed != null && /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? Number(trimmed) : undefined;
  return {
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
      return useResponsesWire()
        ? new ResponsesProvider({
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl,
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
