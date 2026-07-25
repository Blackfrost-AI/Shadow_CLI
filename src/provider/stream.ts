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
  private timer: ReturnType<typeof setTimeout>;

  constructor(private readonly ms: number) {
    this.timer = setTimeout(() => this.trip(), ms);
  }

  private trip(): void {
    this.fired = true;
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
  let shrinks = 0;
  let imagesStripped = false;
  for (let attempt = 1; ; attempt++) {
    if (a.signal?.aborted) return; // user already interrupted — don't even start
    const idle = new IdleWatchdog(IDLE_MS);
    // fetch aborts on EITHER an idle timeout OR a user interrupt (ESC/Ctrl-C).
    const fetchSignal = a.signal ? AbortSignal.any([idle.signal, a.signal]) : idle.signal;
    let res: Response;
    try {
      res = await fetch(a.url, {
        method: 'POST',
        headers: a.headers,
        body: JSON.stringify(a.body),
        signal: fetchSignal,
      });
    } catch (e) {
      idle.clear();
      if (a.signal?.aborted) return; // user interrupt — stop silently (loop reports 'interrupted')
      if (idle.fired) {
        if (yield* nonStreamFallback(a, 'idle')) return;
        yield idleError();
        return;
      }
      if (attempt < MAX_ATTEMPTS) {
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
      if (attempt < MAX_ATTEMPTS) {
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
      } else if (emitted === 0 && (yield* nonStreamFallback(a))) {
        // recovered via non-stream POST — safe ONLY because nothing was emitted yet. Re-fetching after
        // partial output would duplicate the text/tool_use already streamed to the loop.
      } else {
        yield idle.fired
          ? idleError()
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
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
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
async function* nonStreamFallback(a: StreamAttempt, reason: 'idle' | 'empty' = 'empty'): AsyncGenerator<ProviderEvent, boolean> {
  if (!a.nonStreamBody || !a.parseNonStream) return false;
  if (a.signal?.aborted) return false;
  // C4 — do NOT re-fire an identical prompt at a LOCAL server that has merely gone quiet.
  //
  // An idle trip immediately re-POSTed the same body. On a llama.cpp/MLX serve doing prompt eval
  // over 60k tokens that is catastrophic: the already-saturated server now has a SECOND copy of
  // the same prompt queued, the first two minutes of work are thrown away, and the machine is
  // doing double the work to answer once. A remote endpoint that goes silent is usually a dropped
  // connection worth retrying; a local one is usually just busy.
  if (reason === 'idle' && isLocalBaseUrl(a.url)) return false;
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

function idleError(): ProviderEvent {
  return {
    type: 'error',
    recoverable: true,
    code: 'idle_timeout',
    message: `no response within ${IDLE_MS / 1000}s — the model may be overloaded or the connection stalled`,
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
