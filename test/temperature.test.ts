import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { buildAnthropicBody } from '../src/provider/anthropic.js';
import { buildOpenAIBody, OpenAIProvider } from '../src/provider/openai.js';
import { buildResponsesBody, ResponsesProvider } from '../src/provider/responses.js';
import type { CompletionRequest, Provider } from '../src/provider/provider.js';
import { buildLoopDeps } from '../src/agent/loopDeps.js';
import { Context } from '../src/agent/context.js';
import { runModelCheck } from '../src/doctor/modelCheck.js';
import { resolveFakeHosts } from './helpers/fakeHostEgress.js';

// loadConfig reads ~/.shadow at module load. Keep these validation tests hermetic so a
// developer's real temperature preference cannot change the expected default.
const { home: HOME } = isolateHome('temperature');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const { loadConfig } = await import('../src/config.js');
const { resolveStartSelfHosted } = await import('../src/agent/bootstrap.js');

const request = (model = 'qwen3-coder', temperature?: number): CompletionRequest => ({
  model,
  system: 'system',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [],
  maxOutputTokens: 1024,
  temperature,
});

async function drain(provider: Provider, req: CompletionRequest): Promise<void> {
  for await (const _event of provider.send(req)) {
    // Request-body capture is the assertion target; consume the stream to completion.
  }
}

