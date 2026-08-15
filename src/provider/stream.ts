/**
 * Shared HTTP-streaming substrate for the real provider adapters. Ported from
 * the reference agent's proven SSE plumbing (newline line-framing + idle watchdog) and
 * rewrapped to the Shadow ProviderEvent contract:
 *
 *   fetch → streamLines (byte stream → text lines) → parse* (lines → events)
 *
 * `streamWithRetry` owns the network lifecycle: exponential-backoff retries on
 * transient failures (429/5xx/network), terminal handling of 4xx auth/validation
 * errors, and an idle-timeout watchdog that aborts a stalled stream. The SSE→event
 * transform itself lives in each adapter's exported `parse*` generator so it can be
 * unit-tested with no network.
 */
import type { ProviderEvent } from './provider.js';
import { isLocalBaseUrl } from '../safety/offline.js';
import { shadowFetch } from '../safety/egress.js';

const MAX_ATTEMPTS = 5; // ~24s of ride-out across the ladder — see backoff()
/** Max times we shrink an over-budget output cap and retry a 400 that says the request is too long. */
// Enough halvings to walk a large cap down to the floor: 16000 → 8000 → 4096 → 2048 → 1024.
const MAX_TOKEN_SHRINKS = 5;
/** Abort a request that produces no bytes for this long (initial wait or mid-stream stall). */
const IDLE_MS = 120_000;
/** The non-stream rescue gets its own bound — it used to inherit no timeout at all. */
const NON_STREAM_TIMEOUT_MS = 180_000;

/**
 * Aborts its controller after `ms` with no `kick()`. Used both as the fetch
 * signal (so an unresponsive server is cut off) and re-armed on every received
 * chunk (so a mid-stream stall is caught). `fired` lets callers distinguish an
 * idle abort from a genuine network error.
 */
class IdleWatchdog {
  readonly controller = new AbortController();
  fired = false;
  /** The frame this watchdog was armed with at trip time (for honest idle-error messages). */
  lastTripFrame: number;
  private timer: ReturnType<typeof setTimeout>;

  /**
   * `nextKickFrame` (optional): the frame every SUBSEQUENT `kick()` re-arms with after the first.
   * Used for `firstByteTimeoutMs` — a short (or long) budget for the very first chunk that hands
   * off to the steady-state frame on the first byte. When omitted, `kick()` re-arms with the same
   * `ms` frame as before (identical behavior for all pre-existing call sites and tests).
   */
  constructor(
    private readonly ms: number,
    nextKickFrame?: number,
  ) {
    this.lastTripFrame = ms;
    if (nextKickFrame !== undefined && nextKickFrame !== ms) {
      // Hop ONCE on the first kick; subsequent kicks stick to the steady-state frame.
      this.kick = () => {
        if (this.fired) return;
        this.lastTripFrame = nextKickFrame;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.trip(), nextKickFrame);
      };
    }
    this.timer = setTimeout(() => this.trip(), ms);
  }

  private trip(): void {
    this.fired = true;
    this.lastTripFrame = this.ms;
    this.controller.abort();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  kick(): void {
    if (this.fired) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.trip(), this.ms);
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}

/**
 * Split a fetch response body (a web ReadableStream of bytes) into text lines.
 * Yields each line WITHOUT its trailing newline; callers trim and filter for
 * `data:`. Invokes `onChunk` on every received chunk to re-arm the idle watchdog,
 * and flushes any trailing partial line (robustness for servers that omit the
 * final newline). A cleanly terminated SSE stream ends with a blank line, so the
 * flush is a harmless no-op in the normal case.
 */
