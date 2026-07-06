import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEV_UNRESTRICTED } from '../src/buildProfile.js';
import { runDoctor } from '../src/doctor.js';

test('buildProfile defaults DEV_UNRESTRICTED to safe (false) when SHADOW_DEV_UNRESTRICTED is unset', () => {
  // Guardrails (filesystem jail + OS sandbox) ship ON by default; dropping them is opt-in.
  // The test process does not set SHADOW_DEV_UNRESTRICTED, so the default must be false.
  assert.equal(DEV_UNRESTRICTED, false);
});

test('doctor guardrails check mentions buildProfile DEV_UNRESTRICTED', () => {
  const prev = process.env.SHADOW_GUARDRAILS;
  delete process.env.SHADOW_GUARDRAILS;
  try {
    const report = runDoctor(process.cwd());
    const guard = report.checks.find((c) => c.id === 'guardrails');
    assert.ok(guard);
    assert.match(guard.detail, /buildProfile DEV_UNRESTRICTED/);
  } finally {
    if (prev === undefined) delete process.env.SHADOW_GUARDRAILS;
    else process.env.SHADOW_GUARDRAILS = prev;
  }
});