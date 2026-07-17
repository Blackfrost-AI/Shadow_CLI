/**
 * providerErrorHint — maps a provider error to one actionable recovery hint.
 * Covers the real errors seen in the field (context overflow, network) + every category.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerErrorHint } from '../src/util/errorHints.js';

test('context overflow (the max_tokens>max_model_len case) → lower-tokens / compact hint', () => {
  const h = providerErrorHint('http_400: max_tokens=16000 cannot be greater than max_model_len=max_total_tokens=8192');
  assert.ok(h && /context/i.test(h), 'names the context limit');
  assert.match(h!, /maxOutputTokens|\/compact|max-model-len/, 'offers a concrete lever');
});

test('other context phrasings also classify as context overflow', () => {
  for (const m of [
    'http_400: This model’s maximum context length is 8192 tokens',
    'http_400: reduce the length of the messages',
    'stream_error: too many tokens in the request',
  ]) {
    assert.ok(/context/i.test(providerErrorHint(m) ?? ''), `context hint for: ${m}`);
  }
});

test('network errors → reachability hint (the second thing Craig hit)', () => {
  for (const m of ['network_error: Unable to connect. Is the computer able to access the url?', 'network_error: fetch failed', 'stream_error: ECONNREFUSED']) {
    const h = providerErrorHint(m);
    assert.ok(h && /reach|endpoint|running|curl/i.test(h), `network hint for: ${m}`);
  }
});

test('auth (401/403) → re-key / onboard hint', () => {
  assert.match(providerErrorHint('http_401: invalid api key')!, /key|onboard|login/i);
  assert.match(providerErrorHint('http_403: forbidden')!, /key|onboard|login/i);
});

test('rate limit / overloaded / server / timeout / content-filter each get a distinct hint', () => {
  assert.match(providerErrorHint('http_429: rate limit exceeded')!, /rate-limit|quota|\/model/i);
  assert.match(providerErrorHint('overloaded_error: Overloaded')!, /overload|retr|\/model/i);
  assert.match(providerErrorHint('http_503: service unavailable')!, /server error|retry|\/model/i);
  assert.match(providerErrorHint('idle_timeout: model went quiet')!, /retry|loading|headroom/i);
  assert.match(providerErrorHint('content_filter: blocked by content policy')!, /filter|rephrase/i);
});

test('bad model id (generic 400) → check model/base-url hint, distinct from context overflow', () => {
  const h = providerErrorHint('http_400: unknown model "gpt-9"');
  assert.ok(h && /model id|base url|\/provider/i.test(h));
  assert.doesNotMatch(h!, /maxOutputTokens/, 'not misclassified as a context overflow');
});

test('unclassifiable / empty → null (better silence than a platitude)', () => {
  assert.equal(providerErrorHint(''), null);
  assert.equal(providerErrorHint('mock_provider_error: deterministic test error'), null);
});