export async function* streamLines(
  body: ReadableStream<Uint8Array>,
  onChunk?: () => void,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode();
    if (buf.length > 0) {
      for (const line of buf.split('\n')) yield line;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface StreamAttempt {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  parse: (lines: AsyncIterable<string>) => AsyncIterable<ProviderEvent>;
  signal?: AbortSignal; // user interrupt — aborting it cancels the in-flight fetch at once
  /** Alternate request body with `stream: false` — used when SSE fails. */
  nonStreamBody?: unknown;
  /** Parse a complete non-stream JSON response into ProviderEvents. */
  parseNonStream?: (obj: unknown) => Generator<ProviderEvent>;
  /**
   * Per-endpoint stream idle budget (ms since the last received event) before the watchdog
   * re-trips. Resolved per-request by the provider from `idleTimeoutMs` (config) / `SHADOW_IDLE_MS`
   * (env) / `IDLE_MS` (default). vLLM/SGLang send NO SSE keepalives during prefill, so a big-context
   * frontier serve (Qwen 3.8 Max ≥ 128k ctx) needs a generous floor — the preamble is silent
   * until the first token. UNSET stays 120s.
   */
  idleTimeoutMs?: number;
  /**
   * Idle budget (ms) applied ONLY until the FIRST event of a brand-new stream (after headers).
   * Once any token arrives the budget falls back to {@link idleTimeoutMs}; used to catch a
   * quietly-wedged header-flush server faster on the very first token without lengthening the
   * steady-state bytes-to-bytes budget.
   */
  firstByteTimeoutMs?: number;
  /**
   * Retry ceiling for pre-200 transient failures (429/5xx/network). Overrides `MAX_ATTEMPTS`
   * (default ~24s ride-out across the ladder). Per-endpoint — a busy frontier serve deserves
   * more, a public endpoint less. UNSET = current ladder.
   */
  streamRetries?: number;
  /**
   * Set when the endpoint receiving this request is self-hosted (local/LAN or the explicit
   * marker). Lets the mid-stream rescue avoid re-firing a duplicate prompt at a busy serve that
   * already accepted the request — the rescue only fires AFTER headers, where the serve is known
   * busy (see the `emitted === 0` guard in `streamWithRetry`).
   */
  selfHosted?: boolean;
  /**
   * Called once when a 400 forces the `tool_choice: "auto"` → `"none"` fallback (a self-hosted
   * vLLM/SGLang started WITHOUT `--enable-auto-tool-choice`/`--tool-call-parser` rejects auto tool
   * choice). The provider uses this to remember the endpoint's limitation for the rest of the
   * session so later turns build with `"none"` directly instead of eating a 400 every turn.
   */
  onToolChoiceUnsupported?: () => void;
  /**
   * Called once per param when the generic param-strip ladder (P2-03 / F01-05) strips an optional
   * request param a 400 named (stream_options / tool_choice / temperature). The provider uses it
   * to remember the rejection for the rest of the session so later turns build WITHOUT the param
   * instead of eating a 400 + retry every turn — the same remember-for-the-session shape as
   * {@link onToolChoiceUnsupported}.
   */
  onParamStripped?: (param: StrippableParam) => void;
}

/** A 400 that specifically rejects `tool_choice: "auto"` (missing vLLM/SGLang tool-parser flags). */
export function looksLikeToolChoiceUnsupported(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /tool[_ -]?choice/.test(m) &&
    /(auto|require|not (supported|enabled|allowed)|enable-auto-tool-choice|tool[- ]?call[- ]?parser|unsupported)/.test(m)
  );
}

/**
 * Downgrade a request body's `tool_choice` to `"none"` so a serve without a tool-call parser stops
 * 400-ing. The tools stay in the body: the model's chat template still renders them, so a
 * tool-trained model (Qwen/Hermes) emits calls as text, which Shadow's text-tool-call recovery
 * parses back out. Returns true if a change was made.
 */
export function setToolChoiceNone(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (b.tool_choice === 'none') return false;
  if (!('tools' in b) && !('tool_choice' in b)) return false;
  b.tool_choice = 'none';
  return true;
}

/**
 * Optional wire params Shadow sends that a strict or partial endpoint can flat-out reject
 * (P2-03 / F01-05). Ordered by how commonly they trip gateways; `max_tokens` is NOT here —
 * token-budget 400s have their own shrink ladder, and `stream`/`messages` are not optional.
 */
export const STRIPPABLE_PARAMS = ['stream_options', 'tool_choice', 'temperature'] as const;
export type StrippableParam = (typeof STRIPPABLE_PARAMS)[number];

const STRIP_PARAM_RES: Array<{ param: StrippableParam; re: RegExp }> = [
  { param: 'stream_options', re: /stream_options/i },
  { param: 'tool_choice', re: /tool_choice/i },
  { param: 'temperature', re: /temperature/i },
];

/**
 * Every strippable param a 400 message names, in ladder order. The param names are distinctive
 * lowercase/snake_case tokens, so a plain substring match on provider error text is safe — this
 * only ever FIRES on a 400. A message may name several (gateway policy banners list all the
 * params they reject); the ladder walks the candidates in order and strips the FIRST one that
 * is still present in the body and not already stripped.
 */
export function rejectedParamsInMessage(message: string): StrippableParam[] {
  return STRIP_PARAM_RES.filter(({ re }) => re.test(message)).map(({ param }) => param);
}

/**
 * True when a 400 message reads as a VALUE-validation error ("temperature 0.2 is below the
 * minimum", "must be <= 2, got 5", "out of range") rather than a FIELD rejection ("Unsupported
 * parameter", "unknown parameter", "not supported"). Value errors must stay TERMINAL: stripping
 * the param would silently void a knob the user set explicitly (sampling re-defaults for the
 * whole session) instead of surfacing the misconfiguration. A wrong call here costs a visible
 * error with the server's own words — the honest failure mode.
 */
export function looksLikeParamValueError(message: string): boolean {
  return /(below|above|out of range|too (low|high|small|large)|must (be|not exceed|not be greater)|at least|at most|expected .*got|got \d|between .{1,24} and|less than|greater than|maximum of|minimum of|invalid (value|range)|exceeds?)/i.test(
    message,
  );
}

/** Delete a rejected param from a request body. Returns true if it was present. */
export function stripParamFromBody(body: unknown, param: string): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (!(param in b)) return false;
  delete b[param];
  return true;
}

