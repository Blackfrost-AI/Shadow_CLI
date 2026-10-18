import test from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome } from './helpers/isolateHome.js';
isolateHome('onboard-command');
const { parseOnboardArgs, runOnboarding } = await import('../src/onboard/command.js');

test('onboarding is browser-first, with explicit terminal and no-open options', () => {
  for (const args of [[], ['--web']])
    assert.deepEqual(parseOnboardArgs(args), { terminal: false, open: true, help: false });
  for (const flag of ['--terminal', '--cli']) assert.equal(parseOnboardArgs([flag]).terminal, true);
  assert.equal(parseOnboardArgs(['--no-open']).open, false);
  for (const args of [['--unknown'], ['--web', '--terminal'], ['--no-open', '--cli']])
    assert.throws(() => parseOnboardArgs(args));
});

test('default/first-run dispatch uses the browser and preserves the terminal exit result', async () => {
  const calls: string[] = [];
  const runners = {
    terminal: async () => {
      calls.push('terminal');
      return false;
    },
    web: async (_write: (s: string) => void, options?: { launchBrowser?: boolean }) => {
      calls.push(options?.launchBrowser === false ? 'url' : 'browser');
      return { ok: true };
    },
  };
  assert.equal(await runOnboarding([], () => {}, runners), true);
  assert.equal(await runOnboarding(['--no-open'], () => {}, runners), true);
  assert.equal(await runOnboarding(['--terminal'], () => {}, runners), false);
  assert.deepEqual(calls, ['browser', 'url', 'terminal']);
});

test('an explicit browser handoff continues setup without requiring another command', async () => {
  let calls = 0;
  assert.equal(
    await runOnboarding([], () => {}, {
      web: async () => ({ ok: false, terminal: true }),
      terminal: async () => {
        calls++;
        return true;
      },
    }),
    true,
  );
  assert.equal(calls, 1);
  assert.equal(
    await runOnboarding([], () => {}, {
      web: async () => ({ ok: false, reason: 'cancelled' }),
      terminal: async () => {
        calls++;
        return true;
      },
    }),
    false,
  );
  assert.equal(calls, 1, 'cancellation does not silently switch interfaces');
});

test('onboarding help does not open either UI', async () => {
  let output = '';
  const fail = async (): Promise<never> => {
    throw new Error('UI started');
  };
  assert.equal(
    await runOnboarding(
      ['--help'],
      (text) => {
        output += text;
      },
      { web: fail, terminal: fail },
    ),
    true,
  );
  assert.match(output, /--terminal/);
  assert.match(output, /--no-open/);
});
