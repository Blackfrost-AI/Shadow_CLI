import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { request } from 'node:http';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import type { WebOnboardOptions } from '../src/onboard/webOnboard.js';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// Real persistence coverage must never open the user's keychain or credential directory.
const { home } = isolateHome('web-onboard');
process.env.PATH = '';
delete process.env.SHADOW_VAULT_PASSWORD;
const {
  page,
  runWebOnboard,
  persistOnboardSecret,
  persistWebOnboardTarget,
  webOnboardCredentialRef,
} = await import('../src/onboard/webOnboard.js');
const { GLOBAL_DIR, loadGlobalConfig } = await import('../src/state/globalStore.js');
const { unlockWithPassword } = await import('../src/auth/vault.js');
assertStoreIsolated(GLOBAL_DIR, home);
test.after(() => rmSync(home, { recursive: true, force: true }));

const draft = {
  provider: 'openai',
  label: 'custom',
  apiKey: 'fixture-endpoint-key',
  baseUrl: 'http://127.0.0.1:9000/v1',
  model: 'fixture-model',
  models: ['fixture-model'],
  password: 'fixture master password',
  selfHosted: true,
};

async function startWizard(options: WebOnboardOptions = {}) {
  const controller = new AbortController();
  let ready!: (url: string) => void;
  const opened = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const done = runWebOnboard(() => {}, {
    signal: controller.signal,
    hasVault: () => false,
    test: async () => ({ ok: true }),
    persistSecret: () => ({ merged: false, cached: false }),
    persistTarget: () => {},
    ...options,
    openBrowser: ready,
  });
  const url = new URL(
    await Promise.race([
      opened,
      done.then(() => {
        throw new Error('Wizard closed before opening');
      }),
    ]),
  );
  const token = url.searchParams.get('t');
  return {
    url,
    token,
    done,
    post: (path: string, data: Record<string, unknown> = {}) =>
      fetch(new URL(path, url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: url.origin },
        body: JSON.stringify({ token, ...data }),
      }),
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

test('onboarding page embeds the one-time token and the form fields', () => {
  const html = page('TESTTOKEN123');
  assert.match(html, /TESTTOKEN123/, 'token is embedded for the /save handshake');
  for (const id of [
    'id="provider"',
    'id="apiKey"',
    'id="baseUrl"',
    'id="selfHosted"',
    'id="discover"',
    'id="modelChoices"',
    'id="pw"',
    'id="pw2"',
  ]) {
    assert.ok(html.includes(id), `has ${id}`);
  }
  assert.match(html, /Is this endpoint self-hosted\?/);
  assert.match(html, /For ChatGPT or Claude subscriptions, run <code>shadow onboard<\/code>/);
  assert.match(html, /Subscription account/);
  assert.ok(
    html.includes("fetch('/activity'"),
    'form activity refreshes the authenticated idle deadline',
  );
  assert.match(html, /selfHosted:/, 'the explicit yes/no choice is included in the /save payload');
  assert.match(
    html,
    /value="qwen"[^>]*data-url="https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1"/,
  );
  assert.match(html, /value="qwen"[^>]*data-model="qwen3\.8-max"/);
  assert.match(html, /value="zai"[^>]*data-model="glm-5\.3"/);
  assert.match(html, /glm-5\.3-flash/);
  assert.match(
    html,
    /id="model"[^>]*required/,
    'the generated provider suggestion cannot fall back to a stale model',
  );
  assert.ok(
    html.includes("fetch('/probe'"),
    'model discovery stays behind the loopback onboarding server',
  );
  assert.match(
    html,
    /models:picked/,
    'the selected model allowlist is included in the save payload',
  );
});

test('onboarding page loads NO external resources (CSP/offline safe — a key cannot be exfiltrated)', () => {
  const html = page('t');
  // No off-origin resource loads: no external <script src>, <link href>, <img src=http>, no @import.
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'no external scripts');
  assert.doesNotMatch(html, /<link[^>]+href=/i, 'no external stylesheets');
  assert.doesNotMatch(html, /<img[^>]+src=["']?https?:/i, 'no remote images');
  assert.doesNotMatch(html, /@import/i, 'no CSS @import');
  // The only network call the script makes is the same-origin POST back to Shadow.
  assert.ok(html.includes("fetch('/save'"), 'posts to the local /save endpoint');
  assert.doesNotMatch(html, /fetch\(\s*["']https?:/i, 'never fetches an external URL');
});

test('the live form retains key and exact model after validation and transport errors', async () => {
  const html = page('test-token');
  const { document, window } = parseHTML(html);
  // Linkedom omits browser select state; provide just that DOM property behavior.
  for (const element of document.querySelectorAll('select')) {
    Object.defineProperty(element, 'selectedIndex', { value: 0, writable: true });
    Object.defineProperty(element, 'value', {
      value: element.options[0]?.value ?? '',
      writable: true,
    });
  }
  let networkError = false;
  const sent: Array<Record<string, unknown>> = [];
  runInNewContext(document.querySelector('script')!.textContent!, {
    document,
    fetch: async (path: string, init: RequestInit) => {
      if (path === '/save') {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (networkError) throw new Error('Fixture network timeout');
        return Response.json({ ok: false, error: 'Fixture incomplete tool response' });
      }
      return Response.json({ ok: true });
    },
  });
  const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  input('apiKey').value = draft.apiKey;
  input('pw').value = draft.password;
  input('pw2').value = draft.password;
  input('manualModel').value = draft.model;
  input('manualModel').dispatchEvent(new window.Event('input', { bubbles: true }));
  const submit = async () => {
    document.getElementById('f')!.dispatchEvent(new window.Event('submit', { cancelable: true }));
    await delay(0);
    await delay(0);
    for (const [id, expected] of [
      ['apiKey', draft.apiKey],
      ['pw', draft.password],
      ['manualModel', draft.model],
      ['model', draft.model],
    ]) {
      assert.equal(input(id).value, expected, `${id} draft survives`);
    }
    assert.equal((document.getElementById('go') as HTMLButtonElement).disabled, false);
  };
  await submit();
  assert.match(document.getElementById('msg')!.textContent ?? '', /incomplete tool response/);
  networkError = true;
  await submit();
  assert.match(document.getElementById('msg')!.textContent ?? '', /Could not reach Shadow/);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].apiKey, draft.apiKey);
  assert.equal(sent[0].model, draft.model);
  assert.equal(sent[1].apiKey, draft.apiKey);
  assert.equal(sent[1].model, draft.model);
});

test('save requires a completed tool check, redacts failures, and accepts the same draft on retry', async () => {
  const order: string[] = [];
  const checked: Array<Parameters<NonNullable<WebOnboardOptions['test']>>[0]> = [];
  let passed = false;
  const wizard = await startWizard({
    test: async (input) => {
      order.push('check');
      checked.push(input);
      return passed
        ? { ok: true }
        : { ok: false, error: `Incomplete response ${draft.apiKey} ${draft.password}` };
    },
    persistSecret: (input) => {
      order.push('secret');
      assert.equal(input.apiKey, draft.apiKey);
      assert.equal(input.credentialRef, webOnboardCredentialRef('openai', draft.baseUrl));
      return { merged: true, cached: false };
    },
    persistTarget: (input) => {
      order.push('target');
      assert.equal(input.model, draft.model);
      assert.equal(input.credentialRef, webOnboardCredentialRef('openai', draft.baseUrl));
      assert.deepEqual(input.selectedModels, draft.models);
    },
  });
  try {
    const rejected = await wizard.post('/save', draft);
    assert.equal(rejected.status, 400);
    const failure = (await rejected.json()) as { error: string };
    assert.match(failure.error, /Incomplete response/);
    assert.match(failure.error, /Your entries are kept/);
    assert.ok(!failure.error.includes(draft.apiKey) && !failure.error.includes(draft.password));
    assert.deepEqual(order, ['check'], 'no persistence on an incomplete tool response');
    passed = true;
    const saved = await wizard.post('/save', draft);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { ok: true, cached: false, merged: true });
    assert.deepEqual(order, ['check', 'check', 'secret', 'target']);
    assert.equal(checked[1].apiKey, draft.apiKey);
    assert.equal(checked[1].model, draft.model);
    assert.deepEqual(await wizard.done, {
      ok: true,
      provider: 'openai',
      cached: false,
      merged: true,
    });
  } finally {
    await wizard.close();
  }
});

test('a stalled check times out, aborts its operation, and keeps the wizard open for retry', async () => {
  let stalled = true;
  let checkSignal: AbortSignal | undefined;
  let writes = 0;
  const wizard = await startWizard({
    operationTimeoutMs: 25,
    test: async (_input, signal) => {
      checkSignal = signal;
      if (stalled) return new Promise(() => {});
      return { ok: true };
    },
    persistSecret: () => {
      writes++;
      return { merged: false, cached: false };
    },
  });
  try {
    const response = await wizard.post('/save', draft);
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /No response within/);
    assert.equal(checkSignal?.aborted, true);
    assert.equal(writes, 0);
    stalled = false;
    const retry = await wizard.post('/save', draft);
    assert.equal(retry.status, 200);
    await retry.json();
    assert.equal((await wizard.done).ok, true);
    assert.equal(writes, 1);
  } finally {
    await wizard.close();
  }
});

test('target persistence must finish before success; a failed write remains retryable', async () => {
  let fail = true;
  const order: string[] = [];
  const wizard = await startWizard({
    test: async () => {
      order.push('check');
      return { ok: true };
    },
    persistSecret: () => {
      order.push('secret');
      return { merged: true, cached: false };
    },
    persistTarget: async () => {
      order.push('target');
      if (fail) throw new Error('Fixture disk failure');
      await Promise.resolve();
      order.push('stored');
    },
  });
  try {
    const failed = await wizard.post('/save', draft);
    assert.equal(failed.status, 400);
    assert.match(((await failed.json()) as { error: string }).error, /Setup was not completed/);
    assert.deepEqual(order, ['check', 'secret', 'target']);
    fail = false;
    const saved = await wizard.post('/save', draft);
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { ok: boolean }).ok, true);
    assert.equal(order.at(-1), 'stored');
    assert.equal((await wizard.done).ok, true);
  } finally {
    await wizard.close();
  }
});

