import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { ChatGPTAccount } from '../src/auth/chatgpt.js';
import type { AccountOnboardOptions } from '../src/onboard/accounts.js';
import type { Choice, ChoiceOptions, OnboardUI, Screen } from '../src/onboard/ui.js';
import { BACK, OnboardCancelled } from '../src/onboard/ui.js';

const { home } = isolateHome('onboard-accounts');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, home);
const { runAccountOnboard, publicSignInUrl } = await import('../src/onboard/accounts.js');
test.beforeEach(() => {
  rmSync(store.configPath(), { force: true });
  store.saveGlobalConfig({
    provider: 'openai',
    model: 'old-api-model',
    models: [
      { label: 'Existing API', provider: 'openai', model: 'old-api-model', credRef: 'fixture-api' },
    ],
  });
});
test.after(() => rmSync(home, { recursive: true, force: true }));

type Answer = string | typeof BACK | Error;
class AccountUI implements OnboardUI {
  seen: Screen[] = [];
  choices: Array<{ title: string; items: Choice[]; options?: ChoiceOptions }> = [];
  updates: Partial<Screen>[] = [];
  externalCalls = 0;
  cancelBusy?: string;
  constructor(readonly script: Array<[string, Answer]>) {}
  async choose(
    screen: Screen,
    items: Choice[],
    options?: ChoiceOptions,
  ): Promise<string[] | typeof BACK> {
    this.seen.push(screen);
    this.choices.push({ title: screen.title, items, options });
    const next = this.script.shift();
    if (!next || next[0] !== screen.title)
      throw new OnboardCancelled(`Unexpected ${screen.title}; expected ${next?.[0]}`);
    if (next[1] instanceof Error) throw next[1];
    if (next[1] === BACK) return BACK;
    assert.ok(
      items.some((item) => item.id === next[1]),
      `offered choice ${next[1]}`,
    );
    return [next[1]];
  }
  async text(): Promise<string | typeof BACK> {
    throw new OnboardCancelled('Account flow must not ask for passwords or API keys');
  }
  async busy<T>(
    screen: Screen,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | typeof BACK> {
    this.seen.push(screen);
    const controller = new AbortController();
    if (this.cancelBusy === screen.title) {
      this.cancelBusy = undefined;
      const pending = work(controller.signal);
      controller.abort();
      await pending.catch((error) => {
        assert.equal(controller.signal.aborted, true, String(error));
      });
      return BACK;
    }
    return work(controller.signal);
  }
  async external<T>(work: () => Promise<T>): Promise<T> {
    this.externalCalls++;
    return work();
  }
  updateBusy(screen: Partial<Screen>): void {
    this.updates.push(screen);
  }
  close(): void {}
}

const account: ChatGPTAccount = {
  profileId: 'fixture-personal',
  label: 'Fixture account',
  clientId: 'fixture-client',
  signedIn: true,
  planUsageEnabled: true,
};
const catalog = [
  { slug: 'fixture-reasoner', displayName: 'Fixture Reasoner' },
  { slug: 'fixture-fast', displayName: 'Fixture Fast' },
];
const snapshot = () => JSON.stringify([store.loadGlobalConfig(), store.loadCredentials()]);
const unexpected = async (): Promise<never> => {
  throw new OnboardCancelled('Unexpected real account dependency');
};
function options(patch: AccountOnboardOptions = {}): AccountOnboardOptions {
  return {
    accounts: async () => [account],
    signIn: unexpected,
    models: async () => catalog,
    claudeStatus: unexpected,
    claudeLogin: unexpected,
    openBrowser: () => {
      throw new OnboardCancelled('Unexpected browser launch');
    },
    test: unexpected,
    ...patch,
  };
}
function finishScript(): Array<[string, Answer]> {
  return [
    ['Choose a subscription model', catalog[0]!.slug],
    ['Save subscription connection', 'save'],
  ];
}
function beginScript(): Array<[string, Answer]> {
  return [
    ['Choose a subscription', 'chatgpt'],
    ['ChatGPT accounts', account.profileId],
  ];
}

test('saved profile uses its discovered models and saves only after completed verification and explicit save', async () => {
  const before = snapshot();
  const ui = new AccountUI([...beginScript(), ...finishScript()]);
  let verified = 0;
  const result = await runAccountOnboard(
    ui,
    options({
      models: async (profile, signal) => {
        assert.equal(profile, account.profileId);
        assert.ok(signal);
        return catalog;
      },
      test: async (request, signal, timeout) => {
        assert.equal(snapshot(), before, 'no config writes during discovery or verification');
        assert.deepEqual(request, {
          provider: 'openai',
          model: catalog[0]!.slug,
          connection: { kind: 'chatgpt', profileId: account.profileId },
        });
        assert.ok(signal);
        assert.equal(timeout, 60_000);
        verified++;
        return { ok: true };
      },
    }),
  );
  assert.equal(verified, 1);
  assert.match(String(result), /verified/);
  assert.equal(ui.script.length, 0);
  assert.equal(ui.choices.find((item) => item.title === 'ChatGPT accounts')!.options?.search, true);
  assert.equal(
    ui.choices.find((item) => item.title === 'Choose a subscription model')!.options?.search,
    true,
  );
  assert.deepEqual(
    ui.choices.find((item) => item.title === 'Choose a subscription model')!.items,
    catalog.map((item) => ({ id: item.slug, label: item.displayName })),
  );
  const cfg = store.loadGlobalConfig();
  assert.deepEqual(cfg.connection, { kind: 'chatgpt', profileId: account.profileId });
  assert.equal(cfg.model, catalog[0]!.slug);
  assert.equal((cfg.models as unknown[]).length, 2, 'existing API preset is retained');
});

test('new account sign-in uses a cancellable browser handoff and omits retained identity hints from displayed URLs', async () => {
  const ui = new AccountUI([
    ['Choose a subscription', 'chatgpt'],
    ['ChatGPT accounts', '@new'],
    ...finishScript(),
  ]);
  const opened: string[] = [];
  let signIns = 0;
  const raw =
    'https://auth.openai.com/authorize?client_id=fixture-client&state=fixture-state&code_challenge=fixture-proof&id_token_hint=fixture-private-id&login_hint=private%40example.test';
  await runAccountOnboard(
    ui,
    options({
      accounts: async () => [],
      signIn: async (request) => {
        signIns++;
        assert.equal(request.profileId, undefined);
        assert.ok(request.signal);
        await request.onUrl(raw);
        return account;
      },
      openBrowser: (url) => opened.push(url),
      test: async () => ({ ok: true }),
    }),
  );
  assert.equal(signIns, 1);
  assert.equal(opened.length, 1);
  const safe = new URL(opened[0]!);
  assert.equal(safe.searchParams.has('id_token_hint'), false);
  assert.equal(safe.searchParams.has('login_hint'), false);
  assert.equal(safe.searchParams.get('state'), 'fixture-state');
  assert.equal(safe.searchParams.get('code_challenge'), 'fixture-proof');
  assert.doesNotMatch(JSON.stringify(ui.updates), /fixture-private-id|private%40|private@example/);
  assert.equal(publicSignInUrl(raw), opened[0]);
});

test('reauthorizing a saved account that declined plan usage explicitly requests plan consent', async () => {
  const ui = new AccountUI([...beginScript(), ...finishScript()]);
  await runAccountOnboard(
    ui,
    options({
      accounts: async () => [{ ...account, planUsageEnabled: false }],
      signIn: async (request) => {
        assert.equal(request.profileId, account.profileId);
        assert.equal(
          request.enablePlanUsage,
          true,
          'explicit plan opt-in must force consent after a prior decline',
        );
        return account;
      },
      test: async () => ({ ok: true }),
    }),
  );
  assert.equal(ui.script.length, 0);
});

test('pending verification retries through model discovery without opening browser sign-in', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ...beginScript(),
    ['Connection needs attention', 'retry'],
    ['ChatGPT accounts', account.profileId],
    ...finishScript(),
  ]);
  let attempts = 0;
  await runAccountOnboard(
    ui,
    options({
      accounts: async () => [{ ...account, planUsageEnabled: false, verificationPending: true }],
      models: async (profileId) => {
        assert.equal(profileId, account.profileId);
        assert.equal(snapshot(), before);
        if (++attempts === 1)
          throw new Error('OpenAI identity verification temporarily unavailable');
        return catalog;
      },
      test: async () => ({ ok: true }),
    }),
  );
  assert.equal(attempts, 2);
  assert.equal(
    ui.seen.some((screen) => screen.title === 'Continue with ChatGPT'),
    false,
  );
  assert.match(
    ui.choices.find((screen) => screen.title === 'ChatGPT accounts')!.items[0]!.detail!,
    /Verification pending; retry/,
  );
  assert.equal(ui.script.length, 0);
});

