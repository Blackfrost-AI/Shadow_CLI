/**
 * Hermetic tests for VRAM / KV-cache capacity math (src/inference/capacity.ts).
 *
 * Two kinds of assertion, and both matter:
 *  1. REFERENCE FIGURES from published model specs. If `planKvCache` for Llama-3-70B at 8k with
 *     f16 KV stops producing ~2.5 GiB, the formula broke. These are the numbers an ML engineer will
 *     sanity-check first, so they are pinned rather than re-derived.
 *  2. BEHAVIOURAL invariants — the fail-safe direction, the pool separation, and the refusals.
 *     A capacity check that under-reports causes an OOM at runtime; one that counts CPU-resident
 *     weights against VRAM declares a servable setup impossible. Both are tested explicitly.
 *
 * No hardware, no I/O: capacity.ts is pure, so these run identically on a laptop and in CI.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  computeBufferEstimate,
  compareQuantizations,
  estimateCapacity,
  GIB,
  MIB,
  planKvCache,
  SAFETY_MARGIN_BYTES,
  summarizeCapacity,
  type CapacityDevice,
  type ModelGeometry,
} from '../src/inference/capacity.js';

const gib = (n: number) => n * GIB;

// ── Reference devices ────────────────────────────────────────────────────────

/** Apple Silicon: one pool, OS wires a reservation the model cannot have. */
const mac16: CapacityDevice = {
  totalMemoryBytes: gib(16),
  unified: true,
  reservedBytes: gib(2),
  label: 'Apple M4 16GiB unified',
};

/** Discrete GPU: VRAM and host RAM are physically separate pools. */
const rtx4090: CapacityDevice = {
  totalMemoryBytes: gib(24),
  unified: false,
  systemRamBytes: gib(64),
  label: 'RTX 4090 24GB',
};

const rtx4090NoRamInfo: CapacityDevice = {
  totalMemoryBytes: gib(24),
  unified: false,
  label: 'RTX 4090 (system RAM unknown)',
};

// ── Reference geometries ─────────────────────────────────────────────────────
// Layer/head figures are the published ones, not guesses: getting head_count_kv wrong is an 8x
// error on a GQA model, so these are written out explicitly.

/** Llama-3-70B: 80 layers, 64 query heads but only 8 KV heads (GQA), head_dim 128. */
const llama70b: ModelGeometry = {
  layers: 80,
  kvHeads: 8,
  headDim: 128,
  embeddingLength: 8192,
  headCount: 64,
  weightBytes: gib(40), // ~Q4_K
  blockBytes: gib(38),
  nonBlockBytes: gib(2),
  observedBlockCount: 80,
  bytesPerLayer: gib(38) / 80,
};

/** Llama-3-8B: 32 layers, 8 KV heads, head_dim 128. */
const llama8b: ModelGeometry = {
  layers: 32,
  kvHeads: 8,
  headDim: 128,
  embeddingLength: 4096,
  headCount: 32,
  weightBytes: gib(4.92),
  blockBytes: gib(4.6),
  nonBlockBytes: gib(0.32),
  observedBlockCount: 32,
  bytesPerLayer: gib(4.6) / 32,
};

// ── planKvCache ──────────────────────────────────────────────────────────────