test('concurrent saves cannot validate or write twice', async () => {
  let entered!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let complete!: () => void;
  const barrier = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let checks = 0,
    writes = 0;
  const wizard = await startWizard({
    test: async () => {
      checks++;
      entered();
      await barrier;
      return { ok: true };
    },
    persistSecret: () => {
      writes++;
      return { merged: false, cached: false };
    },
  });
  try {
    const first = wizard.post('/save', draft);
    await checking;
    const second = await wizard.post('/save', draft);
    assert.equal(second.status, 409);
    await second.json();
    assert.equal(checks, 1);
    complete();
    const saved = await first;
    assert.equal(saved.status, 200);
    await saved.json();
    await wizard.done;
    assert.equal(writes, 1);
  } finally {
    complete();
    await wizard.close();
  }
});

test('only authenticated same-origin activity refreshes the idle deadline', async () => {
  const timers: Array<{ expire: () => void; cancelled: boolean }> = [];
  const wizard = await startWizard({
    scheduleIdle: (expire, timeout) => {
      assert.equal(timeout, 300_000);
      const record = { expire, cancelled: false };
      timers.push(record);
      return () => {
        record.cancelled = true;
      };
    },
  });
  try {
    assert.equal(timers.length, 1);
    const noToken = await fetch(new URL('/', wizard.url));
    assert.equal(noToken.status, 403);
    await noToken.json();
    const badToken = await wizard.post('/activity', { token: 'wrong-token' });
    assert.equal(badToken.status, 403);
    await badToken.json();
    const foreignOrigin = await fetch(new URL('/activity', wizard.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.invalid' },
      body: JSON.stringify({ token: wizard.token }),
    });
    assert.equal(foreignOrigin.status, 403);
    await foreignOrigin.json();
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(wizard.url, { headers: { Host: 'foreign.invalid' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(foreignHost, 403);
    assert.equal(timers.length, 1, 'untrusted requests did not extend setup');
    const pageResponse = await fetch(wizard.url);
    assert.equal(pageResponse.status, 200);
    await pageResponse.text();
    assert.equal(timers.length, 2);
    assert.equal(timers[0].cancelled, true);
    const activity = await wizard.post('/activity');
    assert.equal(activity.status, 200);
    await activity.json();
    assert.equal(timers.length, 3);
    assert.equal(timers[1].cancelled, true);
    timers[2].expire();
    assert.match((await wizard.done).reason ?? '', /timed out/);
    assert.equal(timers[2].cancelled, true);
  } finally {
    await wizard.close();
  }
});

test('probe failures are bounded, redacted and leave save available', async () => {
  const wizard = await startWizard({
    probe: async () => {
      throw new Error(`Fixture error ${draft.apiKey}`);
    },
  });
  try {
    const probe = await wizard.post('/probe', draft);
    assert.equal(probe.status, 400);
    const failure = (await probe.json()) as { error: string; source: string };
    assert.equal(failure.source, 'none');
    assert.ok(!failure.error.includes(draft.apiKey));
    const saved = await wizard.post('/save', draft);
    assert.equal(saved.status, 200);
    await saved.json();
    assert.equal((await wizard.done).ok, true);
  } finally {
    await wizard.close();
  }
});

test('cancelling the wizard aborts an in-flight check and performs no writes', async () => {
  let entered!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal: AbortSignal | undefined;
  let writes = 0;
  const wizard = await startWizard({
    test: async (_input, childSignal) => {
      signal = childSignal;
      entered();
      return new Promise(() => {});
    },
    persistSecret: () => {
      writes++;
      return { merged: false, cached: false };
    },
  });
  const response = wizard.post('/save', draft).catch(() => undefined);
  await checking;
  await wizard.close();
  await response;
  assert.equal(signal?.aborted, true);
  assert.equal(writes, 0);
  assert.deepEqual(await wizard.done, { ok: false, reason: 'cancelled' });
});

test('endpoint-specific vault slots and model entries preserve other provider connections', () => {
  const password = 'fixture vault password';
  persistOnboardSecret({ provider: 'openai', apiKey: 'legacy-openai-key', password });
  persistOnboardSecret({ provider: 'anthropic', apiKey: 'legacy-anthropic-key', password });
  const endpoints = ['http://127.0.0.1:9001/v1', 'http://127.0.0.1:9002/v1'];
  for (const [index, baseUrl] of endpoints.entries()) {
    const credentialRef = webOnboardCredentialRef('openai', baseUrl);
    persistOnboardSecret({
      provider: 'openai',
      apiKey: `endpoint-key-${index}`,
      password,
      baseUrl,
      credentialRef,
    });
    persistWebOnboardTarget({
      provider: 'openai',
      model: 'same-model',
      selectedModels: ['same-model'],
      baseUrl,
      credentialRef,
      customEndpoint: true,
      selfHosted: true,
    });
  }
  const bearerUrl = 'https://fixture.invalid/anthropic';
  const bearerRef = webOnboardCredentialRef('anthropic', bearerUrl);
  persistOnboardSecret({
    provider: 'anthropic',
    apiKey: 'endpoint-bearer',
    password,
    baseUrl: bearerUrl,
    credentialRef: bearerRef,
    bearer: true,
  });
  const localUrl = 'http://127.0.0.1:9003/v1';
  const localRef = webOnboardCredentialRef('openai', localUrl);
  persistOnboardSecret({
    provider: 'openai',
    apiKey: '',
    password,
    baseUrl: localUrl,
    credentialRef: localRef,
  });
  const data = unlockWithPassword(password).data as Record<
    string,
    {
      apiKey?: string;
      authToken?: string;
      baseUrl?: string;
      noAuth?: boolean;
    }
  >;
  assert.equal(data.openai.apiKey, 'legacy-openai-key');
  assert.equal(data.anthropic.apiKey, 'legacy-anthropic-key');
  assert.equal(data[bearerRef].authToken, 'endpoint-bearer');
  assert.equal(data[bearerRef].apiKey, undefined);
  assert.equal(data[localRef].noAuth, true);
  const models = loadGlobalConfig().models as Array<{
    model: string;
    label: string;
    baseUrl: string;
    credRef: string;
  }>;
  assert.equal(models.length, 2);
  assert.notEqual(models[0].label, models[1].label);
  for (const [index, baseUrl] of endpoints.entries()) {
    const ref = webOnboardCredentialRef('openai', baseUrl);
    assert.equal(data[ref].apiKey, `endpoint-key-${index}`);
    assert.equal(data[ref].baseUrl, baseUrl);
    assert.equal(models.find((entry) => entry.baseUrl === baseUrl)?.credRef, ref);
  }
});