/**
 * POST `body` to `url` and stream the SSE response through `parse`, retrying
 * transient failures. Retries (exp backoff + jitter, up to MAX_ATTEMPTS) only
 * happen BEFORE the stream starts — a 200 response that breaks mid-stream cannot
 * be resumed, so it surfaces a recoverable error event instead. Classification:
 *   - network reject / 429 / 5xx  → retry, then recoverable error
 *   - 400 / 401 / 403 / other 4xx → terminal, non-recoverable error
 *   - idle timeout                → recoverable error (no retry; already waited)
 */
export async function* streamWithRetry(a: StreamAttempt): AsyncIterable<ProviderEvent> {
  // Per-endpoint resolve (P1A-04): config-knob → SHADOW_IDLE_MS env → IDLE_MS default. The env
  // override MUST beat config for the operator escape hatch; the watchdog frame must KNOW what
  // frame the user picked, so resolve once per stream (not per attempt) and reuse for the error.
  const idleBudget = a.idleTimeoutMs ?? IDLE_MS; // ms since last event before the watchdog trips
  const frameMs = Math.max(0, idleBudget); // never negative; 0 = disable (kick immediately trips)
  const maxRetries = a.streamRetries ?? MAX_ATTEMPTS;
  // selfHosted is an explicit marker — vLLM/SGLang flush headers before prefill completes, so a
  // headers-then-silence server looks like a mid-stream stall at emitted===0. The C4 no-re-POST
  // protection must survive that shape too: a busy LOCAL serve already has the prompt.
  const selfHosted = a.selfHosted === true || isLocalBaseUrl(a.url);
  let shrinks = 0;
  let imagesStripped = false;
  let toolChoiceStripped = false;
  // P2-03 (F01-05): params already stripped during THIS stream — each strips at most once, so a
  // server rejecting several params is walked one 400 at a time, never a strip-loop.
  const strippedParams = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    if (a.signal?.aborted) return; // user already interrupted — don't even start
    // A headers-first serve may need a much longer wait for the FIRST token than for steady-state
    // bytes (vLLM prefill). Arm firstByteTimeoutMs ONLY until the first body chunk — kick() has
    // hopped to the steady-state frame by then, so every subsequent re-arm uses frameMs. This
    // makes the first-byte budget a first-byte budget, not a smuggled tight idle budget.
    const idle = new IdleWatchdog(a.firstByteTimeoutMs ?? frameMs, frameMs);
    // fetch aborts on EITHER an idle timeout OR a user interrupt (ESC/Ctrl-C).
    const fetchSignal = a.signal ? AbortSignal.any([idle.signal, a.signal]) : idle.signal;
    let res: Response;
    try {
      // Routed through the egress broker (P2-01): offline wall + metadata-IP block + DNS
      // pinning (the pin set is resolved ONCE and cached, so retries no longer re-resolve
      // the provider host on every attempt) + the egress receipt.
      res = await shadowFetch(
        a.url,
        {
          method: 'POST',
          headers: a.headers,
          body: JSON.stringify(a.body),
          signal: fetchSignal,
        },
        { purpose: 'provider', origin: 'user' },
      );
    } catch (e) {
      idle.clear();
      if (a.signal?.aborted) return; // user interrupt — stop silently (loop reports 'interrupted')
      if (idle.fired) {
        if (yield* nonStreamFallback(a, 'idle', selfHosted)) return;
        yield idleError(frameMs);
        return;
      }
      if (attempt < maxRetries) {
        try {
          await backoff(attempt, undefined, a.signal);
        } catch {
          return; // ESC during the wait — stop silently, the loop reports 'interrupted'
        }
        continue;
      }
      yield { type: 'error', recoverable: true, code: 'network_error', message: (e as Error).message };
      return;
    }

    if (res.status === 429 || res.status >= 500) {
      idle.clear();
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const message = await readErrorMessage(res);
      if (attempt < maxRetries) {
        try {
          await backoff(attempt, retryAfterMs, a.signal); // honor the server's Retry-After when sent
        } catch {
          return; // ESC during the wait — a 60s Retry-After used to ignore the interrupt entirely
        }
        continue;
      }
      yield { type: 'error', recoverable: true, code: `http_${res.status}`, message };
      return;
    }
    if (!res.ok) {
      idle.clear();
      const message = await readErrorMessage(res);
      // A 400 meaning "your request exceeds the model's context/token limit" is recoverable in
      // exactly one way: ask for fewer output tokens. This bites reasoning models on small-window
      // endpoints (e.g. a 64k-context local/OpenRouter reasoner where the max_tokens floor requests
      // the whole window). Shrink the output cap and retry, up to MAX_TOKEN_SHRINKS times, before
      // surfacing a terminal error — so the harness self-corrects instead of dying on the first turn.
      if (res.status === 400 && shrinks < MAX_TOKEN_SHRINKS && looksLikeTokenOverflow(message)) {
        const shrank = shrinkMaxTokens(a.body);
        if (a.nonStreamBody) shrinkMaxTokens(a.nonStreamBody);
        if (shrank) {
          shrinks++;
          continue;
        }
      }
      // A 400 from a TEXT-ONLY endpoint that rejects image content (e.g. "messages.content.type is
      // invalid, allowed values: ['text']"). The image sits in history and would 400 on EVERY
      // subsequent turn, wedging the run — strip images to a text placeholder and retry so the model
      // proceeds (blind to the image) instead of dying. Guarded on the body actually having images.
      if (res.status === 400 && !imagesStripped && looksLikeVisionUnsupported(message) && stripImagesFromBody(a.body)) {
        if (a.nonStreamBody) stripImagesFromBody(a.nonStreamBody);
        imagesStripped = true;
        continue;
      }
      // The image itself is bad (corrupt, oversized, undecodable). Same recovery — the run must
      // not wedge — but say what actually happened instead of blaming the model's capabilities,
      // and surface the provider's own words ONCE as a recoverable error so the user can fix it.
      if (res.status === 400 && !imagesStripped && looksLikeBadImagePayload(message)) {
        const why = `the provider rejected it: ${message}`;
        if (stripImagesFromBody(a.body, why)) {
          if (a.nonStreamBody) stripImagesFromBody(a.nonStreamBody, why);
          imagesStripped = true;
          yield { type: 'error', recoverable: true, code: 'image_rejected', message };
          continue;
        }
      }
      // A 400 from a self-hosted serve that rejects `tool_choice: "auto"` (vLLM/SGLang launched
      // without `--enable-auto-tool-choice`/`--tool-call-parser`). Retry ONCE with `"none"`: the
      // tools stay rendered by the chat template, the model still emits calls as text, and Shadow's
      // text-tool-call recovery parses them — so the run WORKS instead of dying on turn 1. Without
      // this, every agentic request to such a serve is dead on arrival.
      if (res.status === 400 && !toolChoiceStripped && looksLikeToolChoiceUnsupported(message) && setToolChoiceNone(a.body)) {
        if (a.nonStreamBody) setToolChoiceNone(a.nonStreamBody);
        toolChoiceStripped = true;
        a.onToolChoiceUnsupported?.();
        continue;
      }
      // P2-03 (F01-05) — the generic param-strip ladder. A 400 whose message NAMES an optional
      // param we sent (stream_options / tool_choice / temperature) retries once with that param
      // stripped: the server's default behavior replaces it, and the run continues instead of
      // dying on a gateway that rejects one knob. Ordered AFTER the specialized handlers above —
      // token shrink, image strip, and tool_choice→none all make BETTER recoveries than a plain
      // strip when they match. The provider is told, so the rest of the session builds without
      // the param and never pays this 400 again (imagesStripped/toolChoiceStripped pattern).
      //
      // Two guards keep the strip honest:
      //  - VALUE errors ("temperature 0.2 is below the minimum") stay TERMINAL — stripping would
      //    silently void the user's knob instead of surfacing the misconfiguration;
      //  - a message naming SEVERAL params walks the candidates in ladder order, skipping params
      //    already stripped or absent from the body, so a policy banner listing every rejected
      //    param (or a first-named param we never sent) cannot stall a viable recovery.
      if (res.status === 400 && !looksLikeParamValueError(message)) {
        let strippedParam: StrippableParam | null = null;
        for (const param of rejectedParamsInMessage(message)) {
          if (strippedParams.has(param)) continue;
          if (!stripParamFromBody(a.body, param)) continue;
          if (a.nonStreamBody) stripParamFromBody(a.nonStreamBody, param);
          strippedParams.add(param);
          a.onParamStripped?.(param);
          strippedParam = param;
          break;
        }
        if (strippedParam) continue;
      }
      // 400 (bad request) / 401 (auth) / 403 (forbidden) / other 4xx — terminal.
      yield { type: 'error', recoverable: false, code: `http_${res.status}`, message };
      return;
    }
    if (!res.body) {
      idle.clear();
      yield { type: 'error', recoverable: true, code: 'empty_body', message: 'provider returned no response body' };
      return;
    }

    let emitted = 0;
    try {
      for await (const ev of a.parse(streamLines(res.body, () => idle.kick()))) {
        emitted++;
        yield ev;
      }
    } catch (e) {
      if (a.signal?.aborted) {
        // user interrupt mid-stream — stop silently; the loop reports 'interrupted'
      } else if (
        emitted === 0 &&
        (yield* nonStreamFallback(a, selfHosted ? 'idle' : 'empty', selfHosted))
      ) {
        // recovered via non-stream POST — safe ONLY because nothing was emitted yet. Re-fetching after
        // partial output would duplicate the text/tool_use already streamed to the loop.
        //
        // P1A-04: a headers-first self-hosted serve (vLLM/SGLang send 200 + headers, then a long
        // silent prefill) trips the watchdog with emitted===0 and looks like a mid-stream stall.
        // Tag the rescue `'idle'` so the C4 no-re-POST protection fires — NEVER re-POST the full
        // prompt at a local serve that already has it. The empty-response path is unchanged for a
        // genuinely-silent public API (re-POSTing there is safe; the endpoint never started).
      } else {
        yield idle.fired
          ? idleError(idle.lastTripFrame)
          : { type: 'error', recoverable: true, code: 'stream_error', message: (e as Error).message };
      }
    } finally {
      idle.clear();
    }
    return;
  }
}

