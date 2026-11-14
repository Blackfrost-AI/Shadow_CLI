/**
 * VRAM / KV-cache capacity planning — the arithmetic that decides whether a model fits.
 *
 * Pure functions only: no I/O, no spawning, no network. Inputs are numbers the caller obtained
 * elsewhere (`ggufMeta` for the model, `gpu` for the device), so every result here is reproducible
 * and testable without hardware. That separation is deliberate — sizing math that quietly depends
 * on the machine it ran on cannot be audited later.
 *
 * THE RULE THAT MATTERS: every number this module returns is labelled as MEASURED or MODELLED.
 *  - MEASURED comes from bytes actually on disk (the GGUF tensor extents).
 *  - MODELLED is an estimate for a component we could not measure — the KV cache for a server that
 *    has not started, the compute buffer, the CUDA context overhead.
 * A verdict built on a modelled figure is still useful, but it must never be presented with the
 * confidence of a measured one. `verdict` therefore carries the estimate breakdown so the caller
 * can show the user how much of the answer is arithmetic and how much is assumption.
 *
 * Fail direction: every uncertainty pushes the estimate UP, never down. A capacity check that
 * under-reports causes an OOM at runtime, which is far worse than a conservative "this might not
 * fit" that the user can override knowingly. Hence `SAFETY_MARGIN_BYTES`, ceil'd per-request KV,
 * and `computeBufferEstimate` erring high.
 */
import { GGML_TYPES, ggmlTypeByName, kvBytesPerElement, type GgufMeta } from './ggufMeta.js';

/**
 * Headroom to leave free on a device beyond the modelled footprint.
 *
 * Not arbitrary: a GPU also hosts the process's own CUDA/ROCm context, driver allocations, and
 * fragmentation, and hitting the ceiling produces an unrecoverable OOM rather than a slow-down.
 * 256 MiB is the floor llama.cpp users routinely need for the runtime itself on a small card.
 */
export const SAFETY_MARGIN_BYTES = 256 * 1024 * 1024;

/** Bytes in a GiB — VRAM and unified memory are both quoted in binary units everywhere in ML. */
export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;

// ── Device ───────────────────────────────────────────────────────────────────

export interface CapacityDevice {
  /** Usable bytes for model + KV + buffers. Caller subtracts what is already in use. */
  totalMemoryBytes: number;
  /**
   * True when CPU and GPU share one address space (Apple Silicon, or an APU).
   *
   * This changes the answer materially: unified memory has no PCIe offload decision to make and no
   * separate VRAM ceiling, but the OS keeps a wired reservation the model cannot use. It is also
   * why `-ngl 999` is simply correct on a Mac rather than a tuning question.
   */
  unified?: boolean;
  /** Bytes the OS has already wired/reserved and cannot hand to the model. */
  reservedBytes?: number;
  /**
   * Host RAM available for the CPU-resident part of a PARTIAL offload, in bytes.
   *
   * Only meaningful when `unified` is false. Without it a discrete-GPU partial-offload verdict
   * would have to count CPU-resident weights against VRAM — which is simply wrong, and which makes
   * a perfectly servable 70B-on-24GB-with-offload setup look impossible. When it is absent we say
   * so rather than inventing a system-RAM figure.
   */
  systemRamBytes?: number;
  label?: string;
}

/** Bytes actually available to a model on this device, after the OS reservation. */
export function availableBytes(device: CapacityDevice): number {
  const total = Math.max(0, device.totalMemoryBytes);
  const reserved = Math.max(0, device.reservedBytes ?? 0);
  return Math.max(0, total - reserved);
}

// ── Model inputs ─────────────────────────────────────────────────────────────

/**
 * The geometry that determines KV-cache size.
 *
 * Every field comes from a parsed GGUF header where possible. `headDim` is deliberately optional:
 * most architectures satisfy `embeddingLength / headCount`, but NOT all (DeepSeek-style MLA and
 * some GQA variants differ), so it must be settable explicitly and its derivation reported.
 */
export interface ModelGeometry {
  /**
   * Transformer layers — `blk.*` count, or `<arch>.block_count`.
   *
   * Optional on purpose: a GGUF may not declare it and a caller may not know it. `planKvCache`
   * REFUSES rather than substituting a guess, so optionality here is what makes the refusal
   * reachable and testable.
   */
  layers?: number;
  /**
   * KV heads (`attention.head_count_kv`) — what the cache scales with, NOT query heads.
   * Optional for the same reason as `layers`; never defaulted from `headCount`.
   */
  kvHeads?: number;
  /** Per-head dimension. Defaults to `embeddingLength / headCount`. */
  headDim?: number;
  embeddingLength?: number;
  headCount?: number;
  /** Weights in bytes, MEASURED from tensor extents where the caller has them. */
  weightBytes: number;
  /** Bytes inside `blk.*` tensors — the part GPU offload can actually move. */
  blockBytes?: number;
  /** Bytes that stay resident regardless of offload (embeddings, output head). */
  nonBlockBytes?: number;
  /**
   * `blockBytes / observedBlockCount`: the marginal cost of offloading one more LAYER.
   * Named `Layer` rather than `Block` because in this codebase "block" already means a ggml quant
   * block (QK_K = 256 weights), and conflating the two would silently misplace a factor of 256.
   */
  bytesPerLayer?: number;
  /** Layers implied by the tensor names, when known, for cross-checking `layers`. */
  observedBlockCount?: number;
  /** >0 means mixture-of-experts: all experts are resident even though few activate per token. */
  expertCount?: number;
  /** Experts activated per token. Informational — it does not reduce resident memory. */
  expertUsedCount?: number;
}