test('temperature config defaults to 1.0 and accepts the inclusive 0..2 range', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'shadow-temperature-config-'));
  try {
    assert.equal(loadConfig(workspace).temperature, 1.0);

    for (const value of [0, 0.35, 1, 2]) {
      writeFileSync(join(workspace, 'shadow.config.json'), JSON.stringify({ temperature: value }));
      assert.equal(loadConfig(workspace).temperature, value);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('remote self-hosted endpoints can opt in explicitly at the top level or per preset', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'shadow-temperature-remote-config-'));
  try {
    // CLI overrides stand in for the trusted global config layer. A project-local config is
    // intentionally not allowed to assert this endpoint-trust marker (see config-security tests).
    const cfg = loadConfig(workspace, {
      provider: 'openai',
      model: 'remote-local-model',
      baseUrl: 'https://models.example.net/v1',
      selfHosted: true,
      models: [
        {
          label: 'remote-self-host',
          provider: 'openai',
          model: 'remote-local-model',
          baseUrl: 'https://models.example.net/v1',
          selfHosted: true,
        },
      ],
    });
    assert.equal(cfg.selfHosted, true);
    assert.equal(cfg.models[0]?.selfHosted, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('startup scopes explicit self-host trust to the endpoint it describes', () => {
  const remote = 'https://models.example.net/v1';
  assert.equal(
    resolveStartSelfHosted({
      provider: 'openai',
      baseUrl: remote,
      entrySelfHosted: undefined,
      configSelfHosted: true,
    }),
    true,
    'an unmarked same-model preset inherits the documented top-level marker',
  );
  assert.equal(
    resolveStartSelfHosted({
      provider: 'openai',
      baseUrl: remote,
      entrySelfHosted: false,
      entrySelected: true,
      configSelfHosted: true,
    }),
    false,
    'an explicit preset false clears a stale top-level marker',
  );
  assert.equal(
    resolveStartSelfHosted({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      entryBaseUrl: remote,
      entrySelfHosted: true,
    }),
    false,
    'a same-named preset cannot lend its marker to a different active endpoint',
  );
  assert.equal(
    resolveStartSelfHosted({
      provider: 'openai',
      baseUrl: remote,
      entryBaseUrl: `${remote}/`,
      entrySelfHosted: true,
    }),
    true,
    'an automatically matched preset may mark the exact endpoint it describes',
  );
  assert.equal(
    resolveStartSelfHosted({
      provider: 'openai',
      baseUrl: 'https://gateway.example.net/v1?target=cloud',
      entryBaseUrl: 'https://gateway.example.net/v1?target=selfhost',
      entrySelfHosted: true,
    }),
    false,
    'request-significant gateway query parameters are part of endpoint identity',
  );
  assert.equal(
    resolveStartSelfHosted({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      baseUrlOverridden: true,
      configSelfHosted: true,
    }),
    false,
    'a one-run base-url override cannot inherit another endpoint\'s trust marker',
  );
  assert.equal(
    resolveStartSelfHosted({
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:8080/v1',
      baseUrlOverridden: true,
    }),
    true,
    'local endpoints remain automatic even when selected by flag',
  );
  assert.equal(
    resolveStartSelfHosted({
      provider: 'anthropic',
      baseUrl: remote,
      configSelfHosted: true,
    }),
    false,
    'native providers never advertise the OpenAI-compatible sampling control',
  );
});

test('buildLoopDeps carries the live config value into the next agent turn', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'shadow-temperature-loop-'));
  try {
    const cfg = loadConfig(workspace, { provider: 'mock', model: 'mock', temperature: 0.28 });
    const deps = buildLoopDeps({
      cfg,
      provider: {} as Provider,
      registry: {} as never,
      gate: {} as never,
      bus: {} as never,
      budget: {} as never,
      context: {} as never,
      signal: new AbortController().signal,
      model: 'mock',
      system: 'system',
      workspaceRoot: workspace,
      streamShell: false,
    });
    assert.equal(deps.temperature, 0.28);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('temperature config rejects non-numbers and values outside 0..2', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'shadow-temperature-invalid-'));
  try {
    for (const value of [-0.01, 2.01, '0.7', null]) {
      writeFileSync(join(workspace, 'shadow.config.json'), JSON.stringify({ temperature: value }));
      assert.throws(() => loadConfig(workspace), /temperature:/);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Chat Completions emits temperature only when the provider proves it is self-hosted', () => {
  const configured = request('qwen3-coder', 0.4);
  assert.equal(buildOpenAIBody(configured, configured.model, true).temperature, undefined);
  assert.equal(
    buildOpenAIBody(configured, configured.model, true, { selfHosted: true }).temperature,
    0.4,
  );
  assert.equal(
    buildOpenAIBody(request('qwen3-coder'), 'qwen3-coder', true, { selfHosted: true }).temperature,
    1.0,
    'direct local probes without a config-bearing loop still get the documented default',
  );
});

test('OpenAI reasoning models never receive temperature, even on a self-hosted endpoint', () => {
  const body = buildOpenAIBody(request('gpt-5', 0.4), 'gpt-5', true, { selfHosted: true });
  assert.equal(body.temperature, undefined);
});

test('Responses wire follows the same self-hosted-only temperature gate', () => {
  const configured = request('qwen3-coder', 0.65);
  assert.equal(buildResponsesBody(configured, configured.model, true).temperature, undefined);
  assert.equal(
    buildResponsesBody(configured, configured.model, true, { selfHosted: true }).temperature,
    0.65,
  );
});

test('provider instances gate temperature from their actual endpoint across both wire APIs', async () => {
  const originalFetch = globalThis.fetch;
  const restoreEgress = resolveFakeHosts(); // models.example.net etc. are not resolvable — let them reach the stub
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const data = String(url).endsWith('/responses')
      ? 'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
      : 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
    return new Response(data, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const req = request('qwen3-coder', 0.42);
    await drain(new OpenAIProvider({ model: req.model, baseUrl: 'http://127.0.0.1:8080/v1' }), req);
    await drain(new OpenAIProvider({ model: req.model, baseUrl: 'https://api.openai.com/v1' }), req);
    await drain(
      new OpenAIProvider({
        model: req.model,
        baseUrl: 'https://models.example.net/v1',
        selfHosted: true,
      }),
      req,
    );
    await drain(new ResponsesProvider({ model: req.model, baseUrl: 'http://10.0.0.8:8000/v1' }), req);
    await drain(new ResponsesProvider({ model: req.model, baseUrl: 'https://api.openai.com/v1' }), req);
    await drain(
      new ResponsesProvider({
        model: req.model,
        baseUrl: 'https://models.example.net/v1',
        selfHosted: true,
      }),
      req,
    );
  } finally {
    restoreEgress();
    globalThis.fetch = originalFetch;
  }

  assert.equal(bodies[0]?.temperature, 0.42, 'loopback Chat Completions receives temperature');
  assert.equal(bodies[1]?.temperature, undefined, 'cloud Chat Completions never receives temperature');
  assert.equal(bodies[2]?.temperature, 0.42, 'explicit remote self-host Chat Completions receives temperature');
  assert.equal(bodies[3]?.temperature, 0.42, 'private-LAN Responses receives temperature');
  assert.equal(bodies[4]?.temperature, undefined, 'cloud Responses never receives temperature');
  assert.equal(bodies[5]?.temperature, 0.42, 'explicit remote self-host Responses receives temperature');
});

test('compaction and model diagnostics preserve the configured local temperature', async () => {
  const requests: CompletionRequest[] = [];
  const provider: Provider = {
    name: 'capture',
    estimateTokens: () => 100_000,
    async *send(req) {
      requests.push(req);
      yield { type: 'text', delta: 'summary' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };

  const context = new Context({ contextBudget: 1_000, triggerRatio: 0.5, keepLastTurns: 1 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'original task' }] });
  context.append({ role: 'assistant', content: [{ type: 'text', text: 'older work' }] });
  context.append({ role: 'user', content: [{ type: 'text', text: 'recent instruction' }] });
  assert.equal(
    await context.maybeSummarize(provider, 'qwen3-coder', true, undefined, { temperature: 0.36 }),
    'summarized',
  );
  assert.equal(requests[0]?.temperature, 0.36, 'compaction request uses the live value');

  requests.length = 0;
  await runModelCheck(provider, {
    model: 'qwen3-coder',
    temperature: 0.36,
    perTurnTimeoutMs: 100,
    maxAutonomousTurns: 1,
  });
  assert.ok(requests.length > 1, 'the diagnostic issued multiple probes');
  assert.ok(requests.every((req) => req.temperature === 0.36));
});

test('Anthropic never receives the self-hosted OpenAI-compatible sampling option', () => {
  const body = buildAnthropicBody(request('claude-opus-4-8', 0.2), 'claude-opus-4-8');
  assert.equal(body.temperature, undefined);
});