/**
 * POST a non-streaming request and parse the JSON body. Exported for unit tests.
 */
export async function fetchNonStreamResponse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await shadowFetch(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    },
    { purpose: 'provider', origin: 'user' },
  );
  if (!res.ok) {
    const message = await readErrorMessage(res);
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
  const text = await res.text();
  if (!text.trim()) throw new Error('provider returned empty non-stream body');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('provider returned non-JSON non-stream body');
  }
}

/** Try the non-stream fallback once; yields events and returns true on success. */
async function* nonStreamFallback(a: StreamAttempt, reason: 'idle' | 'empty' = 'empty', selfHosted = false): AsyncGenerator<ProviderEvent, boolean> {
  if (!a.nonStreamBody || !a.parseNonStream) return false;
  if (a.signal?.aborted) return false;
  // C4 — do NOT re-fire an identical prompt at a LOCAL server that has merely gone quiet.
  //
  // An idle trip immediately re-POSTed the same body. On a llama.cpp/MLX serve doing prompt eval
  // over 60k tokens that is catastrophic: the already-saturated server now has a SECOND copy of
  // the same prompt queued, the first two minutes of work are thrown away, and the machine is
  // doing double the work to answer once. A remote endpoint that goes silent is usually a dropped
  // connection worth retrying; a local one is usually just busy.
  //
  // What counts as "local": a URL the safety boundary already recognizes (loopback/LAN/mDNS), or an
  // EXPLICITLY self-hosted endpoint on a public FQDN — those remote serves are just as busy.
  if (reason === 'idle' && (selfHosted || isLocalBaseUrl(a.url))) return false;
  try {
    // The fallback gets its OWN timeout. It previously attached only `a.signal`, so the request
    // that was supposed to rescue a stall could itself hang indefinitely.
    const watchdog = new IdleWatchdog(NON_STREAM_TIMEOUT_MS);
    const signal = a.signal ? AbortSignal.any([watchdog.signal, a.signal]) : watchdog.signal;
    try {
      const obj = await fetchNonStreamResponse(a.url, a.headers, a.nonStreamBody, signal);
      yield* a.parseNonStream(obj);
      return true;
    } finally {
      watchdog.clear();
    }
  } catch (e) {
    yield {
      type: 'error',
      recoverable: true,
      code: 'non_stream_fallback_failed',
      message: (e as Error).message,
    };
    return false;
  }
}

