import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelEndpointCandidates,
  parseModelCatalog,
  parseModelSelection,
  probeModelEndpoint,
} from '../src/onboard/probe.js';
import { onboardModelSelectionUpsert } from '../src/onboard/persistTarget.js';
import type { ModelEntry } from '../src/config.js';

test('model endpoint candidates try the entered URL and a useful /v1 variant', () => {
  assert.deepEqual(
    modelEndpointCandidates('http://localhost:8000', 'openai').map((candidate) => [
      candidate.url,
      candidate.baseUrl,
    ]),
    [
      ['http://localhost:8000/models', 'http://localhost:8000'],
      ['http://localhost:8000/v1/models', 'http://localhost:8000/v1'],
    ],
  );
  assert.equal(
    modelEndpointCandidates('https://api.z.ai/api/coding/paas/v4', 'openai').length,
    1,
    'provider-specific paths are not rewritten into an invented /v1 URL',
  );
  assert.equal(
    modelEndpointCandidates('http://localhost:11434/v1', 'openai')[0]?.url,
    'http://localhost:11434/api/tags',
  );
});

test('catalog parser accepts OpenAI/Anthropic and Ollama shapes, sanitizes, and de-duplicates', () => {
  assert.deepEqual(
    parseModelCatalog({ data: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }, { id: 'glm-5.3' }] }),
    ['glm-5.3', 'glm-5.3-flash'],
  );
  assert.deepEqual(
    parseModelCatalog({ models: [{ name: 'qwen3:latest' }, { model: 'devstral' }] }),
    ['qwen3:latest', 'devstral'],
  );
  assert.equal(parseModelCatalog({ choices: [] }), null);
});

test('live probe falls back from root /models to /v1/models and returns the working inference base', async () => {
  const calls: string[] = [];
  const result = await probeModelEndpoint({
    adapter: 'openai',
    baseUrl: 'http://localhost:8000',
    fetcher: async (url) => {
      calls.push(url);
      return url.endsWith('/v1/models')
        ? new Response(JSON.stringify({ data: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('not found', { status: 404 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'live');
  assert.equal(result.baseUrl, 'http://localhost:8000/v1');
  assert.equal(result.hosting, 'self-hosted');
  assert.deepEqual(result.models, ['glm-5.3', 'glm-5.3-flash']);
  assert.deepEqual(calls, ['http://localhost:8000/models', 'http://localhost:8000/v1/models']);
});

test('auto compatibility retries model discovery with Anthropic headers', async () => {
  const result = await probeModelEndpoint({
    adapter: 'auto',
    baseUrl: 'https://models.example.test',
    apiKey: 'secret-probe-key',
    fetcher: async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      return headers['x-api-key']
        ? new Response(JSON.stringify({ data: [{ id: 'claude-custom' }] }), { status: 200 })
        : new Response('unauthorized', { status: 401 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.compatibility, 'anthropic');
  assert.equal(
    result.hosting,
    'unknown',
    'a public custom URL cannot honestly be called self-hosted from its URL alone',
  );
});

test('failed discovery preserves curated agentic recommendations', async () => {
  const result = await probeModelEndpoint({
    adapter: 'openai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    fallbackModels: ['glm-5.3', 'glm-5.3-flash'],
    hostingHint: 'hosted',
    fetcher: async () => new Response('not found', { status: 404 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.source, 'curated');
  assert.equal(result.hosting, 'hosted');
  assert.deepEqual(result.models, ['glm-5.3', 'glm-5.3-flash']);
});

test('terminal multi-select accepts indexes, ranges, all, and exact discovered IDs', () => {
  const shown = ['glm-5.3', 'glm-5.3-flash', 'glm-4.6', 'glm-4.5'];
  assert.deepEqual(parseModelSelection('1,3-4', shown), ['glm-5.3', 'glm-4.6', 'glm-4.5']);
  assert.deepEqual(parseModelSelection('all', shown), shown);
  assert.deepEqual(parseModelSelection('GLM-5.3-FLASH', shown), ['glm-5.3-flash']);
  assert.equal(parseModelSelection('9', shown), null);
});

test('selected onboarding models become a managed picker allowlist and stale managed entries are removed', () => {
  const baseUrl = 'https://api.z.ai/api/coding/paas/v4';
  const existing: ModelEntry[] = [
    { label: 'glm-4.6', provider: 'openai', model: 'glm-4.6', baseUrl, onboarded: true },
    { label: 'My manual model', provider: 'openai', model: 'private-glm', baseUrl },
  ];
  const next = onboardModelSelectionUpsert(existing, {
    provider: 'openai',
    model: 'glm-5.3',
    baseUrl,
    customEndpoint: false,
    selectedModels: ['glm-5.3', 'glm-5.3-flash'],
    entryGroup: 'Z.ai (GLM Coding Plan)',
  });
  assert.deepEqual(
    next.map((entry) => entry.model),
    ['private-glm', 'glm-5.3', 'glm-5.3-flash'],
  );
  assert.equal(
    next.find((entry) => entry.model === 'private-glm')?.onboarded,
    undefined,
    'manual preset survives',
  );
  assert.ok(
    next
      .filter((entry) => entry.onboarded)
      .every((entry) => entry.group === 'Z.ai (GLM Coding Plan)'),
  );
});

test('onboarding never takes ownership of an already matching manual preset', () => {
  const baseUrl = 'https://models.example.test/v1';
  const manual: ModelEntry = {
    label: 'My GLM default',
    provider: 'openai',
    model: 'glm-5.3',
    baseUrl,
    credRef: 'vault:custom-glm',
  };
  const selected = onboardModelSelectionUpsert([manual], {
    provider: 'openai',
    model: 'glm-5.3',
    baseUrl,
    customEndpoint: true,
    selectedModels: ['glm-5.3'],
  });
  assert.deepEqual(selected, [manual]);
  const deselected = onboardModelSelectionUpsert(selected, {
    provider: 'openai',
    model: 'glm-5.3-flash',
    baseUrl,
    customEndpoint: true,
    selectedModels: ['glm-5.3-flash'],
  });
  assert.ok(deselected.includes(manual), 'a later allowlist change still preserves the manual row');
});
