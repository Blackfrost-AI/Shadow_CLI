import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../src/provider/anthropic.js';

// The constructor builds the request URL; read the private field for the assertion.
const urlFor = (baseUrl?: string): string =>
  (new AnthropicProvider({ model: 'm', baseUrl }) as unknown as { url: string }).url;

test('AnthropicProvider strips a stray trailing /v1 before appending /v1/messages', () => {
  assert.equal(urlFor(undefined), 'https://api.anthropic.com/v1/messages');
  assert.equal(urlFor('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  // The distilled-model fix: an Ollama/OpenAI-compat base ending in /v1 must NOT become /v1/v1.
  assert.equal(urlFor('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/messages');
  assert.equal(urlFor('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1/messages');
  assert.equal(urlFor('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1/messages');
  assert.equal(urlFor('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434/v1/messages');
});
