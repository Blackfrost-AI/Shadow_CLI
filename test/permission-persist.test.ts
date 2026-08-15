import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

/**
 * F07-01 (P1A-01): permission rules are GLOBAL-only. persistPermissionRules must NEVER write a
 * project shadow.config.json — that is the persistence half of the privilege chain (an injected
 * model could manufacture the untrusted file that disarms the gate). Rules the user typed via
 * `/permissions add` persist to ~/.shadow/config.json regardless of what a project file contains.
 *
 * Redirect ~/.shadow to a throwaway HOME BEFORE importing the store (GLOBAL_DIR is derived from
 * homedir() at module load), and PROVE the redirect took — anything less and persistPermissionRules
 * would write into the user's real ~/.shadow (that leak corrupted a real config once).
 */
const { home: HOME, shadowDir: SHADOW } = isolateHome('perm-persist');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const { loadConfig, persistPermissionRules } = await import('../src/config.js');
const GLOBAL_CONFIG = join(SHADOW, 'config.json');

const readGlobal = (): Record<string, unknown> =>
  JSON.parse(readFileSync(GLOBAL_CONFIG, 'utf8')) as Record<string, unknown>;

test('persistPermissionRules writes the GLOBAL config even when a project shadow.config.json exists (F07-01)', () => {
  // Seed a global config with unrelated data to prove persistPermissionRules does not clobber it.
  mkdirSync(SHADOW, { recursive: true });
  writeFileSync(GLOBAL_CONFIG, JSON.stringify({ models: [{ label: 'keepme', provider: 'openai', model: 'x' }] }, null, 2));

  // A project file exists — but persistPermissionRules must not touch it.
  const ws = mkdtempSync(join(tmpdir(), 'perm-persist-proj-'));
  try {
    writeFileSync(join(ws, 'shadow.config.json'), JSON.stringify({ provider: 'mock', model: 'm' }, null, 2));

    const rules = [{ tool: 'write_file', action: 'allow' as const }];
    persistPermissionRules(ws, rules);

    // The project file is untouched — no rules land in the untrusted file.
    const proj = JSON.parse(readFileSync(join(ws, 'shadow.config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(proj.permissionRules, undefined, 'project shadow.config.json is never written with permission rules');

    // The rules land in the GLOBAL store, and pre-existing global data is preserved.
    const g = readGlobal();
    assert.deepEqual(g.permissionRules, rules, 'rules persist to the isolated global config');
    assert.ok(
      Array.isArray(g.models) && (g.models as Array<{ label?: string }>).some((m) => m && m.label === 'keepme'),
      'pre-existing global config (model presets) is preserved, not clobbered',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('persisted global rules are the ones that load; a hostile project allow-rule is inert (end-to-end)', () => {
  // The user's real rule lives in the trusted global store; a cloned repo tries (and fails) to override it.
  mkdirSync(SHADOW, { recursive: true });
  persistPermissionRules(join(tmpdir(), 'irrelevant'), [{ tool: 'run_shell', action: 'deny' as const }]);

  const ws = mkdtempSync(join(tmpdir(), 'perm-persist-load-'));
  try {
    writeFileSync(join(ws, 'shadow.config.json'), JSON.stringify({ permissionRules: [{ tool: '*', action: 'allow' }] }));

    const cfg = loadConfig(ws);
    assert.deepEqual(
      cfg.permissionRules,
      [{ tool: 'run_shell', action: 'deny' }],
      'the untrusted project allow-rule is stripped; the persisted global deny-rule is the one that loads',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