function idleError(frameMs = IDLE_MS): ProviderEvent {
  return {
    type: 'error',
    recoverable: true,
    code: 'idle_timeout',
    message: `no response within ${Math.round(frameMs / 1000)}s — the model may be overloaded or the connection stalled` +
      (frameMs !== IDLE_MS ? ` (configured stream idle timeout; raise \`idleTimeoutMs\` or ${'$'}SHADOW_IDLE_MS for a slow local serve)` : ''),
  };
}

/**
 * Sleep before the next attempt: the server's Retry-After when given (capped at 60s), else an
 * exponentially growing, jittered local backoff.
 *
 * ABORTABLE (C2). This used to be a bare `setTimeout` promise with no signal, and there is no
 * in-flight fetch to cancel during a backoff — the abort check happens at the TOP of the next
 * iteration. So on a `429 + Retry-After: 60` the process ignored ESC for a full minute per retry
 * while the TUI cheerfully showed the turn as running. Rejecting on abort makes the wait
 * interruptible; the caller's existing abort handling takes it from there.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * How long the local backoff ladder rides out a transient failure (C3).
 *
 * Was MAX_ATTEMPTS=4 over `250 * 2**(n-1)` — about 2.3s total, and the 8000ms cap was literally
 * unreachable. Anthropic 529 bursts last 5–30s, so a blip any well-behaved client rides out
 * instead tripped `isFallbackEligible` and silently swapped the user onto a weaker model
 * mid-task. The ladder now spans ~24s (1s, 3s, 7s, 13s + jitter), which is long enough to
 * outlast a normal burst — and it only got safe to lengthen because C2 made the wait
 * interruptible, so a user who doesn't want to wait presses ESC.
 */