for (const failure of ['Session expired', 'Refresh token revoked', 'Stored identity is invalid']) {
  test(`${failure}: explicit reconnect reuses the selected profile and verifies before save`, async () => {
    const before = snapshot();
    const ui = new AccountUI([
      ...beginScript(),
      ['Connection needs attention', 'reconnect'],
      ...finishScript(),
    ]);
    let discovery = 0,
      signIns = 0;
    await runAccountOnboard(
      ui,
      options({
        models: async () => {
          assert.equal(snapshot(), before);
          if (++discovery === 1) throw new Error(failure);
          return catalog;
        },
        signIn: async (request) => {
          assert.equal(snapshot(), before);
          assert.equal(request.profileId, account.profileId);
          assert.equal(request.enablePlanUsage, true);
          assert.ok(request.signal);
          signIns++;
          return account;
        },
        test: async () => {
          assert.equal(snapshot(), before);
          return { ok: true };
        },
      }),
    );
    assert.equal(signIns, 1);
    assert.equal(discovery, 2);
    const recovery = ui.choices.find((screen) => screen.title === 'Connection needs attention')!;
    assert.equal(
      recovery.items.find((item) => item.id === 'reconnect')?.label,
      'Reconnect selected account',
    );
    assert.equal(ui.script.length, 0);
  });
}