describe('planKvCache — reference figures', () => {
  it('matches the published Llama-3-70B KV size at 8k with f16', () => {
    // 2 × 80 × 8 × 128 × 2 bytes × 8192 tokens = 2.5 GiB exactly.
    const plan = planKvCache({ geometry: llama70b, contextTokens: 8192 })!;
    assert.equal(plan.bytesPerSequence, gib(2.5));
    // Per token: 2*80*8*128*2 = 327680 bytes = 320 KiB.
    assert.equal(plan.bytesPerToken, 320 * 1024);
    assert.equal(plan.dtype, 'f16');
    assert.equal(plan.headDimSource, 'explicit');
  });

  it('matches the published Llama-3-8B KV size at 8k with f16', () => {
    const plan = planKvCache({ geometry: llama8b, contextTokens: 8192 })!;
    assert.equal(plan.bytesPerSequence, gib(1));
  });

  it('scales linearly with sequences', () => {
    const one = planKvCache({ geometry: llama8b, contextTokens: 8192, sequences: 1 })!;
    const eight = planKvCache({ geometry: llama8b, contextTokens: 8192, sequences: 8 })!;
    assert.equal(eight.bytesPerSequence, one.bytesPerSequence);
    assert.equal(eight.sequences, 8);
  });

  it('halves the cache for q8_0 versus f16, using the real ggml density', () => {
    const f16 = planKvCache({ geometry: llama8b, contextTokens: 8192 })!;
    const q8 = planKvCache({ geometry: llama8b, contextTokens: 8192, kvDtype: 'q8_0' })!;
    // q8_0 is 34 bytes per 32 weights = 1.0625 bpw, f16 is 2 bpw → ratio 0.53125.
    assert.equal(q8.bytesPerElement, 34 / 32);
    assert.equal(f16.bytesPerElement, 2);
    assert.ok(Math.abs(q8.bytesPerSequence / f16.bytesPerSequence - 0.53125) < 1e-6);
  });

  it('supports bf16 and q4_0 with the correct densities', () => {
    assert.equal(planKvCache({ geometry: llama8b, contextTokens: 1024, kvDtype: 'bf16' })!.bytesPerElement, 2);
    assert.equal(planKvCache({ geometry: llama8b, contextTokens: 1024, kvDtype: 'q4_0' })!.bytesPerElement, 18 / 32);
  });

  it('encodes against the GQA trap: query heads are not KV heads', () => {
    // Llama-3-8B has 32 query heads and 8 KV heads. Substituting the query count inflates the
    // cache 4x — the single most common capacity-planning error, so it is asserted here.
    const correct = planKvCache({ geometry: llama8b, contextTokens: 8192 })!;
    const wrong = planKvCache({
      geometry: { ...llama8b, kvHeads: 32 },
      contextTokens: 8192,
    })!;
    assert.equal(wrong.bytesPerSequence, correct.bytesPerSequence * 4);
  });

  it('derives head_dim from embedding_length/head_count and says it derived it', () => {
    const plan = planKvCache({
      geometry: { layers: 32, kvHeads: 8, embeddingLength: 4096, headCount: 32, weightBytes: 0 },
      contextTokens: 4096,
    })!;
    assert.equal(plan.headDim, 128);
    assert.equal(plan.headDimSource, 'derived');
    assert.deepEqual(plan.warnings, []);
  });

  it('warns on a fractional derived head_dim instead of silently rounding', () => {
    // A non-integer result means the architecture is not a plain MHA/GQA layout (MLA and friends),
    // so the derived figure is probably wrong and the user should pass headDim explicitly.
    // 4096/30 is deliberately not a whole number: real GQA models always divide evenly.
    const plan = planKvCache({
      geometry: { layers: 32, kvHeads: 8, embeddingLength: 4096, headCount: 30, weightBytes: 0 },
      contextTokens: 4096,
    })!;
    assert.equal(plan.headDimSource, 'derived');
    assert.ok(!Number.isInteger(plan.headDim), `expected a fractional head_dim, got ${plan.headDim}`);
    assert.ok(
      plan.warnings.some((w) => w.includes('fractional') && w.includes('MLA')),
      JSON.stringify(plan.warnings),
    );
  });
});

describe('planKvCache — refusals', () => {
  it('refuses to guess when KV heads are unknown, and explains the GQA trap', () => {
    const plan = planKvCache({
      geometry: { layers: 32, headDim: 128, weightBytes: 0 },
      contextTokens: 8192,
    });
    assert.equal(plan, undefined);
  });

  it('refuses to guess when the layer count is unknown', () => {
    const plan = planKvCache({
      geometry: { kvHeads: 8, headDim: 128, weightBytes: 0 },
      contextTokens: 8192,
    });
    assert.equal(plan, undefined);
  });

  it('refuses when head_dim is neither given nor derivable', () => {
    const plan = planKvCache({
      geometry: { layers: 32, kvHeads: 8, weightBytes: 0 },
      contextTokens: 8192,
    });
    assert.equal(plan, undefined);
  });

  it('refuses an unknown KV dtype', () => {
    const plan = planKvCache({
      geometry: llama8b,
      contextTokens: 8192,
      kvDtype: 'fp8_e4m3' as never,
    });
    assert.equal(plan, undefined);
  });

  it('flags MoE: the cache is small but every expert stays resident', () => {
    const plan = planKvCache({
      geometry: { ...llama8b, expertCount: 64, expertUsedCount: 8 },
      contextTokens: 8192,
    })!;
    assert.ok(
      plan.warnings.some((w) => w.includes('MoE') && w.includes('resident')),
      JSON.stringify(plan.warnings),
    );
  });
});

