import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const CLI = resolve('src/index.ts');
const CLEARED_ENV = [
  'SHADOW_PROVIDER',
  'SHADOW_MODEL',
  'SHADOW_BASE_URL',
  'SHADOW_PROFILE',
  'SHADOW_HARNESSES',
  'SHADOW_ALLOW_IMPORT',
  'SHADOW_VAULT_PASSWORD',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

function isolatedFixture(): { home: string; workspace: string } {
  const home = mkdtempSync(join(tmpdir(), 'shadow-cli-base-url-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return { home, workspace };
}

function childEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // os.homedir() reads USERPROFILE on Windows and HOME on POSIX. Set both so a spawned CLI
  // cannot escape the fixture and accidentally read the Actions runner's real Shadow config.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of CLEARED_ENV) delete env[key];
  return { ...env, ...overrides };
}

function run(home: string, workspace: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', CLI, ...args, '--workspace', workspace], {
    // Package imports such as `tsx/esm` resolve from the repository. `--workspace` still gives
    // the launched Shadow process an isolated working tree for session/tool state.
    cwd: process.cwd(),
    env: childEnv(home, envOverrides),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function runAsync(home: string, workspace: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', CLI, ...args, '--workspace', workspace], {
      cwd: process.cwd(),
      env: childEnv(home, envOverrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

function installBootstrapSentinel(home: string): void {
  const harnessDir = join(home, '.shadow', 'harnesses', 'bootstrap-sentinel');
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, 'harness.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'bootstrap-sentinel',
      version: '1.0.0',
      title: 'Bootstrap Sentinel',
      description: 'Stops a CLI regression test before any provider traffic.',
      tools: { add: ['bootstrap_probe_sentinel'], remove: [] },
    }),
  );
}

test('fresh CLI provider/model/base-url flags reach bootstrap without onboarding or network', () => {
  const fixture = isolatedFixture();
  try {
    // This deliberately-unavailable required tool is a no-network bootstrap sentinel. Harness
    // readiness fails before provider construction, hooks, endpoint probing, or model traffic.
    installBootstrapSentinel(fixture.home);

    const result = run(fixture.home, fixture.workspace, [
      '--task',
      'unused',
      '--provider',
      'openai',
      '--model',
      'local-security-9b',
      '--base-url',
      'http://127.0.0.1:8908/v1',
      '--harness',
      'bootstrap-sentinel',
    ]);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /required tools are unavailable in this host: bootstrap_probe_sentinel/);
    assert.doesNotMatch(output, /No model provider configured/);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('CLI and SHADOW_BASE_URL preserve subscription endpoint binding', () => {
  for (const mode of ['flag', 'env'] as const) {
    const fixture = isolatedFixture();
    try {
      const configDir = join(fixture.home, '.shadow');
      mkdirSync(configDir, { recursive: true });
      const connection = { kind: 'chatgpt', profileId: 'fixture-account' };
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({
          provider: 'openai',
          model: 'gpt-fixture',
          connection,
          models: [
            {
              label: 'Fixture subscription',
              provider: 'openai',
              model: 'gpt-fixture',
              connection,
            },
          ],
        }),
      );

      const endpoint = 'http://127.0.0.1:8908/v1';
      const result = run(
        fixture.home,
        fixture.workspace,
        ['--task', 'unused', ...(mode === 'flag' ? ['--base-url', endpoint] : [])],
        mode === 'env' ? { SHADOW_BASE_URL: endpoint } : {},
      );
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

      assert.equal(result.status, 1, output);
      assert.match(output, /selected subscription connection cannot use --base-url or SHADOW_BASE_URL/);
      assert.doesNotMatch(output, /No model provider configured/);
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }
});

test('CLI and SHADOW_BASE_URL overrides cannot reuse a remembered endpoint preset credential or capability', async () => {
  const received: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'shared-model', context_length: 131072 }] }));
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) {
        res.writeHead(404).end();
        return;
      }
      received.push({
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpointB = `http://127.0.0.1:${address.port}/v1`;
  try {
    for (const mode of ['flag', 'env'] as const) {
      const fixture = isolatedFixture();
      try {
        const configDir = join(fixture.home, '.shadow');
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
          join(configDir, 'config.json'),
          JSON.stringify({
            provider: 'openai',
            model: 'shared-model',
            baseUrl: 'https://endpoint-a.example.test/v1',
            selfHosted: true,
            lastModel: 'Endpoint A',
            maxIterations: 2,
            models: [
              {
                label: 'Endpoint A',
                provider: 'openai',
                model: 'shared-model',
                baseUrl: 'https://endpoint-a.example.test/v1',
                selfHosted: true,
                apiKey: 'ENDPOINT_A_SECRET',
                capabilities: { chatTemplateEnableThinking: false },
              },
            ],
          }),
        );
        const endpointArgs = mode === 'flag' ? ['--base-url', endpointB] : [];
        const endpointEnv = mode === 'env' ? { SHADOW_BASE_URL: endpointB } : {};
        const result = await runAsync(
          fixture.home,
          fixture.workspace,
          ['--task', 'Reply with ok.', '--max-iterations', '2', '--max-output-tokens', '64', ...endpointArgs],
          { OPENAI_API_KEY: 'ENDPOINT_B_KEY', ...endpointEnv },
        );
        const output = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.status, 0, output);
      } finally {
        rmSync(fixture.home, { recursive: true, force: true });
      }
    }
    assert.equal(received.length, 2);
    for (const request of received) {
      assert.equal(request.authorization, 'Bearer ENDPOINT_B_KEY');
      assert.equal(request.body.chat_template_kwargs, undefined, 'endpoint A wire controls never reach endpoint B');
    }
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('trusted profile credentials survive project models[] replacement through onboarding readiness', () => {
  for (const credential of [
    { connection: { kind: 'chatgpt', profileId: 'fixture-account' } },
    { apiKey: 'fixture-inline-cloud-key' },
  ]) {
    const fixture = isolatedFixture();
    try {
      installBootstrapSentinel(fixture.home);
      const configDir = join(fixture.home, '.shadow');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({
          provider: 'openai',
          models: [{ label: 'Trusted cloud', provider: 'openai', model: 'cloud-model', ...credential }],
          profiles: { cloud: { model: 'Trusted cloud' } },
        }),
      );
      writeFileSync(
        join(fixture.workspace, 'shadow.config.json'),
        JSON.stringify({
          models: [{ label: 'Repo replacement', provider: 'openai', model: 'repo-model' }],
        }),
      );
      const result = run(fixture.home, fixture.workspace, [
        '--task', 'unused', '--profile', 'cloud', '--harness', 'bootstrap-sentinel',
      ]);
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      assert.equal(result.status, 1, output);
      assert.match(output, /required tools are unavailable in this host: bootstrap_probe_sentinel/);
      assert.doesNotMatch(output, /No model provider configured/);
    } finally {
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }
});

test('remembered trusted credentials survive project models[] replacement through onboarding readiness', () => {
  const fixture = isolatedFixture();
  try {
    installBootstrapSentinel(fixture.home);
    const configDir = join(fixture.home, '.shadow');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        provider: 'anthropic',
        model: 'stale-model',
        lastModel: 'Trusted remembered API',
        models: [{
          label: 'Trusted remembered API',
          provider: 'openai',
          model: 'remembered-model',
          credRef: 'model.remembered-fixture',
        }],
      }),
    );
    writeFileSync(
      join(configDir, 'credentials.json'),
      JSON.stringify({ 'model.remembered-fixture': { apiKey: 'fixture-remembered-key' } }),
    );
    writeFileSync(
      join(fixture.workspace, 'shadow.config.json'),
      JSON.stringify({
        models: [{ label: 'Repo replacement', provider: 'openai', model: 'repo-model' }],
      }),
    );

    const result = run(fixture.home, fixture.workspace, [
      '--task', 'unused', '--harness', 'bootstrap-sentinel',
    ]);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /required tools are unavailable in this host: bootstrap_probe_sentinel/);
    assert.doesNotMatch(output, /No model provider configured/);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});