test('verification failure can reconnect the same account and must verify the model again', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ...beginScript(),
    ['Choose a subscription model', catalog[0]!.slug],
    ['Connection needs attention', 'reconnect'],
    ...finishScript(),
  ]);
  let signIns = 0,
    checks = 0;
  await runAccountOnboard(
    ui,
    options({
      signIn: async ({ profileId }) => {
        assert.equal(profileId, account.profileId);
        assert.equal(snapshot(), before);
        signIns++;
        return account;
      },
      test: async () => {
        assert.equal(snapshot(), before);
        return ++checks === 1 ? { ok: false, error: 'Authorization expired' } : { ok: true };
      },
    }),
  );
  assert.equal(signIns, 1);
  assert.equal(checks, 2);
  assert.equal(ui.script.length, 0);
});

test('cancelling reconnect returns to account choices with the active setup unchanged', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ...beginScript(),
    ['Connection needs attention', 'reconnect'],
    ['ChatGPT accounts', BACK],
    ['Choose a subscription', BACK],
  ]);
  ui.cancelBusy = 'Continue with ChatGPT';
  let cancelled = false;
  const result = await runAccountOnboard(
    ui,
    options({
      models: async () => {
        throw new Error('Refresh token revoked');
      },
      signIn: async ({ profileId, signal }) =>
        new Promise((_, reject) => {
          assert.equal(profileId, account.profileId);
          assert.ok(signal);
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    }),
  );
  assert.equal(result, BACK);
  assert.equal(cancelled, true);
  assert.equal(snapshot(), before);
  assert.equal(ui.script.length, 0);
});