async function backoff(attempt: number, retryAfterMs?: number, signal?: AbortSignal): Promise<void> {
  if (retryAfterMs != null) {
    await abortableSleep(Math.min(retryAfterMs, 60_000), signal);
    return;
  }
  const base = Math.min(13_000, 1_000 * (2 ** attempt - 1)); // 1s, 3s, 7s, 13s…
  const jitter = Math.random() * base * 0.3;
  await abortableSleep(base + jitter, signal);
}

/** Parse an HTTP `Retry-After` header (delta-seconds OR an HTTP-date) to milliseconds, or undefined. */
export function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(v);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** True if a 4xx message indicates the request exceeded the model's context/token budget. */
export function looksLikeTokenOverflow(msg: string): boolean {
  // Includes llama.cpp / many locals: "request (32925 tokens) exceeds the available context size (32768 tokens)"
  return /context[ _-]?(length|window|size)|maximum context|available context|context_length_exceeded|max(?:imum)?[ _]?(?:new[ _])?tokens|too many tokens|reduce the (?:length|number)|prompt is too long|requested about \d+ tokens|exceeds? the (?:maximum|model|available)|n_keep|n_ctx/i.test(
    msg,
  );
}

/**
 * Halve any output-token cap on a request body (`max_tokens` / `max_completion_tokens`), flooring
 * at TOKEN_SHRINK_FLOOR. Returns true if it reduced anything, so the caller knows a retry is worth
 * attempting. Mutates the body in place — safe because each send() builds a fresh body object.
 *
 * The floor is deliberately low (1024): a model whose ENTIRE window is 8192 can't fit a 4096 output
 * cap alongside any real input, so a 4096 floor left tiny-window models (small local reasoners,
 * some vLLM serves) dead on `max_tokens=… > max_model_len=8192` with no self-recovery. 1024 output
 * still yields a usable (if short) answer, and this only ever kicks in AFTER the endpoint has
 * rejected larger requests — a normal big-window request stops shrinking the moment it fits.
 */
