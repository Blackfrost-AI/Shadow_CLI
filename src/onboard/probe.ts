import { isLocalBaseUrl } from '../safety/offline.js';
import { shadowFetch } from '../safety/egress.js';
import { registerSecret, redactString } from '../util/redact.js';

export type ProbeAdapter = 'openai' | 'anthropic' | 'auto';
export type EndpointHosting = 'hosted' | 'self-hosted' | 'unknown';

export interface EndpointProbeResult {
  /** True only when a live catalog endpoint answered with a recognized model-list payload. */
  ok: boolean;
  models: string[];
  source: 'live' | 'curated' | 'none';
  compatibility: 'openai' | 'anthropic';
  hosting: EndpointHosting;
  /** Chat-completions base URL proven by discovery (may add/remove /v1). */
  baseUrl?: string;
  modelsUrl?: string;
  error?: string;
}

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProbeEndpointOptions {
  adapter: ProbeAdapter;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
  fallbackModels?: string[];
  /** Catalog providers are known hosted; local presets are known self-hosted. */
  hostingHint?: Exclude<EndpointHosting, 'unknown'>;
  timeoutMs?: number;
  /** Test seam. Production always uses Shadow's audited egress broker. */
  fetcher?: ProbeFetch;
}

interface ProbeCandidate {
  url: string;
  /** Base URL Shadow should use for inference if this candidate succeeds. */
  baseUrl: string;
  shape: 'openai' | 'ollama';
}

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 1_000;

function cleanBaseUrl(value: string | undefined): string | undefined {
  const raw = value?.trim().replace(/\/+$/, '');
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Candidate order follows the successful OpenClaw/Hermes pattern: exact URL first, then
 * toggle `/v1`; Ollama's native catalog is also understood because it carries the real tags. */
export function modelEndpointCandidates(baseUrl: string, adapter: ProbeAdapter): ProbeCandidate[] {
  const normalized = cleanBaseUrl(baseUrl);
  if (!normalized) return [];
  const url = new URL(normalized);
  const path = url.pathname.replace(/\/+$/, '');
  const root = url.origin;
  const isV1 = /\/v1$/i.test(path);
  const looksOllama = url.port === '11434' || /ollama/i.test(url.hostname);
  const out: ProbeCandidate[] = [];

  if (looksOllama && adapter !== 'anthropic') {
    const serverRoot = isV1 ? normalized.replace(/\/v1$/i, '') : normalized;
    out.push({ url: `${serverRoot}/api/tags`, baseUrl: `${serverRoot}/v1`, shape: 'ollama' });
  }

  out.push({ url: `${normalized}/models`, baseUrl: normalized, shape: 'openai' });

  // Only toggle a simple root or a terminal /v1. Provider paths such as Z.ai's /paas/v4 or
  // DashScope's /compatible-mode/v1 must not be rewritten into invented URLs.
  if (isV1) {
    const withoutV1 = normalized.replace(/\/v1$/i, '');
    out.push({ url: `${withoutV1}/models`, baseUrl: withoutV1, shape: 'openai' });
  } else if (path === '' || path === '/') {
    out.push({
      url: `${root}/v1/models`,
      baseUrl: adapter === 'anthropic' ? normalized : `${root}/v1`,
      shape: 'openai',
    });
  }

  const seen = new Set<string>();
  return out.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

/** Parse OpenAI/Anthropic `data[].id`, Ollama `models[].name`, and common lightweight variants. */
export function parseModelCatalog(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  let raw: unknown[] | undefined;
  let keys: string[];
  if (Array.isArray(obj.data)) {
    raw = obj.data;
    keys = ['id', 'name', 'model'];
  } else if (Array.isArray(obj.models)) {
    raw = obj.models;
    keys = ['id', 'name', 'model'];
  } else {
    return null;
  }
  const ids: string[] = [];
  for (const row of raw.slice(0, MAX_MODELS)) {
    let value: unknown = row;
    if (row && typeof row === 'object') {
      const rec = row as Record<string, unknown>;
      value = keys.map((key) => rec[key]).find((candidate) => typeof candidate === 'string');
    }
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) continue;
    ids.push(id);
  }
  return unique(ids);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
    throw new Error('model catalog is larger than 2 MiB');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_BYTES) throw new Error('model catalog is larger than 2 MiB');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

/**
 * Did the request fail to REACH the host (as opposed to reaching it and getting a non-2xx)?
 *
 * The candidate list toggles a PATH on the same origin (`/models` vs `/v1/models`), so it only
 * helps when the host is up and the path is wrong. When the connection itself is refused or the
 * name does not resolve, every remaining candidate targets the same unreachable origin and is
 * guaranteed to fail the same way — trying them just multiplies the timeout the caller waits.
 * Named so the intent is legible at the call site rather than an inline string match.
 */
function isUnreachableError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string }; code?: string } | undefined);
  const c = code?.cause?.code ?? code?.code ?? '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(c)) return true;
  const msg = error instanceof Error ? error.message : String(error);
  // A TIMEOUT counts too. The candidates differ only by a PATH on the same origin, so a host that
  // swallowed one request is not going to answer the other — and a black-holed route (a VPN that is
  // down drops packets rather than refusing them) would otherwise cost one full timeout PER
  // candidate. The asymmetry is what settles it: bailing early costs at most a missed alternate
  // path on a pathological proxy, while not bailing costs every user a multiplicative boot delay
  // whenever their inference box is off.
  const name = (error as { name?: string } | undefined)?.name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|timed out|timeout/i.test(msg);
}