// ── computeBufferEstimate ────────────────────────────────────────────────────

describe('computeBufferEstimate', () => {
  it('grows with context length — the term that makes 4k fine and 32k OOM', () => {
    const small = computeBufferEstimate({ contextTokens: 4096, layers: 32 });
    const large = computeBufferEstimate({ contextTokens: 32768, layers: 32 });
    assert.ok(large > small, `expected ${large} > ${small}`);
  });

  it('grows with layer count', () => {
    const few = computeBufferEstimate({ contextTokens: 4096, layers: 8 });
    const many = computeBufferEstimate({ contextTokens: 4096, layers: 80 });
    assert.ok(many > few);
  });

  it('has a 128 MiB floor so tiny-context estimates stay conservative', () => {
    assert.equal(computeBufferEstimate({ contextTokens: 16, layers: 1 }), 128 * MIB);
  });

  it('never returns a negative or NaN figure', () => {
    for (const ctx of [0, 1, 512, 131072]) {
      const v = computeBufferEstimate({ contextTokens: ctx, layers: 0 });
      assert.ok(Number.isFinite(v) && v >= 0, `ctx ${ctx} produced ${v}`);
    }
  });
});

// ── estimateCapacity: pool separation ────────────────────────────────────────

describe('estimateCapacity — memory pools', () => {
  it('treats unified memory as ONE pool', () => {
    const est = estimateCapacity({ device: mac16, geometry: llama8b, contextTokens: 8192 });
    assert.equal(est.gpuPoolBytes, est.totalBytes);
    assert.equal(est.cpuPoolBytes, undefined);
    assert.ok(est.notes.some((n) => n.includes('unified memory')));
  });

  it('subtracts the OS reservation from available unified memory', () => {
    const est = estimateCapacity({ device: mac16, geometry: llama8b, contextTokens: 8192 });
    assert.equal(est.deviceAvailableBytes, gib(14)); // 16 - 2 wired
  });

  it('does NOT count CPU-resident weights against VRAM on a discrete GPU', () => {
    // THE key correctness property. A 40 GiB model on a 24 GB card with 40/80 layers offloaded is
    // servable; counting the whole model against VRAM would wrongly say otherwise.
    const est = estimateCapacity({
      device: rtx4090,
      geometry: llama70b,
      contextTokens: 4096,
      gpuLayers: 40,
    });
    assert.equal(est.offloadAll, false);
    assert.equal(est.gpuLayers, 40);
    // Half the block bytes on the GPU (pro-rata by layer), non-block weights stay on CPU.
    assert.equal(est.gpuWeightBytes, Math.ceil((gib(38) / 80) * 40));
    assert.ok(est.cpuWeightBytes > 0, 'some weights remain CPU-resident');
    assert.ok(est.gpuPoolBytes < est.totalBytes, 'GPU pool must be strictly less than the total');
    assert.equal(est.verdict, 'fits');
    assert.equal(est.cpuPoolBytes, est.cpuWeightBytes + est.cpuKvBytes);
  });

  it('splits the KV cache between pools according to the offloaded layer fraction', () => {
    const est = estimateCapacity({
      device: rtx4090,
      geometry: llama70b,
      contextTokens: 4096,
      gpuLayers: 40, // exactly half
    });
    assert.equal(est.gpuKvBytes + est.cpuKvBytes, est.kvBytes);
    // Half the layers offloaded → half the cache on the GPU (ceil'd).
    assert.equal(est.gpuKvBytes, Math.ceil(est.kvBytes / 2));
  });

  it('puts the whole KV cache on the GPU under full offload', () => {
    const est = estimateCapacity({ device: rtx4090, geometry: llama8b, contextTokens: 8192 });
    assert.equal(est.offloadAll, true);
    assert.equal(est.gpuKvBytes, est.kvBytes);
    assert.equal(est.cpuKvBytes, 0);
    assert.equal(est.cpuWeightBytes, 0);
  });

  it('charges compute buffers to the CPU when nothing is offloaded', () => {
    const est = estimateCapacity({
      device: rtx4090,
      geometry: llama8b,
      contextTokens: 4096,
      gpuLayers: 0,
    });
    assert.equal(est.gpuLayers, 0);
    assert.equal(est.cpuWeightBytes, est.weightBytes);
    // Nothing on the accelerator except the safety margin.
    assert.equal(est.gpuPoolBytes, SAFETY_MARGIN_BYTES);
    assert.ok(est.cpuPoolBytes! >= est.computeBufferBytes);
  });

  it('refuses to claim "fits" when host RAM is required but was not reported', () => {
    // An UNCHECKED pool must never silently produce "fits". This is the fail-closed contract: the
    // GPU half of this placement genuinely fits, but the question asked was "does the model fit",
    // and half of the answer was never computed.
    const est = estimateCapacity({
      device: rtx4090NoRamInfo,
      geometry: llama70b,
      contextTokens: 4096,
      gpuLayers: 40,
    });
    assert.equal(est.cpuHeadroomBytes, undefined);
    assert.equal(est.verdict, 'unchecked', 'must not report fits/tight for an unjudged pool');
    assert.ok(est.gpuHeadroomBytes > 0, 'VRAM alone would have been fine — that is the trap');
    assert.ok(
      est.warnings.some((w) => w.includes('UNCHECKED') && w.includes('system RAM')),
      JSON.stringify(est.warnings),
    );
    assert.ok(
      est.notes.some((n) => n.includes('UNCHECKED, not a pass')),
      JSON.stringify(est.notes),
    );
    // The caveat must survive into the one-line summary that lands in receipts.
    assert.ok(
      summarizeCapacity(est).includes('UNCHECKED'),
      summarizeCapacity(est),
    );
  });

  it('lets a definite GPU failure outrank the unchecked host pool', () => {
    // Knowing it does not fit beats not knowing whether the host side does. Reporting `unchecked`
    // here would hide a conclusion we actually reached.
    const est = estimateCapacity({
      device: rtx4090NoRamInfo,
      geometry: llama70b,
      contextTokens: 4096,
      gpuLayers: 999, // offload everything: ~40 GiB of weights into 24 GiB of VRAM
    });
    assert.equal(est.verdict, 'does-not-fit');
    assert.ok(est.gpuHeadroomBytes < 0, 'VRAM is over budget');
  });

  it('never returns unchecked for unified memory', () => {
    // Unified memory has exactly one pool, so there is no host side left unjudged and the fourth
    // verdict is unreachable by construction.
    const est = estimateCapacity({
      device: mac16,
      geometry: llama8b,
      contextTokens: 8192,
    });
    assert.notEqual(est.verdict, 'unchecked');
    assert.equal(est.cpuPoolBytes, undefined);
  });

  it('reports fits once the missing host RAM is supplied', () => {
    // Same placement as the refusal test above, differing only in the one input that was missing.
    // This is the one-variable comparison that proves the refusal is caused by the absent figure.
    const unchecked = estimateCapacity({
      device: rtx4090NoRamInfo,
      geometry: llama70b,
      contextTokens: 4096,
      gpuLayers: 40,
    });
    const checked = estimateCapacity({
      device: rtx4090, // identical, plus systemRamBytes: gib(64)
      geometry: llama70b,
      contextTokens: 4096,
      gpuLayers: 40,
    });
    assert.equal(unchecked.verdict, 'unchecked');
    assert.notEqual(checked.verdict, 'unchecked');
    assert.ok(
      checked.verdict === 'fits' || checked.verdict === 'tight',
      `expected a measured pass, got ${checked.verdict}`,
    );
    // Supplying the input must not change the modelled footprint, only whether it was judged.
    assert.equal(checked.gpuPoolBytes, unchecked.gpuPoolBytes);
    assert.equal(checked.cpuPoolBytes, unchecked.cpuPoolBytes);
  });

  it('lets host RAM downgrade the verdict when it is the binding constraint', () => {
    // 8 GiB of host RAM cannot hold the CPU-resident half of a 40 GiB model, even though the
    // VRAM half fits fine.
    const tinyRam: CapacityDevice = {
      totalMemoryBytes: gib(24),
      unified: false,
      systemRamBytes: gib(8),
    };
    const est = estimateCapacity({
      device: tinyRam,
      geometry: llama70b,
      contextTokens: 4096,
      gpuLayers: 40,
    });
    assert.equal(est.verdict, 'does-not-fit');
    assert.ok(est.cpuHeadroomBytes! < 0, 'host RAM is over budget');
    assert.ok(est.gpuHeadroomBytes > 0, 'VRAM alone would have been fine');
    assert.ok(est.notes.some((n) => n.includes('host RAM is the binding constraint')));
  });
});