test('Escape aborts browser sign-in, returns to account selection and preserves active setup', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ['Choose a subscription', 'chatgpt'],
    ['ChatGPT accounts', '@new'],
    ['ChatGPT accounts', BACK],
    ['Choose a subscription', BACK],
  ]);
  ui.cancelBusy = 'Continue with ChatGPT';
  let cancelled = false;
  const result = await runAccountOnboard(
    ui,
    options({
      accounts: async () => [],
      signIn: async ({ signal }) =>
        new Promise((_, reject) => {
          assert.ok(signal);
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    }),
  );
  assert.equal(result, BACK);
  assert.equal(cancelled, true);
  assert.equal(snapshot(), before);
  assert.equal(ui.script.length, 0);
});

test('model discovery failure stays recoverable and retry never saves an empty account catalog', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ...beginScript(),
    ['Connection needs attention', 'retry'],
    ['ChatGPT accounts', account.profileId],
    ...finishScript(),
  ]);
  let attempts = 0;
  await runAccountOnboard(
    ui,
    options({
      models: async () => {
        assert.equal(snapshot(), before);
        return ++attempts === 1 ? [] : catalog;
      },
      test: async () => ({ ok: true }),
    }),
  );
  assert.equal(attempts, 2);
  assert.match(
    ui.seen.find((screen) => screen.title === 'Connection needs attention')!.error!,
    /no available models/,
  );
  assert.equal(ui.script.length, 0);
});

test('failed subscription verification must retry successfully before save is offered', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ...beginScript(),
    ['Choose a subscription model', catalog[0]!.slug],
    ['Connection needs attention', 'retry'],
    ['Save subscription connection', 'save'],
  ]);
  let attempts = 0;
  await runAccountOnboard(
    ui,
    options({
      test: async () => {
        assert.equal(snapshot(), before);
        assert.equal(
          ui.seen.some((screen) => screen.title === 'Save subscription connection'),
          false,
        );
        return ++attempts === 1
          ? { ok: false, error: 'Tool response was incomplete' }
          : { ok: true };
      },
    }),
  );
  assert.equal(attempts, 2);
  const recovery = ui.choices.find((screen) => screen.title === 'Connection needs attention')!;
  assert.equal(
    recovery.items.some((item) => item.id === 'save'),
    false,
    'subscription auth cannot be saved unverified',
  );
  assert.equal(ui.script.length, 0);
});

test('abandoning failed verification leaves existing config and API presets unchanged', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ...beginScript(),
    ['Choose a subscription model', catalog[0]!.slug],
    ['Connection needs attention', 'back'],
    ['Choose a subscription', BACK],
  ]);
  assert.equal(
    await runAccountOnboard(
      ui,
      options({ test: async () => ({ ok: false, error: 'Plan limit reached' }) }),
    ),
    BACK,
  );
  assert.equal(snapshot(), before);
  assert.equal(ui.script.length, 0);
});

test('going back from save to another model repeats verification for the newly chosen model', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ...beginScript(),
    ['Choose a subscription model', catalog[0]!.slug],
    ['Save subscription connection', BACK],
    ['Choose a subscription model', catalog[1]!.slug],
    ['Save subscription connection', 'save'],
  ]);
  const models: string[] = [];
  await runAccountOnboard(
    ui,
    options({
      test: async (request) => {
        assert.equal(snapshot(), before);
        models.push(request.model);
        return { ok: true };
      },
    }),
  );
  assert.deepEqual(
    models,
    catalog.map((item) => item.slug),
  );
  assert.equal(store.loadGlobalConfig().model, catalog[1]!.slug);
  assert.equal(ui.script.length, 0);
});

test('Escape during verification aborts work and returns to model selection without saving', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ...beginScript(),
    ['Choose a subscription model', catalog[0]!.slug],
    ['Choose a subscription model', BACK],
    ['ChatGPT accounts', BACK],
    ['Choose a subscription', BACK],
  ]);
  ui.cancelBusy = 'Verify subscription connection';
  let cancelled = false;
  assert.equal(
    await runAccountOnboard(
      ui,
      options({
        test: async (_request, signal) =>
          new Promise((_, reject) => {
            assert.ok(signal);
            signal.addEventListener(
              'abort',
              () => {
                cancelled = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      }),
    ),
    BACK,
  );
  assert.equal(cancelled, true);
  assert.equal(snapshot(), before);
});

test('whole-wizard cancellation propagates without entering a retry loop or saving configuration', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ...beginScript(),
    ['Choose a subscription model', new OnboardCancelled('fixture Ctrl+C')],
  ]);
  await assert.rejects(runAccountOnboard(ui, options()), OnboardCancelled);
  assert.equal(snapshot(), before);
  assert.equal(
    ui.seen.some((screen) => screen.title === 'Connection needs attention'),
    false,
  );
});