function safeError(error: unknown): string {
  const clean = redactString(error instanceof Error ? error.message : String(error));
  return clean.length > 300 ? clean.slice(0, 300) + '…' : clean;
}

function hostingFor(
  baseUrl: string | undefined,
  hint: ProbeEndpointOptions['hostingHint'],
): EndpointHosting {
  if (hint) return hint;
  return isLocalBaseUrl(baseUrl) ? 'self-hosted' : 'unknown';
}

function authHeaders(
  adapter: 'openai' | 'anthropic',
  apiKey?: string,
  authToken?: string,
): Record<string, string> {
  const key = authToken || apiKey;
  if (adapter === 'anthropic') {
    return {
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : key ? { 'x-api-key': key } : {}),
    };
  }
  return {
    accept: 'application/json',
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  };
}

export async function probeModelEndpoint(
  options: ProbeEndpointOptions,
): Promise<EndpointProbeResult> {
  registerSecret(options.apiKey);
  registerSecret(options.authToken);
  const baseUrl = cleanBaseUrl(options.baseUrl);
  const fallbackModels = unique(
    (options.fallbackModels ?? []).map((m) => m.trim()).filter(Boolean),
  );
  const fallback = (error?: string): EndpointProbeResult => ({
    ok: false,
    models: fallbackModels,
    source: fallbackModels.length ? 'curated' : 'none',
    compatibility: options.adapter === 'anthropic' ? 'anthropic' : 'openai',
    hosting: hostingFor(baseUrl, options.hostingHint),
    baseUrl,
    ...(error ? { error } : {}),
  });
  if (!baseUrl) return fallback('Enter a valid http(s) base URL.');

  const adapters: ('openai' | 'anthropic')[] =
    options.adapter === 'auto' ? ['openai', 'anthropic'] : [options.adapter];
  const timeoutMs = options.timeoutMs ?? 6_000;
  let lastError = 'model discovery is not supported by this endpoint';

  for (const adapter of adapters) {
    for (const candidate of modelEndpointCandidates(baseUrl, adapter)) {
      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        const fetcher: ProbeFetch =
          options.fetcher ??
          ((url, init) => shadowFetch(url, init, { purpose: 'provider', origin: 'user' }));
        response = await fetcher(candidate.url, {
          method: 'GET',
          headers: authHeaders(adapter, options.apiKey, options.authToken),
          redirect: 'error',
          signal,
        });
      } catch (error) {
        lastError = safeError(error);
        // A dead host fails every path variant identically; stop rather than serially re-timing-out.
        if (isUnreachableError(error)) return fallback(lastError);
        continue;
      }
      if (!response.ok) {
        lastError = `model catalog returned HTTP ${response.status}`;
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      try {
        const parsed = parseModelCatalog(await readBoundedJson(response));
        if (!parsed) {
          lastError = 'model catalog returned an unrecognized response';
          continue;
        }
        return {
          ok: true,
          models: parsed,
          source: 'live',
          compatibility: adapter,
          hosting: hostingFor(candidate.baseUrl, options.hostingHint),
          baseUrl: candidate.baseUrl,
          modelsUrl: candidate.url,
        };
      } catch (error) {
        lastError = safeError(error);
      }
    }
  }
  return fallback(lastError);
}

/** Parse terminal multi-selection such as `1,3-5`, `all`, or exact model IDs. */
export function parseModelSelection(
  input: string,
  shown: string[],
  allModels = shown,
): string[] | null {
  const value = input.trim();
  if (!value) return [];
  if (value.toLowerCase() === 'all') return [...shown];
  const picked: string[] = [];
  for (const token of value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start || end > shown.length) return null;
      for (let i = start; i <= end; i++) picked.push(shown[i - 1]!);
      continue;
    }
    if (/^\d+$/.test(token)) {
      const index = Number(token) - 1;
      if (!shown[index]) return null;
      picked.push(shown[index]!);
      continue;
    }
    const exact = allModels.find((model) => model.toLowerCase() === token.toLowerCase());
    if (!exact) return null;
    picked.push(exact);
  }
  return unique(picked);
}
