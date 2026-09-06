import { resolveBaseUrl, resolveEntryCredential, type ModelEntry } from '../config.js';
import { vaultExists } from '../auth/vault.js';
import { vaultUnlocked } from '../state/globalStore.js';
import { shadowFetch, isOfflineMode } from '../safety/egress.js';

export type ProbeKind = 'endpoint' | 'response';
export interface ProbeResult {
  ok: boolean;
  kind: ProbeKind;
  message: string;
  elapsedMs: number;
  status?: number;
  modelAvailable?: boolean;
}

/** Public diagnostics never expose URL credentials, query parameters or provider error bodies. */
export function endpointLabel(value?: string): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.origin + url.pathname; } catch { return '(invalid endpoint)'; }
}

export function credentialStatus(entry: ModelEntry): string {
  const credential = resolveEntryCredential(entry, { vaultIsLocked: vaultExists() && !vaultUnlocked() });
  if (!credential.ok) return `Model credential ${credential.reason}`;
  if (credential.source === 'credRef') return 'Model-specific vault key';
  if (credential.source === 'inline') return 'Model-specific key';
  if (credential.apiKey || credential.authToken) return 'Shared provider credential — check this belongs to this endpoint';
  return vaultExists() && !vaultUnlocked() ? 'Vault locked — credentials not checked' : 'No key configured';
}

/** A single, explicit test of a saved endpoint. No discovery scans, tool calls, workspace data,
 * automatic retries or redirect-following. Response tests send only a fixed synthetic prompt. */
export async function probeModel(entry: ModelEntry, kind: ProbeKind, parentSignal?: AbortSignal): Promise<ProbeResult> {
  const started = Date.now();
  const result = (ok: boolean, message: string, extra: Partial<ProbeResult> = {}): ProbeResult =>
    ({ ok, kind, message, elapsedMs: Date.now() - started, ...extra });
  if (entry.provider === 'mock') return result(true, 'Offline demo provider; no network request sent.');
  if (entry.gguf || entry.mlx || entry.vllm) return result(false, 'Start this managed model in Shadow first. This test does not launch model servers.');
  const credential = resolveEntryCredential(entry, { vaultIsLocked: vaultExists() && !vaultUnlocked() });
  if (!credential.ok) return result(false, `The model credential is ${credential.reason}. Unlock the vault or reconnect this model’s key.`);
  if (vaultExists() && !vaultUnlocked() && !credential.apiKey && !credential.authToken) {
    return result(false, 'Unlock the credential vault in the terminal, then retry.');
  }
  const base = resolveBaseUrl(entry.provider, entry.baseUrl)
    ?? (entry.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
  let url: URL;
  try {
    url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return result(false, 'Use an HTTP(S) base URL without embedded credentials, a query or a fragment.');
    }
  } catch { return result(false, 'The saved endpoint URL is invalid.'); }
  const path = url.pathname.replace(/\/$/, '');
  url.pathname = entry.provider === 'anthropic'
    ? `${path.endsWith('/v1') ? path : path + '/v1'}/${kind === 'endpoint' ? 'models' : 'messages'}`
    : `${path}/${kind === 'endpoint' ? 'models' : 'chat/completions'}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (entry.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (credential.authToken) headers.Authorization = `Bearer ${credential.authToken}`;
    else if (credential.apiKey) headers['x-api-key'] = credential.apiKey;
  } else if (credential.apiKey) headers.Authorization = `Bearer ${credential.apiKey}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) controller.abort();
  const timer = setTimeout(abort, 15_000);
  try {
    if (kind === 'response') headers['Content-Type'] = 'application/json';
    const response = await shadowFetch(url.toString(), {
      method: kind === 'endpoint' ? 'GET' : 'POST', headers, redirect: 'manual', signal: controller.signal,
      ...(kind === 'response' ? { body: JSON.stringify({ model: entry.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 64, stream: false }) } : {}),
    }, { purpose: 'provider', origin: 'user' });
    const status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      const message = status === 401 || status === 403
        ? 'Authentication rejected. Check the model’s credential source, key and account access for this endpoint.'
        : status === 404 || status === 405
          ? kind === 'endpoint' ? 'This endpoint does not expose a models API at this path. Check the base URL or try Test response.' : 'Response API not found. Check the base URL and adapter.'
          : status === 429 ? 'Provider rate limit or quota reached. Wait or check your account.'
            : status >= 300 && status < 400 ? 'The endpoint redirects. Update the saved base URL; credentials were not forwarded.'
              : 'The provider rejected the test. Check the model ID, adapter and server logs.';
      return result(false, message, { status });
    }
    // Bound the response as well as request time. Never return raw model output or echoed keys.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 256 * 1024) { await reader.cancel(); return result(false, 'The test response exceeded the 256 KB limit.', { status }); }
        chunks.push(next.value);
      }
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return result(false, 'The endpoint returned non-JSON content. Check that the base URL points to an API, not a web page.', { status }); }
    if (kind === 'endpoint') {
      if (!Array.isArray(body?.data)) return result(false, 'Connected, but the response is not a supported models list. Try Test response.', { status });
      const ids: string[] = body.data.flatMap((m: { id?: unknown }) => typeof m?.id === 'string' && m.id.length <= 200 ? [m.id] : []);
      const available = ids.includes(entry.model);
      // Model names are remote data: do not echo them; only report counts and exact-match status.
      return result(true, `Models API reachable (${ids.length} models). ${available ? 'Your model is listed.' : 'Your model is not listed; some services list only a subset. Try Test response.'}`, { status, modelAvailable: available });
    }
    const answered = entry.provider === 'anthropic'
      ? Array.isArray(body?.content) && body.content.some((p: { type?: string; text?: string }) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim())
      : Array.isArray(body?.choices) && body.choices.some((c: { message?: { content?: unknown } }) => typeof c?.message?.content === 'string' && c.message.content.trim());
    return result(Boolean(answered), answered
      ? 'Model returned a text response. Endpoint, authentication and basic generation work. Tool calling was not tested.'
      : 'The API accepted the request but returned no text within the 64-token test. Reasoning models may need a larger output budget.', { status });
  } catch {
    return result(false, controller.signal.aborted ? 'Test cancelled or timed out after 15 seconds.'
      : isOfflineMode() ? 'Could not connect. Offline mode only permits local endpoints; check the server address and network.'
        : 'Could not connect. Check the server address, network and TLS certificate.');
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}