/** KV cache dtype. Named the way llama.cpp/vLLM name them, so a user's flag maps directly. */
export type KvDtype = 'f32' | 'f16' | 'bf16' | 'q8_0' | 'q4_0';

const DEFAULT_KV_DTYPE: KvDtype = 'f16';

/**
 * Compute buffers: the scratch space for attention scores, intermediate activations, and the
 * prompt-processing work buffers.
 *
 * Modelled, never measured. It scales with the longest sequence the server will accept and with
 * batch size, and llama.cpp exposes it as a tunable (`--buffer-size`/`-b`). The constants below
 * are conservative by design; when a real server is running, prefer its reported figure.
 */
export function computeBufferEstimate(input: {
  contextTokens: number;
  batchTokens?: number;
  layers: number;
}): number {
  const ctx = Math.max(0, input.contextTokens);
  const batch = Math.max(1, input.batchTokens ?? Math.min(ctx, 2048));
  // Attention-score scratch for one batch tile: batch × ctx × 4 bytes (f32 scores), plus per-layer
  // activation working set. Both grow with sequence length, which is the term that surprises people
  // when a 4k context is fine and 32k OOMs.
  const attnScratch = batch * ctx * 4;
  const perLayer = batch * 1024 * 4;
  const total = attnScratch + perLayer * Math.max(1, input.layers);
  // Floor at 128 MiB: small-context estimates otherwise understate what llama.cpp actually allocates.
  return Math.max(total, 128 * MIB);
}

// ── KV cache ─────────────────────────────────────────────────────────────────

export interface KvCachePlan {
  /** Bytes for ONE sequence at the full context length. */
  bytesPerSequence: number;
  /** Bytes per token of context, for all sequences. */
  bytesPerToken: number;
  dtype: KvDtype;
  bytesPerElement: number;
  layers: number;
  kvHeads: number;
  headDim: number;
  /** How `headDim` was obtained — stated, because a wrong derivation silently doubles the answer. */
  headDimSource: 'explicit' | 'derived' | 'unknown';
  sequences: number;
  contextTokens: number;
  warnings: string[];
}

/**
 * KV-cache size for `sequences` concurrent requests of `contextTokens` each.
 *
 * Formula: 2 (K and V) × layers × kvHeads × headDim × bytesPerElement × tokens × sequences.
 *
 * The two classic mistakes this encodes against:
 *  1. Using QUERY heads instead of KV heads. With GQA the KV cache is a fraction of the naive
 *     figure — Llama-3-70B has 64 query heads but 8 KV heads, so guessing wrong is an 8× error.
 *  2. Forgetting the ×2 for K and V.
 *
 * Returns `undefined` when the geometry is insufficient; guessing a layer or head count would
 * produce a confident wrong number, which is worse than no number.
 */
export function planKvCache(input: {
  geometry: ModelGeometry;
  contextTokens: number;
  sequences?: number;
  kvDtype?: KvDtype;
}): KvCachePlan | undefined {
  const warnings: string[] = [];
  const { geometry } = input;
  const dtype = input.kvDtype ?? DEFAULT_KV_DTYPE;
  const sequences = Math.max(1, Math.floor(input.sequences ?? 1));
  const contextTokens = Math.max(0, Math.floor(input.contextTokens));

  if (geometry.layers === undefined || !Number.isFinite(geometry.layers) || geometry.layers <= 0) {
    warnings.push('layer count unknown — cannot size the KV cache');
    return undefined;
  }
  if (geometry.kvHeads === undefined || !Number.isFinite(geometry.kvHeads) || geometry.kvHeads <= 0) {
    warnings.push(
      'attention.head_count_kv unknown — cannot size the KV cache. ' +
        'Do NOT substitute attention.head_count: with GQA that overstates the cache, and the ' +
        'factor can be 8× (e.g. Llama-3-70B has 64 query heads but 8 KV heads).',
    );
    return undefined;
  }

  // headDim: explicit wins; otherwise derive from embedding/headCount and SAY we derived it.
  let headDim = geometry.headDim;
  let headDimSource: KvCachePlan['headDimSource'] = 'explicit';
  if (!headDim || headDim <= 0) {
    if (geometry.embeddingLength && geometry.headCount && geometry.headCount > 0) {
      headDim = geometry.embeddingLength / geometry.headCount;
      headDimSource = 'derived';
      if (!Number.isInteger(headDim)) {
        warnings.push(
          `derived head_dim = ${headDim} is fractional (embedding_length ${geometry.embeddingLength} / head_count ${geometry.headCount}); ` +
            'this architecture may use a non-standard head layout (e.g. MLA) — pass headDim explicitly',
        );
      }
    } else {
      warnings.push('head_dim unknown and not derivable (need embedding_length and head_count)');
      return undefined;
    }
  }

  const bytesPerElement = kvBytesPerElement(dtype);
  if (bytesPerElement === undefined) {
    warnings.push(`unknown KV dtype "${dtype}"`);
    return undefined;
  }

  // MoE does not change KV size (attention is not expert-routed) but is worth flagging so the
  // caller does not mistake a small active-parameter count for a small cache.
  if (geometry.expertCount && geometry.expertCount > 0) {
    warnings.push(
      `model is MoE (${geometry.expertCount} experts); KV cache depends on attention geometry only, ` +
        'but ALL experts stay resident in memory',
    );
  }

  const bytesPerToken = 2 * geometry.layers * geometry.kvHeads * headDim * bytesPerElement;
  // Ceil per sequence: a server allocates whole blocks per sequence, not fractional bytes.
  const bytesPerSequence = Math.ceil(bytesPerToken * contextTokens);

  return {
    bytesPerSequence,
    bytesPerToken,
    dtype,
    bytesPerElement,
    layers: geometry.layers,
    kvHeads: geometry.kvHeads,
    headDim,
    headDimSource,
    sequences,
    contextTokens,
    warnings,
  };
}

