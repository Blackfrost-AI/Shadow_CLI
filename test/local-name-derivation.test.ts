import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLocalName, repairLocalLabels } from '../src/local/garage.js';
import type { ModelEntry } from '../src/config.js';

/**
 * The `/model` picker lists a preset by its LABEL. Before this, an MLX/HF model folder was named
 * with `basename()` — and a HuggingFace cache path ends in the snapshot's content hash, so the
 * picker showed `404364e7467a87a9e31777b71408e96caabd9d5b` and the only way to switch was to
 * retype that hash at `/local use`.
 */

const HF_SNAPSHOT =
  '/Volumes/ssd/hf-models/hub/models--SomeOrg--Vendor-model-4-E4B-it-tuned-4bit-g32-mxfp4-mixed_4_8-mlx/snapshots/404364e7467a87a9e31777b71408e96caabd9d5b';

test('deriveLocalName: a HuggingFace cache snapshot path yields the model name, not the hash', () => {
  assert.equal(deriveLocalName(HF_SNAPSHOT), 'Vendor-model-4-E4B-it-tuned-4bit-g32-mxfp4-mixed_4_8-mlx');
});

test('deriveLocalName: the cache directory itself works, with or without a trailing slash', () => {
  const dir = '/x/hub/models--mlx-community--Qwen3-30B-4bit';
  assert.equal(deriveLocalName(dir), 'Qwen3-30B-4bit');
  assert.equal(deriveLocalName(dir + '/'), 'Qwen3-30B-4bit');
  assert.equal(deriveLocalName(dir + '/snapshots/abc123def456abc123def456'), 'Qwen3-30B-4bit');
});

test('deriveLocalName: an org or model name containing -- still splits on the FIRST separator', () => {
  // sanitizeLocalName squeezes repeated dashes, so the org is dropped and the name survives flat.
  assert.equal(deriveLocalName('/x/models--some-org--name--with--dashes'), 'name-with-dashes');
});

test('deriveLocalName: .gguf files, plain folders and repo ids all keep working', () => {
  assert.equal(deriveLocalName('/models/Qwen3-Coder-30B-Q4_K_M.gguf'), 'Qwen3-Coder-30B-Q4_K_M');
  assert.equal(deriveLocalName('/models/my-mlx-model'), 'my-mlx-model');
  assert.equal(deriveLocalName('mlx-community/Llama-3.2-3B-Instruct-4bit'), 'Llama-3.2-3B-Instruct-4bit');
  assert.equal(deriveLocalName('~/models/local-thing/'), 'local-thing');
});

test('deriveLocalName: a bare hash directory falls back to a meaningful parent', () => {
  assert.equal(deriveLocalName('/models/my-model/snapshots/deadbeefdeadbeefdeadbeef'), 'my-model');
  // Nothing but hashes — degrade to the sanitized basename rather than throwing.
  assert.ok(deriveLocalName('/deadbeefdeadbeefdeadbeef').length > 0);
});

const mlx = (label: string, path: string): ModelEntry =>
  ({ label, provider: 'openai', model: path, mlx: path, group: 'Local' }) as ModelEntry;

test('repairLocalLabels: renames a hash-labelled MLX preset and leaves the wire model alone', () => {
  const before = [mlx('404364e7467a87a9e31777b71408e96caabd9d5b', HF_SNAPSHOT)];
  const { models, renamed } = repairLocalLabels(before);
  assert.equal(renamed.length, 1);
  assert.equal(models[0]!.label, 'Vendor-model-4-E4B-it-tuned-4bit-g32-mxfp4-mixed_4_8-mlx');
  assert.equal(models[0]!.model, HF_SNAPSHOT, 'the model an MLX server hot-loads must NOT change');
  assert.equal(models[0]!.mlx, HF_SNAPSHOT);
});

test('repairLocalLabels: leaves good labels, cloud presets and .gguf presets untouched', () => {
  const before: ModelEntry[] = [
    mlx('my-local-mlx', '/x/models--org--my-local-mlx/snapshots/aaaaaaaaaaaaaaaa'),
    { label: 'Opus', provider: 'anthropic', model: 'claude-opus-4-8' } as ModelEntry,
    { label: 'gguf-model', provider: 'openai', model: 'gguf-model', gguf: '/m/x.gguf' } as ModelEntry,
  ];
  const { models, renamed } = repairLocalLabels(before);
  assert.deepEqual(renamed, []);
  assert.deepEqual(models, before);
});

test('repairLocalLabels: a rename that would collide with an existing label is skipped', () => {
  const target = '/x/models--org--Taken/snapshots/bbbbbbbbbbbbbbbb';
  const before = [
    { label: 'Taken', provider: 'openai', model: 'Taken' } as ModelEntry,
    mlx('cccccccccccccccccccccccc', target),
  ];
  const { models, renamed } = repairLocalLabels(before);
  assert.deepEqual(renamed, [], 'no rename rather than two presets with the same name');
  assert.equal(models[1]!.label, 'cccccccccccccccccccccccc');
});

test('repairLocalLabels: a vLLM preset renames its served model name in step with the label', () => {
  const target = '/x/models--org--Served-Model/snapshots/dddddddddddddddd';
  const before = [{ label: 'dddddddddddddddd', provider: 'openai', model: 'dddddddddddddddd', vllm: target } as ModelEntry];
  const { models } = repairLocalLabels(before);
  assert.equal(models[0]!.label, 'Served-Model');
  assert.equal(models[0]!.model, 'Served-Model', 'vLLM serves under --served-model-name = the label');
});
