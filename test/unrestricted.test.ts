import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnrestricted, DEV_UNRESTRICTED } from '../src/buildProfile.js';

// `resolveUnrestricted` decides whether a run drops the filesystem jail + OS sandbox.
// To test the --yolo / full-auto logic independent of the build's DEV_UNRESTRICTED value,
// pass guardrailsForced:true (mirrors SHADOW_GUARDRAILS=on), which neutralizes the dev clause.

test('full autonomy drops the jail+sandbox just like --yolo (guardrails-on build)', () => {
  assert.equal(resolveUnrestricted({ autonomy: 'full', guardrailsForced: true }), true, 'full auto → unrestricted');
  assert.equal(resolveUnrestricted({ yolo: true, guardrailsForced: true }), true, '--yolo → unrestricted');
});

test('non-full autonomy keeps the jail+sandbox on a guardrails-on build', () => {
  for (const autonomy of ['manual', 'auto-read', 'auto-edit', undefined]) {
    assert.equal(
      resolveUnrestricted({ autonomy, guardrailsForced: true }),
      false,
      `${autonomy ?? 'default'} stays restricted`,
    );
  }
});

test('the dev build (DEV_UNRESTRICTED=true) is unrestricted unless guardrails are forced on', () => {
  // This pins the dev-vs-sterile behavior against the actual build constant.
  assert.equal(resolveUnrestricted({ autonomy: 'auto-edit' }), DEV_UNRESTRICTED, 'dev: unrestricted; sterile: restricted');
  // SHADOW_GUARDRAILS=on forces guardrails even in the dev build.
  assert.equal(resolveUnrestricted({ autonomy: 'auto-edit', guardrailsForced: true }), false);
  // ...but --yolo / full-auto still win over forced guardrails.
  assert.equal(resolveUnrestricted({ yolo: true, guardrailsForced: true }), true);
  assert.equal(resolveUnrestricted({ autonomy: 'full', guardrailsForced: true }), true);
});