export const TOKEN_SHRINK_FLOOR = 1024;
export function shrinkMaxTokens(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  let changed = false;
  for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    // 'max_output_tokens' is the Responses API (/v1/responses) field — without it the token-overflow
    // 400 → shrink-and-retry self-correction was a no-op on that wire and the run died on turn 1.
    const v = b[field];
    if (typeof v === 'number' && v > TOKEN_SHRINK_FLOOR) {
      b[field] = Math.max(TOKEN_SHRINK_FLOOR, Math.floor(v / 2));
      changed = true;
    }
  }
  return changed;
}

/**
 * A problem with THIS IMAGE — decode/size/format/fetch — as opposed to the model lacking vision.
 *
 * Both outcomes must still STRIP AND RETRY, which is the trap C7 nearly walked into: narrowing
 * `looksLikeVisionUnsupported` so a corrupt image no longer matched meant the 400 became terminal
 * — and because the image stays in conversation history and every request body is rebuilt from
 * history, the identical 400 then fired on EVERY subsequent turn. The session was wedged until
 * /clear. Showing the real error is right; showing it INSTEAD of recovering is not. So the two
 * predicates differ only in the REASON the user is told, never in whether we recover.
 */
export function looksLikeBadImagePayload(msg: string): boolean {
  const m = msg.toLowerCase();
  if (!(m.includes('image') || m.includes('image_url'))) return false;
  return /base64|decode|dimension|pixel|too large|exceeds|corrupt|truncat|malformed|file size|bytes|could not (?:be )?(?:fetch|download|process)|format/.test(m);
}

