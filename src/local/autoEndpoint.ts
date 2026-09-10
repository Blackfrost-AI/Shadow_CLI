/**
 * Auto endpoint recognition: point a model entry at a LAN inference box and use whatever it is
 * currently serving.
 *
 * The problem this solves: a self-hosted endpoint (a DGX Spark, a workstation, a lab server) gets
 * restarted with a different model all the time, and a preset that names one model id breaks the
 * moment that changes — the request 404s with "model not found" and the fix is to hand-edit
 * config.json. An entry marked `autoModel: true` instead ASKS the endpoint what it serves at build
 * time, so switching the box from one model to another needs no Shadow-side change at all.
 *
 * Two pieces of discovery, both reusing what already exists:
 *  - the model id and the PROVEN base URL come from `probeModelEndpoint` (src/onboard/probe.ts),
 *    which already toggles `/v1`, understands OpenAI / Anthropic / Ollama catalog shapes, and reads
 *    the response under a byte cap. Because it reports the URL that actually answered, a base URL
 *    written without `/v1` (or with it) is corrected rather than being a coin flip.
 *  - the context window comes from `detectServerContextWindow` (src/gguf.ts), which reads vLLM's
 *    `max_model_len` / llama.cpp's `n_ctx` out of the same catalog. A swappable model has a
 *    swappable window, so this has to be re-read too, not pinned at onboarding.
 *
 * Deliberately NOT cached: the whole point is to notice that the box changed, and a probe against a
 * live LAN endpoint costs milliseconds. A box that is DOWN costs one short timeout (see
 * DETECT_TIMEOUT_MS) and then falls back to the declared model id.
 */
import type { ModelEntry } from '../config.js';
import { probeModelEndpoint } from '../onboard/probe.js';
import { detectServerContextWindow } from '../gguf.js';
import { isLocalBaseUrl } from '../safety/offline.js';

/**
 * A LAN box answers in milliseconds; anything slower is a wrong host or a dead one. Kept short
 * because this runs on the boot path, where a stalled probe is a stalled startup.
 */
export const DETECT_TIMEOUT_MS = 1_500;

export interface AutoEndpoint {
  /** The model id to put on the wire, when the endpoint named one. */
  model?: string;
  /** Every id the endpoint reported (useful for diagnostics and a picker later). */
  models: string[];
  /** The base URL discovery PROVED (may differ from the configured one by a `/v1` segment). */
  baseUrl?: string;
  /** Context window learned from the endpoint, when it reported one. */
  contextWindow?: number;
  /** Why nothing was learned — for a one-line user-visible note. Never fatal. */
  error?: string;
  /**
   * True when the endpoint ANSWERED but had nothing to report. Distinguishes "the box is up, load a
   * model" from "the box is unreachable" — the two need opposite fixes.
   */
  reachable?: boolean;
}

/**
 * Ask an endpoint what it serves.
 *
 * Model choice when the endpoint serves several: the entry's own `model` when it is among them
 * (so a deliberate choice is respected), otherwise the first one reported. An endpoint that serves
 * exactly one model — the ordinary vLLM / llama.cpp / Ollama case — is unaffected by this rule.
 */
export async function detectAutoEndpoint(input: {
  baseUrl: string;
  apiKey?: string;
  authToken?: string;
  /** The entry's declared model id — preferred when the endpoint serves it. */
  prefer?: string;
  timeoutMs?: number;
}): Promise<AutoEndpoint> {
  const timeoutMs = input.timeoutMs ?? DETECT_TIMEOUT_MS;
  const probe = await probeModelEndpoint({
    adapter: 'auto',
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    authToken: input.authToken,
    // Local/LAN endpoints are self-hosted by definition; nothing here is a hosted catalog.
    hostingHint: isLocalBaseUrl(input.baseUrl) ? 'self-hosted' : undefined,
    timeoutMs,
  });
  if (probe.ok && probe.models.length === 0) {
    // Reachable, answering, and serving NOTHING — a running server with no model loaded. That is a
    // different problem from an unreachable box (load a model vs. start/route the box), and merging
    // the two into one message sends the user to fix the wrong thing.
    return { models: [], reachable: true, error: 'the server is reachable but reports no loaded model' };
  }
  if (!probe.ok) {
    return { models: [], error: probe.error ?? 'the endpoint did not answer' };
  }
  const preferred = input.prefer && probe.models.includes(input.prefer) ? input.prefer : undefined;
  const model = preferred ?? probe.models[0]!;
  const provenBaseUrl = probe.baseUrl ?? input.baseUrl.replace(/\/+$/, '');
  // Best-effort: an endpoint that answers /v1/models but exposes no window keeps the preset's own
  // value (configuredContextWindow), so a missing probe degrades instead of guessing.
  const contextWindow = await detectServerContextWindow(provenBaseUrl).catch(() => undefined);
  return { model, models: probe.models, baseUrl: provenBaseUrl, ...(contextWindow ? { contextWindow } : {}) };
}

/**
 * Resolve an `autoModel` entry against its endpoint.
 *
 * Returns `{}` for any other entry, so callers can call this unconditionally. Never throws: a
 * remote box being off must degrade to the declared model id, not take down a boot.
 */
export async function resolveAutoModel(
  entry: ModelEntry | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<AutoEndpoint & { detected: boolean }> {
  if (!entry?.autoModel) return { detected: false, models: [] };
  const baseUrl = entry.baseUrl?.trim();
  if (!baseUrl) {
    return { detected: false, models: [], error: `"${entry.label}" has autoModel but no baseUrl` };
  }
  // The message a user sees must name the ENDPOINT and say what Shadow fell back to. A bare
  // "fetch failed" at boot reads as a Shadow bug; "10.0.0.31:30000 did not answer — using the
  // declared model X" reads as the LAN box being off, which is what it actually is.
  const fallbackNote = entry.model ? ` — using the declared model "${entry.model}"` : '';
  try {
    const found = await detectAutoEndpoint({
      baseUrl,
      apiKey: entry.apiKey,
      authToken: entry.authToken,
      prefer: entry.model,
      timeoutMs: opts.timeoutMs,
    });
    if (!found.model) {
      return {
        detected: false,
        ...found,
        error: found.reachable
          ? `${label(entry)} (${baseUrl}) is reachable but has no model loaded — load one on the box${fallbackNote}`
          : `${label(entry)} (${baseUrl}) could not be reached: ${found.error ?? 'no answer'}${fallbackNote}`,
      };
    }
    return { detected: true, ...found };
  } catch (e) {
    return {
      detected: false,
      models: [],
      error: `${label(entry)} (${baseUrl}) could not be reached: ${(e as Error).message}${fallbackNote}`,
    };
  }
}

/** The name to use for an entry in a message: its label, or the base URL when it has none. */
function label(entry: ModelEntry): string {
  return entry.label?.trim() || entry.baseUrl?.trim() || 'endpoint';
}
