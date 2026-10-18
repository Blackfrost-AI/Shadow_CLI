import assert from 'node:assert/strict';
import test from 'node:test';
import { clampToScale, planNotice, planUltra, ULTRA_LADDER } from '../src/agent/ultraMode.js';

/**
 * Ultra mode's contract is "the strongest depth this endpoint can certifiably take, and an honest
 * label". Both halves are asserted here, because the failure that matters is not a wrong number —
 * it is a confident label over a setting that was never delivered.
 */

// ── clampToScale ─────────────────────────────────────────────────────────────────────────────

test('clampToScale: passes a declared depth straight through', () => {
  const scale = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  for (const e of ULTRA_LADDER) assert.equal(clampToScale(e, scale), e);
});

test('clampToScale: never exceeds what was requested', () => {
  // A 5-tier endpoint asked for 'medium' must get 'medium', not the top of its range. Ultra is a
  // ceiling, not a floor: silently out-spending the user's setting is a bug.
  const scale = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  assert.equal(clampToScale('medium', scale), 'medium');
  assert.equal(clampToScale('low', scale), 'low');
});

test('clampToScale: falls to the deepest declared value when the request is not on the scale', () => {
  // A three-tier scale, as qwen-selfhosted declares in the catalog (catalog.ts). This is NOT the
  // Claude case: the Anthropic preset declares no capabilities block at all, so Claude takes the
  // UNDECLARED (unverified passthrough) path asserted in the planUltra tests below.
  const scale = ['low', 'medium', 'xhigh'] as const;
  assert.equal(clampToScale('max', scale), 'xhigh', 'max is not declared, so deepest declared wins');
  assert.equal(clampToScale('high', scale), 'medium', 'high is not declared; medium is the honest fit');
  assert.equal(clampToScale('low', scale), 'low');
  assert.equal(clampToScale('xhigh', scale), 'xhigh');
});

test('clampToScale: an all-deeper scale returns its shallowest value', () => {
  assert.equal(clampToScale('low', ['xhigh', 'max'] as const), 'xhigh');
});

test('clampToScale: an empty or off-ladder scale leaves the request alone', () => {
  assert.equal(clampToScale('high', []), 'high');
});

// ── planUltra ───────────────────────────────────────────────────────────────────────────────

test('planUltra: undeclared endpoint is passthrough but marked unverified, never "ultra"', () => {
  const plan = planUltra({ effort: 'max' }, undefined);
  assert.equal(plan.effort, 'max', 'prior behaviour is preserved for undeclared endpoints');
  assert.equal(plan.unverified, true);
  assert.deepEqual(plan.enabled, [], 'nothing may be claimed as enabled');
  assert.match(plan.summary, /unverified/);
  assert.doesNotMatch(plan.summary, /ultra/i, 'an uncertified endpoint must not be labelled ultra');
});

test('planUltra: an empty declaration is treated as no declaration', () => {
  assert.equal(planUltra({ effort: 'high' }, {}).unverified, true);
});

test('planUltra: declared Claude-shaped endpoint downgrades max to xhigh and says so', () => {
  const plan = planUltra(
    { effort: 'max' },
    {
      effortScale: ['low', 'medium', 'xhigh'] as const,
      adaptiveThinking: true,
      promptCache: true,
    },
  );
  assert.equal(plan.effort, 'xhigh');
  assert.equal(plan.degraded, true, 'a downgraded depth is a degradation and must be reported');
  assert.equal(plan.unverified, false);
  assert.match(plan.summary, /asked max/);
  assert.match(plan.summary, /adaptive-thinking/);
});

test('planUltra: full ladder is delivered intact when declared', () => {
  const plan = planUltra(
    { effort: 'max' },
    { effortScale: ['low', 'medium', 'high', 'xhigh', 'max'] as const, adaptiveThinking: true },
  );
  assert.equal(plan.effort, 'max');
  assert.equal(plan.degraded, false);
  assert.equal(plan.unverified, false);
  assert.match(plan.summary, /effort max/);
});