/** True if a 4xx message indicates the endpoint rejected image content (a text-only model/server). */
export function looksLikeVisionUnsupported(msg: string): boolean {
  const m = msg.toLowerCase();
  // Text-only OpenAI-compatible servers reject non-text parts, e.g.
  // "messages.content.type is invalid, allowed values: ['text']".
  if (m.includes('allowed values') && m.includes("'text'")) return true;
  // vLLM / custom gateways: "BLACK-LM is not a multimodal model"
  if (m.includes('multimodal') && /not a |is not |non-/.test(m)) return true;
  if (/not a multimodal|non-multimodal|text-only model|does not support (multi-?modal|vision|images?)/.test(m)) return true;
  // Generic "image(s) unsupported / invalid content type" variants across servers.
  //
  // NARROWED (C7): the old arm was `image` + (not support|unsupported|invalid|cannot|does not),
  // which also matched ordinary, fixable image problems — verified true for
  // "invalid base64 data" and "image dimensions exceed 8000 pixels". Those got the attachment
  // silently replaced with "[image omitted — the current model has no vision support]" and the
  // REAL error was never shown, so a user with a corrupt or oversized file was told their model
  // lacks a capability it actually has. Anything that names a decode/size/format problem is about
  // THIS image, not about the model, and must surface as itself.
  // The DISCRIMINATOR is this negative guard, checked first: anything naming a decode/size/format
  // problem is about THIS image, not about the model. The positive arm below then keeps its
  // original breadth, so genuine phrasings like "invalid content type: image" still strip.
  if (/base64|decode|dimension|pixel|too large|exceeds|corrupt|truncat|malformed|file size|bytes/.test(m)) return false;
  if ((m.includes('image_url') || m.includes('image')) && /not support|unsupported|invalid|cannot|does not|no vision|only text/.test(m)) return true;
  return false;
}

/**
 * Replace every image content part in a request body with a text placeholder, so a text-only
 * endpoint accepts the turn instead of 400-ing on it. Handles both OpenAI (`image_url`) and
 * Anthropic (`image`) part shapes. Returns true if it changed anything (there were images to
 * strip), so the caller only retries when stripping actually helps. Mutates in place.
 */
export function stripImagesFromBody(body: unknown, reason?: string): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  // Chat-completions carries messages under `messages`; the Responses API (/v1/responses) carries them
  // under `input`. Without the `input` fallback the vision-unsupported 400 → strip-and-retry never fired
  // on that wire and every subsequent turn re-sent the image and 400'd, wedging the run.
  const msgs = Array.isArray(b.messages) ? b.messages : Array.isArray(b.input) ? b.input : null;
  if (!msgs) return false;
  const isImg = (t?: string): boolean => t === 'image_url' || t === 'image' || t === 'input_image';
  const isTxt = (t?: string): boolean => t === 'text' || t === 'input_text';
  let stripped = false;
  for (const m of msgs) {
    const msg = m as { content?: unknown };
    if (!Array.isArray(msg.content)) continue;
    const hasImage = msg.content.some((p) => p && isImg((p as { type?: string }).type));
    if (!hasImage) continue;
    // Keep the text parts, drop the images, and collapse to a plain STRING — a text-only endpoint
    // accepts that where it 400s on a typed image part. A short note tells the model an image was
    // there but it can't see it, so it doesn't keep waiting on visual input it will never get.
    const texts = (msg.content as { type?: string; text?: string }[])
      .filter((p) => p && isTxt(p.type) && typeof p.text === 'string')
      .map((p) => p.text as string);
    texts.push(
      reason
        ? `[image omitted — ${reason}]`
        : '[image omitted — the current model has no vision support; use the describe_media tool to see it]',
    );
    msg.content = texts.join('\n');
    stripped = true;
  }
  return stripped;
}

/** Best-effort extraction of a human message from an error response body. */
async function readErrorMessage(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string };
    if (j && typeof j.error === 'object' && typeof j.error.message === 'string') return j.error.message;
    if (typeof j?.error === 'string') return j.error;
  } catch {
    /* not JSON — fall through to raw text */
  }
  return raw.trim() || `HTTP ${res.status}`;
}
