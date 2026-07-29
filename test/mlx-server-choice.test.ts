/**
 * Which MLX server serves a model — the field bug where Shadow could not load a model that runs
 * fine outside it.
 *
 * Shadow asked one question: "does config.json have a vision_config?" If yes it launched
 * `mlx_vlm.server`. But a vision_config means the model HAS vision, NOT that mlx-vlm can LOAD it.
 * Gemma-4 (`Gemma4ForConditionalGeneration`) is an any-to-any architecture that carries a
 * vision_config and is converted with — and natively implemented by — mlx-lm
 * (`mlx_lm/models/gemma4.py`). Handed to mlx-vlm it died matching `vision_tower.*` weights its own
 * layout does not have:
 *
 *     "…/mlx_vlm.server" exited (code 3) before it began serving.
 *       vision_tower.encoder.layers.9.self_attn.q_proj.linear.weight, …
 *       ERROR:    Application startup failed. Exiting.
 *
 * so the model was completely unusable in Shadow while `mlx_lm.server` served it at ~70 tok/s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mlxServerPlan, mlxLmSupportsArch, isMultimodalMlx } from '../src/gguf.js';

/** A model dir with the given config.json. */
function modelDir(cfg: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), 'mlx-model-'));
  writeFileSync(join(d, 'config.json'), JSON.stringify(cfg), 'utf8');
  return d;
}

/** A fake mlx-lm install laying out `<root>/bin/mlx_lm.server` + `<root>/lib/pyX/site-packages/mlx_lm/models/`. */
function fakeMlxLm(architectures: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'mlx-lm-'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'mlx_lm.server'), '#!/bin/sh\n', { mode: 0o755 });
  const models = join(root, 'lib', 'python3.12', 'site-packages', 'mlx_lm', 'models');
  mkdirSync(models, { recursive: true });
  for (const a of architectures) writeFileSync(join(models, `${a}.py`), '# stub\n', 'utf8');
  return join(root, 'bin', 'mlx_lm.server');
}

const GEMMA4 = { model_type: 'gemma4', architectures: ['Gemma4ForConditionalGeneration'], vision_config: { x: 1 }, image_token_id: 7 };
const PURE_VLM = { model_type: 'some_vlm_only', architectures: ['SomeVLMForConditionalGeneration'], vision_config: { x: 1 } };
const TEXT_ONLY = { model_type: 'qwen2', architectures: ['Qwen2ForCausalLM'] };

test('mlxLmSupportsArch reads the INSTALLED package, not a hardcoded list', () => {
  const bin = fakeMlxLm(['gemma4', 'qwen2']);
  assert.equal(mlxLmSupportsArch('gemma4', bin), true);
  assert.equal(mlxLmSupportsArch('qwen2', bin), true);
  assert.equal(mlxLmSupportsArch('not_implemented_here', bin), false);
  assert.equal(mlxLmSupportsArch('', bin), false, 'no model_type → no claim');
});

test('mlxLmSupportsArch degrades to false on an unfamiliar layout (never throws)', () => {
  assert.equal(mlxLmSupportsArch('gemma4', '/nonexistent/bin/mlx_lm.server'), false);
});

test('THE BUG: a Gemma-4 has a vision_config but must be served by mlx-lm', () => {
  const dir = modelDir(GEMMA4);
  try {
    // The old heuristic's input is unchanged — it really does look multimodal…
    assert.equal(isMultimodalMlx(dir), true, 'config.json does declare vision');
    // …but the plan must still lead with mlx-lm, because mlx-lm implements the architecture.
    const plan = mlxServerPlan({}, dir, true);
    assert.equal(plan[0], 'lm', `expected mlx-lm first, got ${JSON.stringify(plan)}`);
    assert.ok(plan.includes('vlm'), 'mlx-vlm stays as a fallback in case the check misjudges');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely VLM-only model still goes to mlx-vlm first', () => {
  const dir = modelDir(PURE_VLM);
  try {
    const plan = mlxServerPlan({}, dir, true);
    assert.equal(plan[0], 'vlm', `expected mlx-vlm first, got ${JSON.stringify(plan)}`);
    assert.ok(plan.includes('lm'), 'mlx-lm stays as the fallback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a text-only model never involves mlx-vlm', () => {
  const dir = modelDir(TEXT_ONLY);
  try {
    assert.deepEqual(mlxServerPlan({}, dir, true), ['lm']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit mlxServer override wins outright — no fallback, no second guess', () => {
  const dir = modelDir(GEMMA4);
  try {
    assert.deepEqual(mlxServerPlan({ mlxServer: 'vlm' }, dir, true), ['vlm']);
    assert.deepEqual(mlxServerPlan({ mlxServer: 'lm' }, dir, true), ['lm']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repo id that is not on disk yet cannot be inspected — assume text', () => {
  assert.deepEqual(mlxServerPlan({}, 'mlx-community/Some-Model-4bit', false), ['lm']);
});

test('every plan is non-empty and contains only known server kinds', () => {
  const dirs = [modelDir(GEMMA4), modelDir(PURE_VLM), modelDir(TEXT_ONLY)];
  try {
    for (const d of dirs) {
      for (const override of [undefined, 'auto', 'lm', 'vlm'] as const) {
        const plan = mlxServerPlan(override ? { mlxServer: override } : {}, d, true);
        assert.ok(plan.length >= 1, 'a model must always have somewhere to go');
        for (const k of plan) assert.ok(k === 'lm' || k === 'vlm', `unknown kind ${k}`);
        assert.equal(new Set(plan).size, plan.length, 'no duplicate attempts');
      }
    }
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});