// ── Fit verdict ──────────────────────────────────────────────────────────────

/**
 * Outcome of a capacity judgement.
 *
 * `unchecked` is a FOURTH state, not a synonym for `tight`. `tight` means every pool was measured
 * and at least one has little margin; `unchecked` means a pool that this placement depends on was
 * never judged at all, so no claim of fitness can be made. Collapsing the two would let a missing
 * input masquerade as a measurement — exactly the confusion this module refuses everywhere else.
 *
 * Ordering for worst-wins composition: a definite failure outranks an unknown, which outranks a
 * confirmed-but-narrow fit, which outranks a comfortable fit.
 */
export type FitVerdict = 'does-not-fit' | 'unchecked' | 'tight' | 'fits';

export interface CapacityEstimate {
  device: CapacityDevice;
  deviceAvailableBytes: number;
  /** Bytes the model occupies on the chosen placement. */
  weightBytes: number;
  /** Where the weights live, and how much of that is a modelling assumption. */
  gpuWeightBytes: number;
  cpuWeightBytes: number;
  gpuLayers: number;
  offloadAll: boolean;
  kvBytes: number;
  /** KV that lands on the accelerator (the layers you offloaded take their cache with them). */
  gpuKvBytes: number;
  cpuKvBytes: number;
  kvPlan?: KvCachePlan;
  computeBufferBytes: number;
  safetyMarginBytes: number;
  /** Sum of everything above: what the process will try to hold, across all pools. */
  totalBytes: number;
  headroomBytes: number;
  /**
   * What the ACCELERATOR pool must hold. On unified memory this equals `totalBytes`; on a discrete
   * GPU with partial offload it is strictly less, which is the whole point of offloading.
   */
  gpuPoolBytes: number;
  gpuPoolAvailableBytes: number;
  gpuHeadroomBytes: number;
  /** What host RAM must hold for the CPU-resident part. Undefined when the device does not say. */
  cpuPoolBytes?: number;
  cpuPoolAvailableBytes?: number;
  cpuHeadroomBytes?: number;
  verdict: FitVerdict;
  /**
   * How much of `totalBytes` is MEASURED (from real tensor extents) vs MODELLED (KV, buffers,
   * margin). Surfaced because a verdict resting mostly on modelled figures deserves less trust.
   */
  measuredBytes: number;
  modelledBytes: number;
  modelledShare: number;
  notes: string[];
  warnings: string[];
  /** Largest context the CHECKED pools can hold, holding sequences fixed. Absent when KV is unknown. */
  maxContextTokens?: number;
  /** Sequences the CHECKED pools can hold at the requested context. Absent when KV is unknown. */
  maxSequences?: number;
  /**
   * True when `maxContextTokens` is the search bound rather than a discovered edge — i.e. the real
   * ceiling is AT LEAST this. A bare number cannot express that, and reporting a bound as an exact
   * maximum silently understates capacity (the probe showed 65536 reported while 66536 also fit).
   */
  maxContextTokensBounded?: boolean;
  /** Same caveat for `maxSequences`. */
  maxSequencesBounded?: boolean;
}

/**
 * Decide whether a model at a given context length and concurrency fits on a device.
 *
 * `gpuLayers` semantics match llama.cpp's `-ngl`: how many `blk.*` layers are offloaded. 0 leaves
 * everything on the CPU; a value ≥ the layer count offloads everything. Non-block weights
 * (embeddings, output head) stay on the CPU unless offload is complete — that is what makes the
 * split in `ModelGeometry` worth carrying through.
 */
