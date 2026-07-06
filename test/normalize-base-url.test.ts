import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseUrl, resolveBaseUrl } from '../src/config.js';

/**
 * Regression guard for the poisoned-baseUrl bug: the onboarding prompt showed the
 * default as "Base URL [http://host:8813/v1]", and entering that literal hint saved
 * "[http://host:8813/v1]" to config. resolveBaseUrl returned it FIRST, so every
 * request died with "Failed to parse URL" on flag/eval/sub-agent paths.
 */

test('normalizeBaseUrl: strips the bracket-wrapped hint (the exact poison value)', () => {
  assert.equal(normalizeBaseUrl('[http://127.0.0.1:8813/v1]'), 'http://127.0.0.1:8813/v1');
});

test('normalizeBaseUrl: passes a clean http(s) URL through unchanged', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8815/v1'), 'http://127.0.0.1:8815/v1');
});

test('normalizeBaseUrl: strips quotes / angle brackets / whitespace', () => {
  assert.equal(normalizeBaseUrl('  "http://x:1/v1"  '), 'http://x:1/v1');
  assert.equal(normalizeBaseUrl('<http://x:1/v1>'), 'http://x:1/v1');
  assert.equal(normalizeBaseUrl("'http://x:1/v1'"), 'http://x:1/v1');
});

test('normalizeBaseUrl: undefined for empty / garbage / non-http', () => {
  assert.equal(normalizeBaseUrl(''), undefined);
  assert.equal(normalizeBaseUrl('   '), undefined);
  assert.equal(normalizeBaseUrl('not a url'), undefined);
  assert.equal(normalizeBaseUrl('ftp://x/v1'), undefined);
  assert.equal(normalizeBaseUrl(undefined), undefined);
});

test('resolveBaseUrl: cleans a poisoned configured value instead of returning it raw', () => {
  assert.equal(resolveBaseUrl('openai', '[http://127.0.0.1:8813/v1]'), 'http://127.0.0.1:8813/v1');
});
