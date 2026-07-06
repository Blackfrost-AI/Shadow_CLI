import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, formatDoctorReport } from '../src/doctor.js';

test('runDoctor returns node check and report shape', () => {
  const report = runDoctor(process.cwd());
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.checks.some((c) => c.id === 'node'));
  assert.ok(report.checks.some((c) => c.id === 'guardrails'));
  assert.equal(typeof report.ok, 'boolean');
});

test('formatDoctorReport includes version and summary line', () => {
  const report = runDoctor(process.cwd());
  const text = formatDoctorReport(report, '0.6.0-dev.7');
  assert.match(text, /shadow doctor 0\.6\.0-dev\.7/);
  assert.match(text, /critical checks/);
});