export function estimateCapacity(input: {
  device: CapacityDevice;
  geometry: ModelGeometry;
  contextTokens: number;
  sequences?: number;
  kvDtype?: KvDtype;
  gpuLayers?: number;
  /** Override the modelled compute-buffer figure with a measured one (e.g. from a live server). */
  computeBufferBytes?: number;
  batchTokens?: number;
  /** Skip the safety margin — only for "how much is theoretically possible" questions. */
  ignoreSafetyMargin?: boolean;
  /**
   * Internal: suppress the headroom search.
   *
   * The search probes `estimateCapacity` to test candidate context lengths, so a probe that also
   * searched would recurse without end. Every internal probe sets this. Callers never do.
   */
  internalNoHeadroomSearch?: boolean;
}): CapacityEstimate {
  const warnings: string[] = [];
  const notes: string[] = [];
  const device = input.device;
  const geometry = input.geometry;
  const sequences = Math.max(1, Math.floor(input.sequences ?? 1));
  const contextTokens = Math.max(0, Math.floor(input.contextTokens));
  const deviceAvailableBytes = availableBytes(device);

  const layers =
    geometry.layers !== undefined && Number.isFinite(geometry.layers) && geometry.layers > 0
      ? geometry.layers
      : 0;
  const gpuLayersRequested = input.gpuLayers;
  // Default: offload everything. On unified memory that is always right; on a discrete GPU the
  // caller should pass an explicit `-ngl` and we will report the shortfall instead of guessing.
  const offloadAll = gpuLayersRequested === undefined || (layers > 0 && gpuLayersRequested >= layers);
  const gpuLayers = offloadAll ? layers : Math.max(0, Math.min(gpuLayersRequested ?? 0, layers));

  // ── Weight placement ──
  const blockBytes = geometry.blockBytes;
  const nonBlockBytes = geometry.nonBlockBytes;
  let gpuWeightBytes: number;
  let cpuWeightBytes: number;
  const weightMeasured = Number.isFinite(geometry.weightBytes) && geometry.weightBytes > 0;

  if (offloadAll) {
    gpuWeightBytes = geometry.weightBytes;
    cpuWeightBytes = 0;
    notes.push('full offload: all weights on the accelerator');
  } else if (blockBytes !== undefined && nonBlockBytes !== undefined && layers > 0) {
    // Pro-rata by layer: `blk.*` bytes scale linearly with the number of offloaded layers, while
    // non-block tensors stay resident on the CPU no matter what `-ngl` says.
    const perLayer = geometry.bytesPerLayer ?? blockBytes / layers;
    gpuWeightBytes = Math.ceil(perLayer * gpuLayers);
    cpuWeightBytes = Math.max(0, geometry.weightBytes - gpuWeightBytes);
    notes.push(`partial offload: ${gpuLayers}/${layers} layers on the accelerator, rest on CPU`);
  } else {
    // No block/non-block split available: assume proportional placement and say it is an estimate.
    const frac = layers > 0 ? gpuLayers / layers : 0;
    gpuWeightBytes = Math.ceil(geometry.weightBytes * frac);
    cpuWeightBytes = Math.max(0, geometry.weightBytes - gpuWeightBytes);
    if (!offloadAll) {
      warnings.push(
        'partial offload requested but the GGUF block/non-block byte split is unavailable; ' +
          'weight placement is estimated proportionally by layer count',
      );
    }
  }
  if (!weightMeasured) {
    warnings.push('weight bytes are zero or unknown — the model component of this estimate is not trustworthy');
  }

  // ── KV cache ──
  const kvPlan = planKvCache({ geometry, contextTokens, sequences, kvDtype: input.kvDtype });
  const kvBytes = kvPlan ? kvPlan.bytesPerSequence * kvPlan.sequences : 0;
  if (kvPlan) warnings.push(...kvPlan.warnings);
  else warnings.push('KV cache could not be sized; it is counted as ZERO, so this estimate is a lower bound');

  // The KV cache lives where its layers live: an offloaded layer's K/V is on the accelerator, a
  // CPU-resident layer's is in host RAM. Splitting it matters for partial offload, where the naive
  // "all KV on GPU" assumption overstates VRAM use by up to the offloaded fraction.
  let gpuKvBytes = kvBytes;
  let cpuKvBytes = 0;
  if (kvPlan && !offloadAll && layers > 0) {
    const frac = gpuLayers / layers;
    gpuKvBytes = Math.ceil(kvBytes * frac);
    cpuKvBytes = Math.max(0, kvBytes - gpuKvBytes);
  }

  // ── Compute buffers ──
  // Attention-score scratch and activations are built on whichever device runs the layers being
  // computed. With any offload at all the hot path touches the accelerator, so charge the buffer
  // there; with zero offload it belongs entirely to host RAM.
  const computeBufferBytes = input.computeBufferBytes ?? computeBufferEstimate({
    contextTokens,
    batchTokens: input.batchTokens,
    layers: Math.max(1, layers),
  });
  if (input.computeBufferBytes === undefined) {
    notes.push('compute-buffer figure is MODELLED from context/batch, not measured');
  }
  const gpuComputeBytes = gpuLayers > 0 ? computeBufferBytes : 0;
  const cpuComputeBytes = gpuLayers > 0 ? 0 : computeBufferBytes;

  const safetyMarginBytes = input.ignoreSafetyMargin ? 0 : SAFETY_MARGIN_BYTES;
  const totalBytes = gpuWeightBytes + cpuWeightBytes + kvBytes + computeBufferBytes + safetyMarginBytes;

  // ── Two pools, not one ──
  // On unified memory (Apple Silicon, APUs) CPU and GPU share an address space, so there is a
  // single ceiling and `totalBytes` is the right thing to compare against it.
  // On a DISCRETE GPU they are physically separate: VRAM holds the offloaded weights, their KV,
  // the compute buffers and the runtime margin — while host RAM holds the rest. Counting
  // CPU-resident weights against VRAM would wrongly declare partial offload impossible, which is
  // exactly the configuration that makes a 70B servable on a 24 GB card.
  const unified = device.unified === true;
  let gpuPoolBytes: number;
  let gpuPoolAvailableBytes: number;
  let cpuPoolBytes: number | undefined;
  let cpuPoolAvailableBytes: number | undefined;

  if (unified) {
    gpuPoolBytes = totalBytes;
    gpuPoolAvailableBytes = deviceAvailableBytes;
    cpuPoolBytes = undefined;
    cpuPoolAvailableBytes = undefined;
    notes.push('unified memory: CPU and GPU share one pool, so there is no offload trade-off to tune');
  } else {
    gpuPoolBytes = gpuWeightBytes + gpuKvBytes + gpuComputeBytes + safetyMarginBytes;
    gpuPoolAvailableBytes = deviceAvailableBytes;
    cpuPoolBytes = cpuWeightBytes + cpuKvBytes + cpuComputeBytes;
    cpuPoolAvailableBytes = device.systemRamBytes;
    if (cpuPoolBytes > 0 && device.systemRamBytes === undefined) {
      warnings.push(
        'this placement puts ' +
          `${formatGib(cpuPoolBytes)} in host RAM but the device reports no systemRamBytes, ` +
          'so the host side of the fit is UNCHECKED — supply system RAM to complete the verdict',
      );
    }
  }

  const headroomBytes = deviceAvailableBytes - totalBytes;
  const gpuHeadroomBytes = gpuPoolAvailableBytes - gpuPoolBytes;
  const cpuHeadroomBytes =
    cpuPoolBytes === undefined || cpuPoolAvailableBytes === undefined
      ? undefined
      : cpuPoolAvailableBytes - cpuPoolBytes;

  // MEASURED = the weight bytes we got from real tensor extents. Everything else is modelled.
  const measuredBytes = weightMeasured ? geometry.weightBytes : 0;
  const modelledBytes = Math.max(0, totalBytes - measuredBytes);
  const modelledShare = totalBytes > 0 ? modelledBytes / totalBytes : 1;

  // ── Verdict ──
  // A verdict is only as good as its TIGHTEST pool, so each pool is judged separately and the worst
  // result wins. An unchecked host-RAM pool cannot silently make the answer "fits".
  const judge = (headroom: number, available: number): FitVerdict => {
    if (headroom < 0) return 'does-not-fit';
    // `tight` is the honest middle ground: it fits, but fragmentation or a longer prompt than
    // planned could push it over. Reporting that as plain "fits" would be overconfident.
    if (headroom < Math.max(SAFETY_MARGIN_BYTES, available * 0.1)) return 'tight';
    return 'fits';
  };
  const RANK: Record<FitVerdict, number> = {
    'does-not-fit': 0, unchecked: 1, tight: 2, fits: 3,
  };
  let verdict = judge(gpuHeadroomBytes, gpuPoolAvailableBytes);
  if (unified) {
    // Single pool: keep `headroomBytes` meaningful as the reported figure. There is no host-side
    // pool to leave unchecked, so `unchecked` is unreachable here by construction.
    verdict = judge(headroomBytes, deviceAvailableBytes);
  } else if (cpuHeadroomBytes !== undefined && cpuPoolAvailableBytes !== undefined) {
    const cpuVerdict = judge(cpuHeadroomBytes, cpuPoolAvailableBytes);
    if (RANK[cpuVerdict] < RANK[verdict]) {
      verdict = cpuVerdict;
      notes.push('host RAM is the binding constraint, not VRAM');
    }
  } else if (cpuPoolBytes !== undefined && cpuPoolBytes > 0 && device.systemRamBytes === undefined) {
    // This placement DEPENDS on host RAM that was never declared. The GPU verdict alone cannot
    // answer the question that was asked, so the answer is "we could not check", never "fits".
    // A definite GPU failure still wins: knowing it does not fit beats not knowing whether it does.
    if (RANK.unchecked < RANK[verdict]) verdict = 'unchecked';
    notes.push(
      'verdict is UNCHECKED, not a pass: host RAM was not reported, so the CPU-resident ' +
        `${formatGib(cpuPoolBytes)} was never judged`,
    );
  }

  // ── An unsized KV cache cannot support a pass verdict ──
  //
  // When `planKvCache` refuses (no layers, no head_count_kv, no derivable head_dim), `kvBytes` is
  // counted as ZERO and the total is explicitly "a lower bound". That is honest arithmetic, but a
  // lower bound cannot justify `fits`: the omitted term is usually the one that grows without limit
  // — 100k context × 8 sequences on a 70B model is tens of GiB of KV, and reporting `fits` for it
  // sends a request straight into OOM.
  //
  // This is the same failure mode as the undeclared-host-RAM case above, and the same rule from the
  // module contract applies: `unchecked` is not a pass, and a missing term is never assumed to be
  // zero. Note the asymmetry that makes this safe rather than merely pessimistic — a definite
  // `does-not-fit` is KEPT (rank 0 < 1), because the weights alone genuinely do not fit and that is
  // real knowledge, not an unknown.
  if (!kvPlan && RANK.unchecked < RANK[verdict]) {
    verdict = 'unchecked';
    notes.push(
      'verdict is UNCHECKED, not a pass: the KV cache could not be sized (no layers, no ' +
        'head_count_kv, no derivable head_dim), so the context/concurrency cost was counted as zero. ' +
        'Declare the geometry or point `path` at the GGUF to get a real verdict.',
    );
  }

  if (geometry.expertCount && geometry.expertCount > 0) {
    notes.push(`MoE with ${geometry.expertCount} experts: all expert weights stay resident`);
  }

  // ── Headroom → the largest context / concurrency that would fit ──
  //
  // Solved by BOUNDED BINARY SEARCH against `estimateCapacity` itself, not by dividing a budget by
  // the KV-per-token cost. The closed-form solve is wrong: it assumes KV is the only term that
  // grows with context, but `computeBufferEstimate` grows with it too (attention-score scratch is
  // batch × ctx). A closed-form answer therefore over-promises and hands back a context length that
  // this very function would then judge `does-not-fit` — a self-contradictory result. Using the
  // real judge as the oracle makes the returned value self-consistent by construction, at the cost
  // of ~40 pure arithmetic evaluations.
  //
  // Solved against the BINDING pool, since on a discrete GPU with partial offload the accelerator
  // is what fills first and answering from `totalBytes` would be wrong.
  const searchMax = (
    lo: number,
    hi: number,
    fits: (candidate: number) => boolean,
  ): { value: number; bounded: boolean } => {
    if (!fits(lo)) return { value: Math.max(0, lo - 1), bounded: false };
    // `hi` is a SEARCH BOUND, not a discovered ceiling. Reporting it bare is how a caller ends up
    // believing "max context = 65536" when 131072 would have fit fine and the search simply never
    // looked past its own cap — an under-report that reads as an exact answer. Flag it instead so
    // the caller can say "at least N", and widen the bound if the number is actually load-bearing.
    if (fits(hi)) return { value: hi, bounded: true };
    let best = lo;
    // Invariant: fits(best) is true, fits(hi) is false. ~40 halvings covers the full u32 range.
    for (let i = 0; i < 40 && hi - lo > 1; i += 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(mid)) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return { value: best, bounded: false };
  };

  let maxContextTokens: number | undefined;
  let maxSequences: number | undefined;
  let maxContextTokensBounded: boolean | undefined;
  let maxSequencesBounded: boolean | undefined;
  if (kvPlan && !input.internalNoHeadroomSearch) {
    // Every probe sets `internalNoHeadroomSearch` so the search cannot recurse into itself.
    const probeBase = { ...input, internalNoHeadroomSearch: true };

    // A candidate fits only if EVERY declared pool has room. An undeclared host-RAM pool
    // (`cpuHeadroomBytes === undefined`) is not a pass or a fail — it is unchecked, and the caller
    // already got a warning about it, so it must not block the search.
    const poolsFit = (probe: CapacityEstimate): boolean =>
      probe.gpuHeadroomBytes >= 0 && (probe.cpuHeadroomBytes === undefined || probe.cpuHeadroomBytes >= 0);

    const fitsCtx = (candidate: number): boolean =>
      poolsFit(estimateCapacity({ ...probeBase, contextTokens: candidate }));

    // Upper bound: the largest context whose KV alone could possibly fit in the binding pool. This
    // is generous (it ignores weights and buffers) and only bounds the search.
    const kvOnlyCeiling = kvPlan.bytesPerToken > 0
      ? Math.ceil(gpuPoolAvailableBytes / kvPlan.bytesPerToken / Math.max(1, sequences)) + 1
      : contextTokens;
    const ctxSolved = searchMax(1, Math.max(1, Math.min(kvOnlyCeiling, contextTokens * 64)), fitsCtx);
    maxContextTokens = ctxSolved.value;
    maxContextTokensBounded = ctxSolved.bounded;
    const fitsSeq = (candidate: number): boolean =>
      poolsFit(estimateCapacity({ ...probeBase, sequences: candidate }));

    // Concurrency is bounded by the pool too: one sequence at full context is the unit of cost.
    const seqCeiling = kvPlan.bytesPerSequence > 0 && contextTokens > 0
      ? Math.ceil(gpuPoolAvailableBytes / (kvPlan.bytesPerToken * contextTokens)) + 1
      : Math.max(1, sequences);
    const seqSolved = searchMax(1, Math.max(1, Math.min(seqCeiling, Math.max(sequences, 4096))), fitsSeq);
    maxSequences = seqSolved.value;
    maxSequencesBounded = seqSolved.bounded;
  }

  return {
    device,
    deviceAvailableBytes,
    weightBytes: geometry.weightBytes,
    gpuWeightBytes,
    cpuWeightBytes,
    gpuLayers,
    offloadAll,
    kvBytes,
    gpuKvBytes,
    cpuKvBytes,
    kvPlan,
    computeBufferBytes,
    safetyMarginBytes,
    totalBytes,
    headroomBytes,
    gpuPoolBytes,
    gpuPoolAvailableBytes,
    gpuHeadroomBytes,
    cpuPoolBytes,
    cpuPoolAvailableBytes,
    cpuHeadroomBytes,
    verdict,
    measuredBytes,
    modelledBytes,
    modelledShare,
    notes,
    warnings,
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(maxSequences !== undefined ? { maxSequences } : {}),
    ...(maxContextTokensBounded ? { maxContextTokensBounded: true } : {}),
    ...(maxSequencesBounded ? { maxSequencesBounded: true } : {}),
  };
}

