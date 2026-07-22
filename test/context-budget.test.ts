import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampLocalContextBudget,
  keepLastTurnsForBudget,
  triggerRatioForBudget,
} from '../src/util/contextBudget.js';
import { looksLikeTokenOverflow } from '../src/provider/stream.js';
import { providerErrorHint } from '../src/util/errorHints.js';

test('clampLocalContextBudget: 128k config on 32k server → soft budget well under hard window', () => {
  // Known small window: must compact BEFORE 32k.
  const soft = clampLocalContextBudget(128_000, 32_768);
  assert.ok(soft < 28_000, `soft=${soft} must sit under ~28k so trigger leaves headroom`);
  assert.ok(soft >= 16_000, `soft=${soft} must still allow a real session`);
  assert.ok(soft * 0.9 < 32_768, 'even late trigger stays under server window');
});

test('clampLocalContextBudget: unknown window trusts configured (do NOT invent 32k)', () => {
  // 512k / 256k LAN serves have no reason to be clamped to a laptop-llama default.
  assert.equal(clampLocalContextBudget(128_000), 128_000);
  assert.equal(clampLocalContextBudget(128_000, 0), 128_000);
});

test('clampLocalContextBudget: 512k server keeps a large soft budget', () => {
  const soft = clampLocalContextBudget(128_000, 524_288);
  // min(128k, ~72% of 512k-headroom) = 128k — user config wins under a big window
  assert.equal(soft, 128_000);
  const soft2 = clampLocalContextBudget(400_000, 524_288);
  assert.ok(soft2 > 300_000 && soft2 < 524_288, `soft2=${soft2}`);
});

test('keepLastTurns / trigger ratio tighten on small budgets', () => {
  assert.equal(keepLastTurnsForBudget(24_000, 12), 6);
  assert.equal(keepLastTurnsForBudget(80_000, 12), 12);
  assert.equal(triggerRatioForBudget(24_000, 0.9), 0.8);
  assert.equal(triggerRatioForBudget(80_000, 0.9), 0.9);
});

test('looksLikeTokenOverflow: llama.cpp "available context size" message', () => {
  const msg =
    'request (32925 tokens) exceeds the available context size (32768 tokens), try increasing it';
  assert.equal(looksLikeTokenOverflow(msg), true);
  const hint = providerErrorHint(`http_400: ${msg}`);
  assert.ok(hint && /compact|context/i.test(hint), `hint=${hint}`);
});