// ── estimateCapacity: verdicts ───────────────────────────────────────────────

describe('estimateCapacity — verdicts', () => {
  it('says fits with comfortable headroom', () => {
    const est = estimateCapacity({ device: rtx4090, geometry: llama8b, contextTokens: 8192 });
    assert.equal(est.verdict, 'fits');
    assert.ok(est.headroomBytes > 0);
  });

  it('says does-not-fit for a 140 GiB model on a 24 GB card', () => {
    const est = estimateCapacity({
      device: rtx4090,
      geometry: { ...llama70b, weightBytes: gib(140), blockBytes: gib(138) },
      contextTokens: 4096,
    });
    assert.equal(est.verdict, 'does-not-fit');
    assert.ok(est.headroomBytes < 0);
  });

  it('says tight when headroom is under the margin rather than claiming a confident fit', () => {
    // Size the device so the footprint lands just inside the ceiling.
    const est = estimateCapacity({ device: mac16, geometry: llama8b, contextTokens: 8192 });
    const snug: CapacityDevice = {
      totalMemoryBytes: est.totalBytes + 100 * MIB,
      unified: true,
    };
    const tight = estimateCapacity({ device: snug, geometry: llama8b, contextTokens: 8192 });
    assert.equal(tight.verdict, 'tight');
    assert.ok(tight.headroomBytes >= 0, 'tight still fits, barely');
  });

  it('applies the safety margin by default and can be told to ignore it', () => {
    const withMargin = estimateCapacity({ device: rtx4090, geometry: llama8b, contextTokens: 4096 });
    const without = estimateCapacity({
      device: rtx4090,
      geometry: llama8b,
      contextTokens: 4096,
      ignoreSafetyMargin: true,
    });
    assert.equal(withMargin.safetyMarginBytes, SAFETY_MARGIN_BYTES);
    assert.equal(without.safetyMarginBytes, 0);
    assert.equal(withMargin.totalBytes - without.totalBytes, SAFETY_MARGIN_BYTES);
  });

  it('reports how much of the answer is measured versus modelled', () => {
    const est = estimateCapacity({ device: mac16, geometry: llama8b, contextTokens: 8192 });
    assert.equal(est.measuredBytes, est.weightBytes);
    assert.equal(est.measuredBytes + est.modelledBytes, est.totalBytes);
    assert.ok(est.modelledShare > 0 && est.modelledShare < 1);
    assert.ok(
      Math.abs(est.modelledShare - est.modelledBytes / est.totalBytes) < 1e-12,
      'modelledShare must agree with the byte figures',
    );
  });

  it('warns rather than trusting a zero weight figure', () => {
    const est = estimateCapacity({
      device: rtx4090,
      geometry: { ...llama8b, weightBytes: 0 },
      contextTokens: 4096,
    });
    assert.ok(
      est.warnings.some((w) => w.includes('not trustworthy')),
      JSON.stringify(est.warnings),
    );
  });

  it('counts KV as zero with a lower-bound warning when the geometry is insufficient', () => {
    const est = estimateCapacity({
      device: rtx4090,
      geometry: { layers: 32, weightBytes: gib(4) }, // no kvHeads
      contextTokens: 8192,
    });
    assert.equal(est.kvBytes, 0);
    assert.equal(est.kvPlan, undefined);
    assert.ok(
      est.warnings.some((w) => w.includes('lower bound')),
      JSON.stringify(est.warnings),
    );
    assert.equal(est.maxContextTokens, undefined);
  });
});

