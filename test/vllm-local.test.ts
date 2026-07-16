import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLocalEntry, listLocalModels, formatLocalList } from '../src/local/garage.js';
import { isLocalModelTarget } from '../src/safety/offline.js';
import type { ModelEntry } from '../src/config.js';

// buildLocalEntry routes a model FOLDER / repo id by platform (Apple→MLX, Linux→vLLM). The suite
// runs on macOS, so force process.platform to exercise the Linux/vLLM branch.
function withPlatform(p: string, fn: () => void): void {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
}

test('a safetensors model FOLDER builds a vLLM entry on Linux', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vllm-model-'));
  writeFileSync(join(dir, 'config.json'), '{}');
  writeFileSync(join(dir, 'model.safetensors'), 'x');
  withPlatform('linux', () => {
    const r = buildLocalEntry({ path: dir });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.vllm, dir);
      assert.equal(r.value.mlx, undefined, 'not an mlx entry on Linux');
      assert.equal(r.value.gguf, undefined);
      assert.equal(r.value.provider, 'openai');
      // vLLM serves under --served-model-name = the friendly label, so the wire model is the label.
      assert.equal(r.value.model, r.value.label);
      assert.equal(r.value.group, 'Local');
    }
  });
});

test('a HF repo id builds a vLLM entry on Linux (downloaded on first use)', () => {
  withPlatform('linux', () => {
    const r = buildLocalEntry({ path: 'org/some-model' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.vllm, 'org/some-model');
    assert.match(r.note ?? '', /download/i);
  });
});

test('--gpu-layers is rejected for a vLLM model (it is a llama.cpp option)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vllm-model-'));
  writeFileSync(join(dir, 'config.json'), '{}');
  withPlatform('linux', () => {
    assert.equal(buildLocalEntry({ path: dir, gpuLayers: 40 }).ok, false);
  });
});

test('listLocalModels / formatLocalList / isLocalModelTarget include vLLM entries', () => {
  const models = [{ label: 'v', provider: 'openai', model: 'v', vllm: '/models/x' }] as ModelEntry[];
  assert.equal(listLocalModels(models).length, 1, 'vllm entry is a local model');
  assert.equal(isLocalModelTarget({ vllm: '/models/x' }), true, 'vllm is a local target (offline-allowed)');
  assert.match(formatLocalList(models)[0]!, /vllm/, 'listed with the vllm engine tag');
});