// ── Quantization comparison ──────────────────────────────────────────────────

export interface QuantOption {
  dtype: KvDtype | string;
  bitsPerWeight: number;
  weightBytes: number;
  totalBytes: number;
  /** Bytes the BINDING pool must hold — VRAM on a discrete GPU, the shared pool on unified. */
  bindingPoolBytes: number;
  fits: boolean;
  verdict: FitVerdict;
  /** Headroom in the binding pool. Negative means it does not fit. */
  headroomBytes: number;
  /** Bytes saved vs the f16 reference, when one is present. */
  savedVsF16?: number;
}

/**
 * Compare quantizations of the same parameter count against a device.
 *
 * Useful for the real decision — "which of these four files can I actually serve here" — and it
 * uses the SAME `estimateCapacity` path as the single-model verdict, so the numbers cannot drift
 * apart from the one-off answer.
 */
export function compareQuantizations(input: {
  device: CapacityDevice;
  parameters: number;
  contextTokens: number;
  sequences?: number;
  kvDtype?: KvDtype;
  /** ggml type names or ids to compare. Defaults to the usual ladder. */
  dtypes?: string[];
  geometry: ModelGeometry;
}): { options: QuantOption[]; warnings: string[] } {
  const warnings: string[] = [];
  const dtypes = input.dtypes?.length
    ? input.dtypes
    : ['Q2_K', 'Q3_K_M', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16'];
  const f16Bpw = GGML_TYPES[1].bitsPerWeight; // 16

  const options: QuantOption[] = [];
  for (const name of dtypes) {
    const id = ggmlTypeByName(name);
    // Q3_K_M/Q4_K_M/Q5_K_M are file_type LABELS, not ggml tensor types; map them to their dominant
    // tensor type so the arithmetic still works, and note that the label is approximate.
    const labelFallback: Record<string, string> = {
      Q3_K_M: 'Q3_K', Q4_K_M: 'Q4_K', Q5_K_M: 'Q5_K',
      Q3_K_S: 'Q3_K', Q4_K_S: 'Q4_K', Q5_K_S: 'Q5_K', Q2_K_S: 'Q2_K',
    };
    const resolved = id ?? ggmlTypeByName(labelFallback[name] ?? name);
    if (resolved === undefined) {
      warnings.push(`"${name}" is not a ggml type this reader knows; skipped`);
      continue;
    }
    const info = GGML_TYPES[resolved];
    const weightBytes = Math.ceil((info.bitsPerWeight / 8) * input.parameters);
    const est = estimateCapacity({
      device: input.device,
      geometry: { ...input.geometry, weightBytes },
      contextTokens: input.contextTokens,
      sequences: input.sequences,
      kvDtype: input.kvDtype,
    });
    // Report against the pool that actually binds. On a discrete GPU that is VRAM; on unified
    // memory it is the single shared pool, where gpuPoolBytes === totalBytes.
    const bindingPoolBytes = est.gpuPoolBytes;
    options.push({
      dtype: name,
      bitsPerWeight: info.bitsPerWeight,
      weightBytes,
      totalBytes: est.totalBytes,
      bindingPoolBytes,
      // Fail closed: `fits` is a claim, and an unchecked pool cannot support one. Only a measured
      // pass — comfortable or tight — counts.
      fits: est.verdict === 'fits' || est.verdict === 'tight',
      verdict: est.verdict,
      headroomBytes: est.gpuHeadroomBytes,
    });
    if (info.bitsPerWeight === f16Bpw && name.toUpperCase() !== 'F16') {
      warnings.push(`"${name}" resolves to ${info.name} at 16 bpw, same as F16 — check the name`);
    }
  }

  const f16 = options.find((o) => o.dtype.toUpperCase() === 'F16');
  if (f16) {
    for (const o of options) o.savedVsF16 = f16.weightBytes - o.weightBytes;
  } else {
    warnings.push('no F16 reference in the comparison, so savings are not computed');
  }

  options.sort((a, b) => a.bitsPerWeight - b.bitsPerWeight);
  return { options, warnings };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function gib(bytes: number, digits = 2): string {
  return `${(bytes / GIB).toFixed(digits)} GiB`;
}

/** Same as `gib`, used in warnings where the unit label is part of the sentence. */
function formatGib(bytes: number): string {
  return gib(bytes);
}

/** A short human verdict line, for CLI output and receipts. */
export function summarizeCapacity(est: CapacityEstimate): string {
  const parts = [`${est.verdict.toUpperCase()}`];
  // On a discrete GPU the accelerator pool is the binding constraint and the only figure that
  // predicts an OOM, so lead with it. Unified memory has one pool, so report that instead.
  if (est.cpuPoolBytes !== undefined) {
    parts.push(`vram ${gib(est.gpuPoolBytes)}/${gib(est.gpuPoolAvailableBytes)}`);
    if (est.cpuHeadroomBytes !== undefined) parts.push(`ram ${gib(est.cpuPoolBytes!)}`);
  } else {
    parts.push(`need ${gib(est.totalBytes)}`, `have ${gib(est.deviceAvailableBytes)}`);
  }
  if (est.kvPlan) parts.push(`kv ${gib(est.kvBytes)} @ ${est.kvPlan.contextTokens} tok × ${est.kvPlan.sequences}`);
  parts.push(`modelled ${(est.modelledShare * 100).toFixed(0)}%`);
  // This one-liner is what lands in receipts and CLI output, so an UNCHECKED verdict has to carry
  // its caveat with it rather than relying on the caller to also print `warnings`.
  if (est.verdict === 'unchecked') parts.push('host RAM not reported — fit UNCHECKED, not a pass');
  return parts.join('  ·  ');
}

// ── GGUF → geometry bridge ───────────────────────────────────────────────────

/**
 * Turn a parsed GGUF into the geometry `estimateCapacity` needs.
 *
 * This is the one place where measured and declared facts can disagree, so it encodes which wins:
 *
 *  - **Layer count prefers the TENSOR scan** (`observedBlockCount`, derived from real `blk.N.*`
 *    names) over the declared `block_count`. The tensors are what actually get loaded; a stale or
 *    wrong metadata key should not change the offload arithmetic. A disagreement is reported, not
 *    hidden, because it usually means a hand-repacked or mis-converted file.
 *  - **`kvHeads` is never defaulted from `headCount`.** On a GQA model that substitution inflates
 *    the KV cache by the group ratio (4x is typical) and will make a servable model look
 *    impossible. When the file does not declare it, the field stays undefined and `planKvCache`
 *    refuses — which is the honest answer.
 *  - **`weightBytes` is the sum of tensor extents**, i.e. bytes actually on disk, not a figure
 *    derived from parameter count x nominal bit width.
 */
export function geometryFromGguf(meta: GgufMeta): {
  geometry: ModelGeometry;
  warnings: string[];
  notes: string[];
} {
  const warnings: string[] = [];
  const notes: string[] = [];
  const t = meta.tensors;
  const arch = meta.arch;

  const observed = t.observedBlockCount > 0 ? t.observedBlockCount : undefined;
  const declared = arch.blockCount !== undefined && arch.blockCount > 0 ? arch.blockCount : undefined;
  if (observed !== undefined && declared !== undefined && observed !== declared) {
    // Not fatal, but loud: the two counts disagreeing means the file's metadata does not describe
    // the tensors it contains, and every downstream layer-fraction figure inherits that doubt.
    warnings.push(
      `declared block_count=${declared} disagrees with the tensor scan (${observed} blk.* layers); ` +
        'using the TENSOR SCAN, because those are the layers that actually load',
    );
  }
  const layers = observed ?? declared;

  // head_dim: `rope_dimension_count` is explicit and authoritative. planKvCache can otherwise derive
  // it from embedding_length/head_count, and warns if that derivation is fractional.
  const headDim =
    arch.ropeDimensionCount !== undefined && arch.ropeDimensionCount > 0 ? arch.ropeDimensionCount : undefined;

  if (arch.headCountKv === undefined && arch.headCount !== undefined) {
    warnings.push(
      `file declares ${arch.headCount} attention heads but no head_count_kv; KV cache cannot be ` +
        'sized without the GROUP size, and guessing it from the head count overstates the cache ' +
        'on a GQA model. Pass contextTokens and accept the refusal, or supply kvHeads explicitly.',
    );
  }

  if (layers === undefined) {
    warnings.push('neither the tensor scan nor block_count yielded a layer count');
  }
  if (t.blockBytes > 0 && t.nonBlockBytes > 0) {
    notes.push(
      `${(t.nonBlockBytes / GIB).toFixed(2)} GiB stays resident at any -ngl ` +
        '(embeddings/output head), so partial offload cannot shrink below that',
    );
  }

  const geometry: ModelGeometry = {
    layers,
    kvHeads: arch.headCountKv,
    headDim,
    embeddingLength: arch.embeddingLength,
    headCount: arch.headCount,
    weightBytes: t.totalBytes,
    blockBytes: t.blockBytes > 0 ? t.blockBytes : undefined,
    nonBlockBytes: t.nonBlockBytes > 0 ? t.nonBlockBytes : undefined,
    bytesPerLayer: t.bytesPerLayer,
    observedBlockCount: observed,
    expertCount: arch.expertCount,
    expertUsedCount: arch.expertUsedCount,
  };

  return { geometry, warnings, notes };
}
