import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome } from './helpers/isolateHome.js';

/**
 * P2-12 trust posture — `sandboxFailurePolicy` is a GLOBAL-ONLY key. A project-local
 * shadow.config.json is untrusted (you may run shadow inside a cloned repo), and a repo
 * that could downgrade the failure policy to 'warn' would silently strip the unconfined
 * escalation for everyone who clones it.
 *
 * HOME is isolated BEFORE config.js loads: ESM hoists static imports above isolateHome(),
 * and globalStore captures GLOBAL_DIR from os.homedir() at module load — so the import is
 * dynamic, exactly like diagnostics.test.ts.
 */
const { shadowDir } = isolateHome('sbxpol');
const { loadConfig } = await import('../src/config.js');

function ws(): string {
  return mkdtempSync(join(tmpdir(), 'sbxpol-'));
}
function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test('a project shadow.config.json CANNOT set sandboxFailurePolicy (global-only key)', () => {
  const root = ws();
  try {
    writeFileSync(
      join(root, 'shadow.config.json'),
      JSON.stringify({ sandboxFailurePolicy: 'warn' }),
    );
    const cfg = loadConfig(root);
    assert.equal(
      cfg.sandboxFailurePolicy,
      'auto',
      'the project value is stripped and the schema default stands — a repo cannot lower the failure posture',
    );
  } finally {
    cleanup(root);
  }
});

test('the GLOBAL config honors sandboxFailurePolicy (and it survives loadConfig)', () => {
  const root = ws();
  try {
    writeFileSync(
      join(shadowDir, 'config.json'),
      JSON.stringify({ sandboxFailurePolicy: 'fail-closed' }),
    );
    const cfg = loadConfig(root);
    assert.equal(cfg.sandboxFailurePolicy, 'fail-closed');
  } finally {
    cleanup(root);
  }
});

test('global fail-closed wins over a project warn attempt (defense in depth)', () => {
  const root = ws();
  try {
    writeFileSync(join(shadowDir, 'config.json'), JSON.stringify({ sandboxFailurePolicy: 'fail-closed' }));
    writeFileSync(join(root, 'shadow.config.json'), JSON.stringify({ sandboxFailurePolicy: 'warn' }));
    const cfg = loadConfig(root);
    assert.equal(cfg.sandboxFailurePolicy, 'fail-closed', 'the trusted global value is untouchable from the project file');
  } finally {
    cleanup(root);
  }
});
