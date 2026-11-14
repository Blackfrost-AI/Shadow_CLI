import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promptCapabilitiesWithout, resolveSystem } from '../src/system/resolveSystem.js';

const INSTALL_DIR = new URL('..', import.meta.url).pathname;

function systemWithout(removed: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'shadow-inference-prompt-gate-'));
  return resolveSystem(home, {
    installDir: INSTALL_DIR,
    homedir: home,
    model: 'Lumix-4B',
    capabilities: promptCapabilitiesWithout(removed),
  });
}

test('inference toolkit module loads with both infer tools available', () => {
  const prompt = systemWithout([]);
  assert.match(prompt, /## Policies: inference toolkit/);
  assert.match(prompt, /infer_recon/);
  assert.match(prompt, /infer_capacity/);
});

test('inference toolkit module is omitted whole when infer_recon is removed', () => {
  const prompt = systemWithout(['infer_recon']);
  assert.doesNotMatch(prompt, /inference toolkit/);
  assert.doesNotMatch(prompt, /Inference Toolkit/);
  // The security toolkit (different module) is unaffected.
  assert.match(prompt, /## Policies: security engagement/);
});

test('inference toolkit module is omitted whole when infer_capacity is removed', () => {
  const prompt = systemWithout(['infer_capacity']);
  assert.doesNotMatch(prompt, /inference toolkit/);
});

test('tool lines for deferred research tools are filtered when the tool is removed', () => {
  const prompt = systemWithout(['repository_context']);
  // PROMPT_REFERENCED_TOOLS now includes repository_context, so prompt lines
  // referencing it must be stripped when the capability is absent.
  assert.doesNotMatch(prompt, /\brepository_context\b/);
});

test('tool_search references are filtered when tool_search is removed', () => {
  const prompt = systemWithout(['tool_search']);
  // security-engagement.md names tool_search in prose; the line must be stripped.
  assert.doesNotMatch(prompt, /\btool_search\b/);
});