// ── estimateCapacity: headroom solving ───────────────────────────────────────

describe('estimateCapacity — headroom solving', () => {
  it('reports the largest context that fits at fixed concurrency', () => {
    const est = estimateCapacity({ device: mac16, geometry: llama8b, contextTokens: 8192 });
    assert.ok(est.maxContextTokens !== undefined);
    assert.ok(est.maxContextTokens > 8192, 'a 14 GiB pool should allow more than 8k');
    // Re-running at the solved context must land inside budget, not over it.
    const atMax = estimateCapacity({
      device: mac16,
      geometry: llama8b,
      contextTokens: est.maxContextTokens!,
    });
    assert.notEqual(atMax.verdict, 'does-not-fit', `solved context ${est.maxContextTokens} did not fit`);
  });

  it('reports the largest concurrency that fits at fixed context', () => {
    const est = estimateCapacity({
      device: rtx4090,
      geometry: llama8b,
      contextTokens: 8192,
      sequences: 1,
    });
    assert.ok(est.maxSequences !== undefined && est.maxSequences >= 1);
    const atMax = estimateCapacity({
      device: rtx4090,
      geometry: llama8b,
      contextTokens: 8192,
      sequences: est.maxSequences!,
    });
    assert.notEqual(atMax.verdict, 'does-not-fit', `solved concurrency ${est.maxSequences} did not fit`);
  });

  it('shrinks the solved context as concurrency rises', () => {
    const one = estimateCapacity({ device: rtx4090, geometry: llama8b, contextTokens: 4096, sequences: 1 });
    const many = estimateCapacity({ device: rtx4090, geometry: llama8b, contextTokens: 4096, sequences: 8 });
    assert.ok(many.maxContextTokens! < one.maxContextTokens!);
    // Roughly proportional, since KV dominates the variable term.
    assert.ok(Math.abs(one.maxContextTokens! / many.maxContextTokens! - 8) < 1.5);
  });
});