test('planUltra: a declared block omitting effortScale sends NO effort param', () => {
  // Fail closed. An endpoint that declares other capabilities but not a scale is asserting it
  // takes no effort parameter; sending one anyway is the over-claiming failure mode.
  const plan = planUltra({ effort: 'max' }, { promptCache: true });
  assert.deepEqual(plan.enabled, ['prompt-cache']);
  assert.ok(plan.unavailable.includes('effort'));
  assert.equal(plan.degraded, true);
});

test('planUltra: premium channels are only reported unavailable when actually requested', () => {
  const caps = { effortScale: ['low', 'max'] as const, promptCache: true };
  // Not requested → not a shortfall.
  const quiet = planUltra({ effort: 'max' }, caps);
  assert.deepEqual(quiet.unavailable, []);
  assert.equal(quiet.degraded, false);
  // Requested → surface it.
  const loud = planUltra({ effort: 'max', fastMode: true }, caps);
  assert.deepEqual(loud.unavailable.sort(), ['fast-mode']);
  assert.equal(loud.degraded, true);
  assert.match(loud.summary, /no fast-mode/);
});

test('planUltra: premium channels light up when declared and requested', () => {
  const plan = planUltra(
    { effort: 'high', fastMode: true, extendedCache: true },
    {
      effortScale: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
      fastMode: true,
      extendedCache: true,
    },
  );
  assert.deepEqual(plan.unavailable, []);
  assert.equal(plan.degraded, false);
  for (const c of ['fast-mode', 'extended-cache'] as const) {
    assert.ok(plan.enabled.includes(c), `${c} should be enabled`);
  }
});

test('planUltra: ultra never enables a premium channel the user did not ask for', () => {
  // Ultra bets on depth, not on spend. Fast mode is billed differently, so it stays opt-in even
  // on a fully capable endpoint.
  const plan = planUltra(
    { effort: 'max' },
    { effortScale: ['max'] as const, fastMode: true, extendedCache: true },
  );
  assert.ok(!plan.enabled.includes('fast-mode'));
  assert.ok(!plan.enabled.includes('extended-cache'));
});

// ── planNotice: the plan must actually reach the user ──────────────────────────────────────
//
// The first pass computed `degraded` and `unverified` and then dropped them on the floor, so the
// whole declaration layer was invisible. These pin visibility as behaviour, not as a field that
// happens to exist.

test('planNotice: a fully-delivered plan is SILENT', () => {
  const plan = planUltra({ effort: 'high' }, { effortScale: [...ULTRA_LADDER] });
  assert.equal(plan.degraded, false);
  assert.equal(plan.unverified, false);
  assert.equal(planNotice(plan), null, 'the normal case must not spam a notice every session');
});

test('planNotice: a downgrade announces the requested depth and the delivered one', () => {
  const plan = planUltra({ effort: 'max' }, { effortScale: ['low', 'medium', 'xhigh'] });
  assert.equal(plan.effort, 'xhigh');
  const n = planNotice(plan);
  assert.ok(n, 'a downgrade must be visible');
  assert.equal(n.severity, 'warn');
  // Both numbers must appear: "ultra" alone is the over-claim; the pair is the honest report.
  assert.match(n.body, /xhigh/);
  assert.match(n.body, /max/);
});

test('planNotice: an undeclared endpoint says unverified and NEVER says ultra', () => {
  const plan = planUltra({ effort: 'max' }, undefined);
  const n = planNotice(plan);
  assert.ok(n, 'an unverified endpoint must say so');
  assert.equal(n.severity, 'info', 'unverified is informational, not a warning');
  assert.match(n.body, /unverified/);
  assert.doesNotMatch(n.body.toLowerCase(), /ultra/, 'must not claim a mode it cannot confirm');
});
