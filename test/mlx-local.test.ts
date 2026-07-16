import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLocalEntry, listLocalModels, formatLocalList, addLocalModel } from '../src/local/garage.js';
import { isLocalModelTarget } from '../src/safety/offline.js';
import { isMlxDir, mlxOfflineReady } from '../src/gguf.js';

const APPLE = process.platform === 'darwin' && process.arch === 'arm64';

test('an MLX model FOLDER (config.json inside) builds an mlx entry — Apple Silicon only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlx-model-'));
  writeFileSync(join(dir, 'config.json'), '{}');
  writeFileSync(join(dir, 'model.safetensors'), 'x');
  const r = buildLocalEntry({ path: dir });
  if (APPLE) {
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.mlx, dir);
      assert.equal(r.value.gguf, undefined);
      assert.equal(r.value.provider, 'openai');
    }
  } else {
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /Apple Silicon/);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('an mlx-community repo id builds an mlx entry with a download note', () => {
  const r = buildLocalEntry({ path: 'mlx-community/Qwen2.5-0.5B-Instruct-4bit' });
  if (APPLE) {
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.mlx, 'mlx-community/Qwen2.5-0.5B-Instruct-4bit');
      assert.match(r.note ?? '', /download.*HuggingFace/i);
    }
  } else {
    assert.equal(r.ok, false);
  }
});

test('a directory WITHOUT config.json is rejected with a clear message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'not-mlx-'));
  const r = buildLocalEntry({ path: dir });
  assert.equal(r.ok, false);
  if (!r.ok && APPLE) assert.match(r.message, /no config\.json inside/);
  rmSync(dir, { recursive: true, force: true });
});

test('MLX: --gpu-layers refused; --ctx accepted as a BUDGET HINT (stored on the entry)', { skip: !APPLE }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlx-model-'));
  writeFileSync(join(dir, 'config.json'), '{}');
  const gpu = buildLocalEntry({ path: dir, gpuLayers: 10 });
  assert.equal(gpu.ok, false);
  if (!gpu.ok) assert.match(gpu.message, /llama\.cpp \(\.gguf\) option/);
  const ctx = buildLocalEntry({ path: dir, ctx: 8192 });
  assert.equal(ctx.ok, true, '--ctx bounds the context budget for MLX models');
  if (ctx.ok) assert.equal(ctx.value.ctx, 8192);
  const tiny = buildLocalEntry({ path: dir, ctx: 1024 });
  assert.equal(tiny.ok, false, 'sub-2048 hint rejected');
  rmSync(dir, { recursive: true, force: true });
});

test('mlx entries appear in the local list with an mlx tag', { skip: !APPLE }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlx-model-'));
  writeFileSync(join(dir, 'config.json'), '{}');
  const added = addLocalModel([], { path: dir });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(listLocalModels(added.value.models).length, 1);
  const row = formatLocalList(added.value.models)[0]!;
  assert.match(row, /· {2}mlx {2}·/);
  rmSync(dir, { recursive: true, force: true });
});

test('offline mode treats an mlx entry as local', () => {
  assert.equal(isLocalModelTarget({ mlx: 'mlx-community/some-model' }), true);
  assert.equal(isLocalModelTarget({}), false);
});

test('isMlxDir: paths look like dirs; repo ids do not', () => {
  assert.equal(isMlxDir('/Users/x/models/foo'), true, 'absolute path');
  assert.equal(isMlxDir('~/models/foo'), true, 'tilde path');
  assert.equal(isMlxDir('mlx-community/Qwen2.5-0.5B-Instruct-4bit'), false, 'repo id');
});

test('mlx entry wire model is the TARGET, not the label — mlx_lm.server resolves the model field', { skip: !APPLE }, () => {
  // Live-caught bug: llama-server ignores the request's `model`, but mlx_lm.server HONORS it and
  // tries to hot-load it as a HuggingFace repo — sending the friendly label 404'd every request.
  const r = buildLocalEntry({ path: 'mlx-community/Qwen2.5-0.5B-Instruct-4bit', name: 'friendly' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.label, 'friendly', 'label stays friendly');
    assert.equal(r.value.model, 'mlx-community/Qwen2.5-0.5B-Instruct-4bit', 'wire model = real target');
  }
});

test('mlxOfflineReady: dir targets ready; repo ids only when the HF cache has them', () => {
  const hub = mkdtempSync(join(tmpdir(), 'hf-hub-'));
  // Uncached repo id → NOT offline-ready (serving would download from huggingface.co).
  assert.equal(mlxOfflineReady('mlx-community/Some-Model-4bit', hub), false);
  // Simulate a cached snapshot → ready.
  mkdirSync(join(hub, 'models--mlx-community--Some-Model-4bit', 'snapshots'), { recursive: true });
  assert.equal(mlxOfflineReady('mlx-community/Some-Model-4bit', hub), true);
  // A real local dir target is always ready.
  const dir = mkdtempSync(join(tmpdir(), 'mlx-dir-'));
  writeFileSync(join(dir, 'config.json'), '{}');
  assert.equal(mlxOfflineReady(dir, hub), true);
  rmSync(hub, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('isMultimodalMlx: detects a vision_config (→ mlx-vlm), false for text-only or repo id', async () => {
  const { isMultimodalMlx } = await import('../src/gguf.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const vdir = mkdtempSync(join(tmpdir(), 'mlxvlm-'));
  writeFileSync(join(vdir, 'config.json'), JSON.stringify({ model_type: 'gemma4_unified', vision_config: { hidden_size: 1 }, image_token_id: 7 }));
  assert.equal(isMultimodalMlx(vdir), true, 'vision_config → multimodal');
  const tdir = mkdtempSync(join(tmpdir(), 'mlxtext-'));
  writeFileSync(join(tdir, 'config.json'), JSON.stringify({ model_type: 'gemma4_text' }));
  assert.equal(isMultimodalMlx(tdir), false, 'text-only → not multimodal');
  assert.equal(isMultimodalMlx('mlx-community/some-repo'), false, 'repo id (no local config) → false');
});