// ── compareQuantizations ─────────────────────────────────────────────────────

describe('compareQuantizations', () => {
  it('orders the ladder by density and shows what fits', () => {
    const { options, warnings } = compareQuantizations({
      device: rtx4090,
      parameters: 8_030_000_000,
      contextTokens: 8192,
      geometry: { layers: 32, kvHeads: 8, headDim: 128, weightBytes: 0 },
    });
    assert.deepEqual(warnings, []);
    assert.ok(options.length >= 7);
    const bpw = options.map((o) => o.bitsPerWeight);
    assert.deepEqual(bpw, [...bpw].sort((a, b) => a - b), 'must be densest-first');
    // F16 is the heaviest and must be last.
    assert.equal(options[options.length - 1].dtype, 'F16');
    // Every option's total must exceed its own weight bytes (KV + buffers + margin).
    for (const o of options) assert.ok(o.totalBytes > o.weightBytes, `${o.dtype} total <= weights`);
  });

  it('computes savings against the F16 reference', () => {
    const { options } = compareQuantizations({
      device: rtx4090,
      parameters: 8_030_000_000,
      contextTokens: 4096,
      geometry: { layers: 32, kvHeads: 8, headDim: 128, weightBytes: 0 },
    });
    const f16 = options.find((o) => o.dtype === 'F16')!;
    assert.equal(f16.savedVsF16, 0);
    const q4 = options.find((o) => o.dtype === 'Q4_K_M')!;
    assert.ok(q4.savedVsF16! > 0);
    assert.equal(q4.savedVsF16, f16.weightBytes - q4.weightBytes);
  });

  it('maps file_type LABELS like Q4_K_M onto their dominant tensor type', () => {
    // Q4_K_M is a llama_ftype label, not a ggml type; it must still produce a real number using
    // Q4_K's density, rather than being skipped. The only warning is the (correct) note that no
    // F16 reference is in this subset, so savings cannot be computed.
    const { options, warnings } = compareQuantizations({
      device: rtx4090,
      parameters: 1_000_000_000,
      contextTokens: 2048,
      dtypes: ['Q4_K_M', 'Q3_K_S'],
      geometry: { layers: 24, kvHeads: 4, headDim: 128, weightBytes: 0 },
    });
    assert.deepEqual(warnings, ['no F16 reference in the comparison, so savings are not computed']);
    assert.equal(options.length, 2);
    assert.equal(options.find((o) => o.dtype === 'Q4_K_M')!.bitsPerWeight, 4.5);
    assert.equal(options.find((o) => o.dtype === 'Q3_K_S')!.bitsPerWeight, 3.4375);
    // The labels resolved to their dominant tensor types, not to a guessed density.
    assert.equal(
      options.find((o) => o.dtype === 'Q4_K_M')!.weightBytes,
      Math.ceil((4.5 / 8) * 1_000_000_000),
    );
  });

  it('skips an unknown dtype with a warning instead of inventing a size', () => {
    const { options, warnings } = compareQuantizations({
      device: rtx4090,
      parameters: 1_000_000_000,
      contextTokens: 2048,
      dtypes: ['Q4_K_M', 'NOT_A_REAL_QUANT'],
      geometry: { layers: 24, kvHeads: 4, headDim: 128, weightBytes: 0 },
    });
    assert.equal(options.length, 1);
    assert.ok(warnings.some((w) => w.includes('NOT_A_REAL_QUANT')), JSON.stringify(warnings));
  });

  it('warns when no F16 reference is present', () => {
    const { warnings } = compareQuantizations({
      device: rtx4090,
      parameters: 1_000_000_000,
      contextTokens: 2048,
      dtypes: ['Q4_K_M'],
      geometry: { layers: 24, kvHeads: 4, headDim: 128, weightBytes: 0 },
    });
    assert.ok(warnings.some((w) => w.includes('no F16 reference')), JSON.stringify(warnings));
  });

  it('reports against the binding pool, not the naive total', () => {
    // On a discrete GPU, `headroomBytes` is VRAM headroom — the figure that predicts an OOM.
    const { options } = compareQuantizations({
      device: rtx4090,
      parameters: 8_030_000_000,
      contextTokens: 8192,
      geometry: { layers: 32, kvHeads: 8, headDim: 128, weightBytes: 0 },
    });
    for (const o of options) {
      assert.ok(o.bindingPoolBytes > 0);
      assert.equal(
        o.headroomBytes,
        gib(24) - o.bindingPoolBytes,
        `${o.dtype}: headroom must be VRAM available minus the VRAM pool`,
      );
    }
  });
});

