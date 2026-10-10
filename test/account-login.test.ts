import test from 'node:test';
import assert from 'node:assert/strict';
import { runAccountLogin } from '../src/auth/login.js';
import type { ChatGPTAccount } from '../src/auth/chatgpt.js';

const account: ChatGPTAccount = {
  profileId: 'chatgpt-test',
  label: 'Test account',
  clientId: 'test-client',
  signedIn: true,
  planUsageEnabled: true,
};

test('local status distinguishes pending identity verification from declined plan usage', async () => {
  let output = '';
  assert.equal(
    await runAccountLogin(['status'], {
      write: (text) => {
        output += text;
      },
      accounts: async () => [
        {
          ...account,
          label: 'Pending account',
          verificationPending: true,
          planUsageEnabled: false,
        },
        {
          ...account,
          profileId: 'chatgpt-declined',
          label: 'Declined account',
          planUsageEnabled: false,
        },
      ],
      signIn: async () => {
        assert.fail('status must not start browser sign-in');
      },
      claudeStatus: async () => ({ installed: false, supported: false, loggedIn: false }),
    }),
    0,
  );
  assert.match(output, /Pending account — verification pending; retry in shadow onboard/);
  assert.match(output, /Declined account — plan usage not enabled/);
  assert.doesNotMatch(output, /Pending account — plan usage not enabled/);
});

test('explicit reconnect passes the chosen stored profile to native sign-in', async () => {
  let output = '';
  assert.equal(
    await runAccountLogin(['chatgpt', account.profileId], {
      write: (text) => {
        output += text;
      },
      signIn: async (request) => {
        assert.equal(request.profileId, account.profileId);
        assert.equal(request.enablePlanUsage, true);
        assert.ok(request.signal);
        return account;
      },
    }),
    0,
  );
  assert.match(output, /Connected Test account/);
  assert.match(output, /choose and verify a model/);
});

test('native login removes identity-token hints from browser and terminal, without selecting a model', async () => {
  let output = '';
  let opened = '';
  const result = await runAccountLogin(['codex'], {
    write: (text) => {
      output += text;
    },
    openBrowser: (url) => {
      opened = url;
    },
    signIn: async (options) => {
      assert.equal(options.enablePlanUsage, true);
      await options.onUrl(
        'https://auth.openai.com/api/accounts/authorize?state=state&code_challenge=challenge&id_token_hint=secret-token&login_hint=private-email',
      );
      return account;
    },
  });
  assert.equal(result, 0);
  assert.match(output, /shadow onboard/);
  assert.match(opened, /code_challenge=challenge/);
  assert.doesNotMatch(opened + output, /secret-token|private-email|id_token_hint|login_hint/);
});

test('no-open allows manual native login and reports missing plan consent honestly', async () => {
  let output = '';
  assert.equal(
    await runAccountLogin(['chatgpt', 'saved-account', '--no-open'], {
      write: (text) => {
        output += text;
      },
      openBrowser: () => {
        assert.fail('must not open a browser');
      },
      signIn: async (options) => {
        assert.equal(options.profileId, 'saved-account');
        await options.onUrl('https://auth.openai.com/api/accounts/authorize?state=state');
        return { ...account, planUsageEnabled: false };
      },
    }),
    1,
  );
  assert.match(output, /Plan usage was not enabled/);
});

test('logout distinguishes local removal from unconfirmed server revocation', async () => {
  let output = '';
  assert.equal(
    await runAccountLogin(['logout', 'saved-account'], {
      write: (text) => {
        output += text;
      },
      logout: async (id) => ({ profileId: id, localCleared: true, revocation: 'unconfirmed' }),
    }),
    0,
  );
  assert.match(output, /removed locally/);
  assert.match(output, /revocation could not be confirmed/);
  assert.doesNotMatch(output, /confirmed token revocation/);
});

test('Claude login requires subscription status after official login completes', async () => {
  let output = '';
  let logins = 0;
  assert.equal(
    await runAccountLogin(['claude'], {
      write: (text) => {
        output += text;
      },
      claudeLogin: async () => {
        logins++;
      },
      claudeStatus: async () => ({
        installed: true,
        supported: true,
        loggedIn: true,
        authMethod: 'other',
      }),
    }),
    1,
  );
  assert.equal(logins, 1);
  assert.match(output, /subscription sign-in is not active/);
});

test('invalid arguments cannot start authentication', async () => {
  for (const args of [
    ['chatgpt', '--unknown'],
    ['claude', 'unexpected'],
    ['logout'],
    ['status', 'extra'],
  ]) {
    assert.equal(
      await runAccountLogin(args, {
        write: () => {},
        signIn: async () => {
          assert.fail('must not authenticate');
        },
        claudeLogin: async () => {
          assert.fail('must not authenticate');
        },
      }),
      1,
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(`Claude login cancels on ${signal} and waits for cleanup before returning`, async () => {
    const before = process.listeners(signal);
    let cleanupFinished = false;
    let output = '';
    assert.equal(
      await runAccountLogin(['claude'], {
        write: (text) => {
          output += text;
        },
        claudeLogin: async (options) => {
          assert.ok(options?.signal);
          const cleanup = new Promise<never>((_resolve, reject) => {
            options.signal!.addEventListener(
              'abort',
              () => {
                setTimeout(() => {
                  cleanupFinished = true;
                  reject(new Error('fixture stopped'));
                }, 10);
              },
              { once: true },
            );
          });
          process.emit(signal);
          return cleanup;
        },
        claudeStatus: async () => {
          assert.fail('cancelled login must not request account status');
        },
      }),
      130,
    );
    assert.equal(cleanupFinished, true);
    assert.match(output, /cancelled/);
    assert.deepEqual(process.listeners(signal), before);
  });
}
