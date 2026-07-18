/**
 * Provider-error → actionable recovery hint. Pure + dependency-free + unit-testable.
 *
 * Provider errors surface to the HUD as `<code>: <message>` (e.g. "http_400: max_tokens=16000
 * cannot be greater than max_model_len=8192", "network_error: Unable to connect …"). The raw text
 * tells the user WHAT failed but not WHAT TO DO. This maps the error to one Shadow-specific,
 * actionable next step, rendered as a dim `↳ …` line beneath the error. Returns null when nothing
 * useful can be said (better silence than a generic platitude).
 *
 * Classification reads BOTH the leading code and the message body — an `http_400` can be a context
 * overflow (recoverable by lowering tokens) or a bad model id (a config problem), and only the
 * message distinguishes them.
 */
export function providerErrorHint(raw: string): string | null {
  if (!raw) return null;
  const msg = raw.toLowerCase();
  // Leading token: `http_400`, `network_error`, `idle_timeout`, … (before the first ':' or '-').
  const code = /^\s*(http_\d{3}|[a-z]+(?:_[a-z0-9]+)+)\s*[:-]/.exec(msg)?.[1] ?? '';
  const has = (re: RegExp): boolean => re.test(msg);

  // Context / token overflow — check FIRST: it often arrives as a generic http_400 whose message
  // is the only signal, and it's the most common recoverable failure on small-window local models.
  if (has(/max_tokens|max_model_len|max_total_tokens|context length|context window|maximum context|too many tokens|reduce the length|exceeds? the (model|maximum|context)/)) {
    return 'Request exceeds the model’s context. Lower the output cap (/config set maxOutputTokens <n>), /compact to shrink history, or serve the model with a bigger context (llama.cpp -c / vLLM --max-model-len).';
  }
  // Network / connection.
  if (code === 'network_error' || has(/unable to connect|econnrefused|enotfound|eai_again|network error|fetch failed|socket hang up|connection (refused|reset|timed out)|dns/)) {
    return 'Can’t reach the endpoint. Check it’s running and the base URL is correct (try curl-ing it); /doctor lists your endpoints. For a local model, confirm the server is up.';
  }
  // Auth.
  if (code === 'http_401' || code === 'http_403' || has(/invalid api key|incorrect api key|unauthorized|authentication|permission denied|forbidden|missing.*key|no api key/)) {
    return 'Auth was rejected. Re-check your key or re-run `shadow onboard` (or /login). Env vars (ANTHROPIC_API_KEY, …) override the saved config.';
  }
  // Rate limit / quota.
  if (code === 'http_429' || has(/rate limit|too many requests|quota|insufficient_quota|billing/)) {
    return 'Rate-limited or out of quota. Wait a moment and retry, or /model to switch to another provider.';
  }
  // Overloaded (Anthropic 529 / "overloaded_error").
  if (has(/overload/) || code === 'http_529') {
    return 'Provider is overloaded. Shadow auto-retries once; try again shortly, or /model to switch.';
  }
  // Idle / timeout.
  if (code === 'idle_timeout' || has(/idle_timeout|timed out|timeout|no response/)) {
    return 'The model went quiet before answering. Retry — a local model may still be loading, or give reasoning models more output headroom (--max-output-tokens).';
  }
  // Content filter.
  if (code === 'content_filter' || has(/content filter|content_policy|content policy|safety|flagged|blocked by/)) {
    return 'The provider’s content filter blocked this. Rephrase the request, or run a model without the filter.';
  }
  // Server errors (5xx).
  if (/^http_5\d{2}$/.test(code) || has(/internal server error|bad gateway|service unavailable|gateway timeout/)) {
    return 'The provider had a server error. Retry, or /model to switch.';
  }
  // Generic bad request / unknown model.
  if (code === 'http_400' || has(/bad request|invalid request|unknown model|model not found|does not exist|no such model/)) {
    return 'The endpoint rejected the request — check the model id and base URL (/provider shows the active config).';
  }
  return null;
}
