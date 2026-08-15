import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLocalBaseUrl } from '../src/safety/offline.js';

/**
 * C4 — an idle timeout re-fired the identical prompt at a server that was merely busy.
 *
 * On a llama.cpp / MLX serve doing prompt eval over 60k tokens, the 120s idle watchdog trips
 * while the server is working. The fallback then immediately re-POSTed the same body, so the
 * already-saturated machine had a SECOND copy of the same prompt queued, the first two minutes
 * were thrown away, and it did double the work to answer once. A REMOTE endpoint going silent is
 * usually a dropped connection worth retrying; a local one is usually just thinking.
 */
test('the idle re-fire is suppressed for local endpoints only', () => {
  const src = readFileSync(new URL('../src/provider/stream.ts', import.meta.url), 'utf8');
  // The C4 guard survives — a local/self-hosted idle trip must never re-POST the prompt.
  assert.match(
    src,
    /if \(reason === 'idle' && \(selfHosted \|\| isLocalBaseUrl\(a\.url\)\)\) return false;/,
    'an idle trip against a local/self-hosted URL must not re-POST the prompt',
  );
  // …and the idle call site must actually pass that reason, or the guard is dead code.
  assert.match(src, /nonStreamFallback\(a, 'idle', selfHosted\)/, "the idle path must tag itself as 'idle'");
  // The empty-response rescue stays for a NON-self-hosted endpoint (public API never started —
  // re-POST is free); but the SAME shape is tagged 'idle' for a headers-first self-hosted serve
  // that already received the prompt (vLLM/SGLang long prefill, P1A-04).
  assert.match(
    src,
    /nonStreamFallback\(a, selfHosted \? 'idle' : 'empty', selfHosted\)/,
    'the mid-stream stall rescue is tagged idle for selfHosted, empty otherwise',
  );
});

test('the local-URL predicate covers the shapes a local serve actually uses', () => {
  for (const u of [
    'http://127.0.0.1:8080/v1/chat/completions',
    'http://localhost:11434/v1/chat/completions',
    'http://[::1]:8000/v1/chat/completions',
  ]) {
    assert.equal(isLocalBaseUrl(u), true, `${u} is local`);
  }
  assert.equal(isLocalBaseUrl('https://api.anthropic.com/v1/messages'), false);
});

test('the non-stream rescue has its own timeout — it used to inherit none', () => {
  const src = readFileSync(new URL('../src/provider/stream.ts', import.meta.url), 'utf8');
  assert.match(src, /NON_STREAM_TIMEOUT_MS/, 'a bound exists');
  assert.match(
    src,
    /const watchdog = new IdleWatchdog\(NON_STREAM_TIMEOUT_MS\);/,
    'the request meant to rescue a stall must not be able to hang forever itself',
  );
});
