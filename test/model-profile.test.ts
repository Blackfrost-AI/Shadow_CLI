import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolveSystem } from '../src/system/resolveSystem.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url)); // test/ → repo root (prompts/ on disk)
const sys = (model?: string): string =>
  resolveSystem(repoRoot, { installDir: repoRoot, homedir: '/nonexistent-home-for-test', model });

test('a Lumix model gets the Lumix profile appended', () => {
  const s = sys('Lumix-4B');
  assert.match(s, /built for Shadow/i);
  assert.match(s, /one clean tool call/i); // the tuned tool-call discipline is present
});

test('the profile matches provider-prefixed and versioned Lumix names', () => {
  assert.match(sys('openai/Lumix-4B'), /built for Shadow/i);
  assert.match(sys('lumix-4b-v2'), /built for Shadow/i);
});

test('a non-Lumix model does NOT get the Lumix profile, but keeps the base + modules', () => {
  const s = sys('gpt-5');
  assert.doesNotMatch(s, /built for Shadow/i);
  assert.match(s, /Calibrate to your capability/i); // base still present
});

test('no model name → no profile, base intact', () => {
  const s = sys(undefined);
  assert.doesNotMatch(s, /built for Shadow/i);
  assert.match(s, /Calibrate to your capability/i);
});
