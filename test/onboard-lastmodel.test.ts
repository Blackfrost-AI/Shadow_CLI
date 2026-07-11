import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate ~/.shadow before importing the store (GLOBAL_DIR is derived from homedir() at load).
const HOME = mkdtempSync(join(tmpdir(), 'shadow-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
mkdirSync(join(HOME, '.shadow'), { recursive: true });

const store = await import('../src/state/globalStore.js');

test('onboarding a new provider clears lastModel so the fresh pick becomes active (regression)', () => {
  // A user with presets and a last `/model` pick at a (now-stale) preset.
  store.saveGlobalConfig({
    provider: 'openai',
    model: 'glm-5.2',
    baseUrl: 'http://10.0.0.9:8010/v1',
    models: [
      { label: 'LAN Hy3', provider: 'openai', model: 'hy3', baseUrl: 'http://10.0.0.10:8010/v1' },
      { label: 'GLM (z.ai)', provider: 'openai', model: 'glm-4.6', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
    ],
    lastModel: 'LAN Hy3',
  });
  assert.equal(store.loadGlobalConfig().lastModel, 'LAN Hy3', 'precondition: lastModel is set');

  // Onboarding writes the new provider AND clears lastModel (what web/terminal onboard now do).
  store.saveGlobalConfig({
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    lastModel: undefined,
  });

  const after = store.loadGlobalConfig();
  assert.equal(after.lastModel, undefined, 'lastModel is cleared — no stale preset overrides the onboard');
  assert.equal(after.provider, 'anthropic', 'the freshly-onboarded provider is now top-level');
  assert.equal(after.model, 'claude-opus-4-8');
  assert.ok(Array.isArray(after.models) && (after.models as unknown[]).length === 2, 'existing presets are preserved');
});

test.after(() => rmSync(HOME, { recursive: true, force: true }));