test('Claude sign-in hands the terminal to official CLI, rechecks subscription auth, then verifies before saving', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ['Choose a subscription', 'claude'],
    ['Sign in to Claude Code', 'login'],
    ['Choose a subscription model', 'sonnet'],
    ['Save subscription connection', 'save'],
  ]);
  let statuses = 0;
  let logins = 0;
  await runAccountOnboard(
    ui,
    options({
      claudeStatus: async () => ({
        installed: true,
        supported: true,
        loggedIn: ++statuses > 1,
        authMethod: statuses > 1 ? 'claude.ai' : 'none',
      }),
      claudeLogin: async () => {
        logins++;
        assert.equal(ui.externalCalls, 1, 'official login owns the external terminal');
        assert.equal(snapshot(), before);
      },
      test: async (request) => {
        assert.equal(statuses, 2);
        assert.equal(snapshot(), before);
        assert.deepEqual(request, {
          provider: 'anthropic',
          model: 'sonnet',
          connection: { kind: 'claude-code' },
        });
        return { ok: true };
      },
    }),
  );
  assert.equal(logins, 1);
  assert.deepEqual(store.loadGlobalConfig().connection, { kind: 'claude-code' });
  assert.equal(ui.script.length, 0);
});

test('Claude API login is never accepted as subscription access after the external handoff', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ['Choose a subscription', 'claude'],
    ['Sign in to Claude Code', 'login'],
    ['Connection needs attention', 'back'],
    ['Choose a subscription', BACK],
  ]);
  assert.equal(
    await runAccountOnboard(
      ui,
      options({
        claudeStatus: async () => ({
          installed: true,
          supported: true,
          loggedIn: true,
          authMethod: 'other',
        }),
        claudeLogin: async () => {},
      }),
    ),
    BACK,
  );
  assert.match(
    ui.seen.find((screen) => screen.title === 'Connection needs attention')!.error!,
    /subscription sign-in is not active/,
  );
  assert.equal(snapshot(), before);
});

test('unsupported Claude installation remains recoverable and does not launch sign-in or save', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ['Choose a subscription', 'claude'],
    ['Connection needs attention', 'back'],
    ['Choose a subscription', BACK],
  ]);
  assert.equal(
    await runAccountOnboard(
      ui,
      options({
        claudeStatus: async () => ({
          installed: true,
          supported: false,
          loggedIn: false,
          message: 'Update official Claude Code',
        }),
      }),
    ),
    BACK,
  );
  assert.equal(ui.externalCalls, 0);
  assert.equal(snapshot(), before);
  assert.match(
    ui.seen.find((screen) => screen.title === 'Connection needs attention')!.error!,
    /Update official Claude Code/,
  );
});

test('declining plan usage never reaches discovery, verification or persistence', async () => {
  const before = snapshot();
  const ui = new AccountUI([
    ['Choose a subscription', 'chatgpt'],
    ['ChatGPT accounts', '@new'],
    ['Connection needs attention', 'back'],
    ['Choose a subscription', BACK],
  ]);
  assert.equal(
    await runAccountOnboard(
      ui,
      options({
        accounts: async () => [],
        signIn: async () => ({ ...account, planUsageEnabled: false }),
        models: unexpected,
      }),
    ),
    BACK,
  );
  assert.equal(snapshot(), before);
  assert.match(
    ui.seen.find((screen) => screen.title === 'Connection needs attention')!.error!,
    /plan usage was not enabled/,
  );
});
