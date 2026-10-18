import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
const { home } = isolateHome('onboard-headless');
process.env.PATH = ''; // Never reach a real keychain.
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, home);
const { runOnboard } = await import('../src/onboard/onboard.js');
const { TerminalOnboardUI } = await import('../src/onboard/ui.js');
const { probeModelEndpoint } = await import('../src/onboard/probe.js');
const { HeadlessTerminal } = await import('./helpers/snowfallTerminal.js');
test.after(() => rmSync(home, { recursive: true, force: true }));

test('real terminal UI continues from the reported model catalog through retry and save headlessly', async () => {
  const terminal = new HeadlessTerminal(80, 25);
  const ui = new TerminalOnboardUI(terminal);
  const seen: string[] = [];
  const choose = ui.choose.bind(ui);
  ui.choose = (screen, choices, options) => {
    seen.push(screen.title);
    const pending = choose(screen, choices, options);
    const answer: Record<string, string> = {
      'How do you want to run Shadow?': 'server',
      'Choose a model server': 'custom',
      'Choose models': 'glm-5.3-derisked',
      'Connection needs attention': 'retry',
      'Review and save': 'save',
      'Test agent capabilities?': 'skip',
    };
    const index = choices.findIndex((choice) => choice.id === answer[screen.title]);
    setImmediate(() => {
      if (index < 0) {
        terminal.input('\x03');
        return;
      }
      assert.equal(terminal.stopped, false, `${screen.title} retains its terminal owner`);
      terminal.input(String(index + 1));
      terminal.input('\r');
    });
    return pending;
  };
  const text = ui.text.bind(ui);
  ui.text = (screen, options) => {
    const pending = text(screen, options);
    setImmediate(() => {
      ui.view.input.setValue(screen.title === 'Endpoint URL' ? 'http://127.0.0.1:8800/v1' : '');
      terminal.input('\r');
    });
    return pending;
  };
  let checks = 0;
  try {
    assert.equal(
      await runOnboard({
        ui,
        probe: (options) =>
          probeModelEndpoint({
            ...options,
            fetcher: async () => Response.json({ data: [{ id: 'glm-5.3-derisked' }] }),
          }),
        test: async (options) => {
          assert.equal(options.model, 'glm-5.3-derisked');
          return ++checks === 1 ? { ok: false, error: 'Fixture retry' } : { ok: true };
        },
      }),
      true,
    );
    assert.equal(checks, 2);
    assert.ok(seen.includes('Choose models'));
    assert.ok(seen.includes('Review and save'));
    assert.equal(store.loadGlobalConfig().model, 'glm-5.3-derisked');
    assert.equal(terminal.stopped, true);
  } finally {
    ui.close();
    terminal.screen.dispose();
  }
});