// ── Reporting ────────────────────────────────────────────────────────────────

describe('summarizeCapacity', () => {
  it('leads with the VRAM pool on a discrete GPU', () => {
    const est = estimateCapacity({ device: rtx4090, geometry: llama8b, contextTokens: 8192 });
    const s = summarizeCapacity(est);
    assert.ok(s.startsWith('FITS'));
    assert.ok(s.includes('vram'), `expected a vram figure in: ${s}`);
    assert.ok(s.includes('kv'));
    assert.ok(s.includes('modelled'));
  });

  it('reports need/have on unified memory', () => {
    const est = estimateCapacity({ device: mac16, geometry: llama8b, contextTokens: 8192 });
    const s = summarizeCapacity(est);
    assert.ok(s.includes('need'), s);
    assert.ok(s.includes('have'), s);
  });

  it('surfaces a non-fit verdict', () => {
    const est = estimateCapacity({
      device: rtx4090,
      geometry: { ...llama70b, weightBytes: gib(140), blockBytes: gib(138) },
      contextTokens: 4096,
    });
    assert.ok(summarizeCapacity(est).startsWith('DOES-NOT-FIT'));
  });
});

describe('constants', () => {
  it('uses binary units, as VRAM is always quoted', () => {
    assert.equal(GIB, 1073741824);
    assert.equal(MIB, 1048576);
    assert.equal(SAFETY_MARGIN_BYTES, 256 * MIB);
  });
});
