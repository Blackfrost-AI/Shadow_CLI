/**
 * infer_capacity — answer "does it fit, on what, at what context".
 *
 * Wraps the shared capacity math (`src/inference/capacity.ts`) behind a deferred tool so a
 * deployment can be sized from a GGUF file or from declared parameters + geometry. It never
 * executes anything: this is arithmetic over a parsed header and a probed device, so it is
 * read-risk and safe to run before committing to a serve.
 *
 * Boundaries a reviewer should check, in order:
 *
 *  - **Provenance is not decoration.** A verdict that silently blends measured tensor extents with
 *    guessed KV geometry is how people OOM a node. Every figure group in the output carries
 *    MEASURED / DECLARED / DERIVED / MODELLED, and `modelledShare` says how much of the total is a
 *    model rather than a measurement.
 *  - **`unchecked` is never a pass.** When a pool cannot be judged — most often host RAM on a
 *    discrete GPU with partial offload — the estimator says `unchecked` and this tool forwards that
 *    verdict verbatim instead of rounding it into "fits".
 *  - **KV is refused, not guessed.** Missing layers or `head_count_kv` yields no KV plan. With GQA,
 *    substituting query heads overstates the cache by up to 8× (Llama-3-70B: 64 query, 8 KV), so a
 *    refusal is the only honest answer.
 *  - **Host facts are not model-controllable.** The probe runner and CPU arch come from ToolContext,
 *    never the input schema, so a model cannot invent a 192 GB H100 and then "pass" a check on it.
 *  - **An explicit `device` is labelled DECLARED.** Probing is measured truth and is the default;
 *    overriding it is a claim, and the output says which one it got.
 */
import { z } from 'zod';
import { GgufError, parseGgufMeta, summarizeGgufMeta } from '../inference/ggufMeta.js';
import {
  availableBytes,
  compareQuantizations,
  estimateCapacity,
  geometryFromGguf,
  type CapacityDevice,
  type KvDtype,
  type ModelGeometry,
} from '../inference/capacity.js';
import { inventoryAccelerators, type ProbeRunner } from '../inference/gpu.js';
import { clamp } from './util.js';
import { fail, ok, type Tool, type ToolResult } from './types.js';

const NAME = 'infer_capacity';
const MAX_OUTPUT_CHARS = 24_000;
const MAX_WARNINGS = 40;
const MAX_NOTES = 20;
const GIB = 1024 ** 3;

/** Provenance tags. A number without one of these is a number nobody should trust. */
type Provenance = 'MEASURED' | 'DECLARED' | 'DERIVED' | 'MODELLED';

const KV_DTYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0'] as const;

/** Attach a provenance tag to a group of figures so the reader can weight them. */
function tagged<T extends object>(group: T, prov: Provenance): T & { provenance: Provenance } {
  return { ...group, provenance: prov };
}

function gib(bytes: number, digits = 2): string {
  return `${(bytes / GIB).toFixed(digits)} GiB`;
}

function positiveInt(min: number) {
  return z.number().int().min(min);
}

const schema = z
  .object({
    action: z
      .enum(['estimate', 'max-context', 'max-sequences', 'compare-quants'])
      .describe(
        "'estimate' = full fit verdict (and the solved ceilings when KV is known). " +
          "'max-context' / 'max-sequences' = emphasise that solved ceiling in the summary. " +
          "'compare-quants' = ladder of quantizations of one parameter count against this device.",
      ),
    path: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        'GGUF checkpoint to size. Preferred: weights and geometry are then MEASURED from real tensor ' +
          'extents. Omit to size from declared parameters instead (weaker provenance).',
      ),
    // ── Device. Mirrors CapacityDevice exactly; omitted means "probe the host". ──
    device: z
      .object({
        totalMemoryBytes: z
          .number()
          .positive()
          .describe('Usable device memory in bytes: VRAM on a discrete card, the shared pool on unified memory.'),
        unified: z.boolean().optional().describe('True when CPU and GPU share one address space (Apple Silicon, APU).'),
        reservedBytes: z.number().nonnegative().optional().describe('Bytes the OS has wired/reserved and cannot hand to the model.'),
        systemRamBytes: z
          .number()
          .positive()
          .optional()
          .describe(
            'Host RAM for the CPU-resident part of a PARTIAL offload. Only meaningful when unified=false. ' +
              'Without it the CPU pool cannot be judged and the verdict is `unchecked`, not `fits`.',
          ),
        label: z.string().max(200).optional().describe('Human label for receipts.'),
      })
      .strict()
      .optional()
      .describe(
        'Device to size against. Omit to probe the host (preferred — that is measured truth). Set it ' +
          'explicitly only to plan for hardware you are not sitting on; the result is labelled DECLARED.',
      ),
    deviceIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('When the probe finds several devices, size against this index. Default: the one with most available memory.'),
    probe: z
      .boolean()
      .optional()
      .describe('Probe the host for a device when `device` is omitted (default true). Set false to force an explicit device.'),
    // ── Declared sizing, used when `path` is absent ──
    parameters: z.number().positive().optional().describe('Parameter count, e.g. 7e9. Used to model weightBytes when no path is given.'),
    bitsPerWeight: z.number().positive().max(32).optional().describe('Assumed density for parameters→bytes (default 4.5 ≈ Q4_K_M).'),
    weightBytes: z.number().positive().optional().describe('Explicit on-disk weight footprint. Wins over parameters×bitsPerWeight.'),
    layers: z.number().int().positive().optional().describe('Transformer layers, for KV sizing without a path.'),
    kvHeads: z.number().int().positive().optional().describe('KV heads (attention.head_count_kv) — NOT query heads.'),
    headDim: z.number().int().positive().optional().describe('Per-head dimension. Derived from embeddingLength/headCount when omitted.'),
    embeddingLength: z.number().int().positive().optional().describe('Model hidden size, used to derive headDim.'),
    heads: z.number().int().positive().optional().describe('Query heads. Used ONLY to derive headDim, never for KV sizing.'),
    // ── Placement and workload ──
    gpuLayers: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Layers to offload to the accelerator (-ngl). Omit to let the estimator place what fits.'),
    contextTokens: positiveInt(1).optional().describe('Context length per sequence (default 4096).'),
    sequences: positiveInt(1).optional().describe('Concurrent sequences (default 1).'),
    kvDtype: z.enum(KV_DTYPES).optional().describe('KV cache dtype (default f16). q8_0/q4_0 halve/quarter the cache.'),
    computeBufferBytes: z.number().nonnegative().optional().describe('Override the modelled scratch/compute buffer figure with a measured one.'),
    batchTokens: z.number().int().positive().optional().describe('Prompt-batch size feeding the compute-buffer model.'),
    ignoreSafetyMargin: z.boolean().optional().describe('For theoretical-ceiling questions only: drop the reserved margin.'),
    // ── compare-quants ──
    dtypes: z
      .array(z.string().min(1).max(32))
      .max(32)
      .optional()
      .describe('For compare-quants: ggml type names to compare. Defaults to the usual Q2_K…F16 ladder.'),
  })
  .strict();

export type InferCapacityInput = z.infer<typeof schema>;

export const inferCapacity: Tool<InferCapacityInput> = {
  name: NAME,
  description: [
    'Size a self-hosted inference deployment: does it FIT, on which device, at what context length and',
    'concurrency. Pure arithmetic over a parsed GGUF header plus a probed accelerator — it never loads',
    'or runs a model, so it is safe before you commit to a serve. Answers "will 70B fit on 24GB with',
    'offload", "what is my max context here", "how many concurrent sequences", and "which of these',
    'quants can I actually serve". Every figure is tagged MEASURED/DECLARED/DERIVED/MODELLED and the',
    'verdict fails closed: an unjudgeable pool returns `unchecked`, never `fits`.',
    'NOT a speed or latency tool: it computes MEMORY ceilings only and never measures or models how',
    'fast a model generates — for throughput you need a real benchmark run, not arithmetic.',
    'Run infer_recon first when you do not yet know the hardware or the geometry.',
  ].join(' '),
  risk: 'read',
  deferred: true,
  searchAliases: [
    'capacity',
    'will it fit',
    'fits',
    'fit',
    'sizing',
    'size',
    'vram',
    'memory',
    'kv cache',
    'kv',
    'context length',
    'max context',
    'concurrency',
    'sequences',
    'concurrent users',
    'how many concurrent users can i serve',
    'how many users can i serve',
    'how many concurrent requests',
    'offload',
    'ngl',
    'gpu layers',
    'partial offload',
    'quantization',
    'quant',
    'compare quants',
    'which quant',
    'should i use q4 or q8',
    'q2',
    'q3',
    'q4',
    'q5',
    'q6',
    'q8',
    'q2_k',
    'q3_k_m',
    'q4_k_m',
    'q5_k_m',
    'q6_k',
    'q8_0',
    'f16',
    'headroom',
    'footprint',
    'model size',
    'ram',
    'how much ram do i need',
    'how much memory do i need',
    'memory requirements',
    'gpu memory requirements',
    'deployment planning',
    // NOTE: no throughput/tokens-per-second alias here, on purpose. This tool computes MEMORY
    // ceilings — whether the weights, KV cache and buffers fit. It does not measure or model speed,
    // so advertising it for "estimate tokens per second" would make tool_search promise a capability
    // the tool cannot deliver. Throughput needs infer_bench (not yet built).
    'oom',
    'out of memory',
    'local',
    'run locally',
    'can i run this locally',
    'locally',
    'inference capacity',
    'infer capacity',
    'gguf size',
  ],
  inputSchema: schema,

  async run(input, ctx): Promise<ToolResult<unknown>> {
    const start = Date.now();
    const action = input.action;
    const elapsed = () => Date.now() - start;

    try {
      // ── Device: a measured host probe, or an explicitly DECLARED one. ──
      const resolved = resolveDevice(input, ctx);
      if ('error' in resolved) return fail(NAME, 'read', elapsed(), resolved.code, resolved.message);
      const { device, deviceProvenance, inventory } = resolved;

      // ── Geometry + parameter count: MEASURED from a GGUF when given, else DECLARED. ──
      const roots = [ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])];
      let geometry: ModelGeometry;
      let parameters: number | undefined;
      let geomProvenance: Provenance;
      let identity: string | undefined;
      let ggufSummary: string | undefined;
      let resolvedPath: string | undefined;
      const geomWarnings: string[] = [];
      const geomNotes: string[] = [];

      if (input.path) {
        let meta;
        try {
          meta = parseGgufMeta({ path: input.path, roots, captureExtra: true });
        } catch (err) {
          // Same boundary rule as infer_recon: a model in ~/.cache/huggingface is the EXPECTED
          // refusal, and the fix is a flag, not a quiet escape from the jail.
          if (err instanceof GgufError && err.code === 'invalid_path') {
            return fail(
              NAME,
              'read',
              elapsed(),
              'outside_workspace',
              `Model path is outside the workspace jail: ${err.message}. Models usually live in ` +
                '~/.cache/huggingface or ~/models. Grant access with --add-dir <dir> and retry.',
            );
          }
          if (err instanceof GgufError) {
            return fail(NAME, 'read', elapsed(), `gguf_${err.code}`, `${input.path}: ${err.message}`);
          }
          throw err;
        }
        const bridge = geometryFromGguf(meta);
        geometry = bridge.geometry;
        parameters = meta.tensors.totalParameters;
        geomProvenance = 'MEASURED';
        identity = meta.identity;
        resolvedPath = meta.resolvedPath;
        ggufSummary = summarizeGgufMeta(meta);
        geomWarnings.push(...bridge.warnings);
        geomNotes.push(...bridge.notes);
      } else {
        const declared = declaredGeometry(input, action);
        if ('error' in declared) return fail(NAME, 'read', elapsed(), declared.code, declared.message);
        geometry = declared.geometry;
        parameters = declared.parameters;
        geomProvenance = declared.provenance;
        geomWarnings.push(...declared.warnings);
      }

      const contextTokens = Math.max(1, Math.floor(input.contextTokens ?? 4096));
      const sequences = Math.max(1, Math.floor(input.sequences ?? 1));
      const kvDtype: KvDtype = input.kvDtype ?? 'f16';
      const probeWarnings = inventory?.warnings ?? [];

      // ── compare-quants branches off: it needs a parameter count, not one placement. ──
      //
      // Checked BEFORE geometry resolution on purpose. compare-quants never needs `weightBytes` —
      // the ladder derives each rung's weight from the parameter count — so falling through to
      // declaredGeometry() first would reject the call as `needs_weights`, an error naming a field
      // this action does not use. Misleading errors cost more time than missing ones.
      if (action === 'compare-quants') {
        if (parameters === undefined || parameters <= 0) {
          return fail(
            NAME,
            'read',
            elapsed(),
            'compare_needs_parameters',
            'compare-quants needs a parameter count — pass `path` (measured) or `parameters` (declared).',
          );
        }
        const cmp = compareQuantizations({ device, parameters, contextTokens, sequences, kvDtype, dtypes: input.dtypes, geometry });
        const kvUnsized = cmp.options.every((o) => o.verdict === 'unchecked');
        const payload = {
          action: 'compare-quants' as const,
          device: deviceOut(device, deviceProvenance),
          parameters: tagged({ parameters }, geomProvenance),
          contextTokens,
          sequences,
          kvDtype,
          options: cmp.options.map((o) => ({
            dtype: o.dtype,
            bitsPerWeight: o.bitsPerWeight,
            weightBytes: o.weightBytes,
            weight: gib(o.weightBytes),
            totalBytes: o.totalBytes,
            total: gib(o.totalBytes),
            bindingPoolBytes: o.bindingPoolBytes,
            bindingPool: gib(o.bindingPoolBytes),
            fits: o.fits,
            verdict: o.verdict,
            headroomBytes: o.headroomBytes,
            headroom: gib(o.headroomBytes),
            ...(o.savedVsF16 !== undefined ? { savedVsF16Bytes: o.savedVsF16, savedVsF16: gib(o.savedVsF16) } : {}),
          })),
          // The actionable line: which of these can actually be served here.
          servable: cmp.options.filter((o) => o.fits).map((o) => String(o.dtype)),
          identity,
          resolvedPath,
          ggufSummary,
          // When KV could not be sized every rung is `unchecked` and `servable` is empty. That is
          // correct — an unsized KV cost cannot support a pass — but the RANKING survives: KV is
          // identical across rungs (same context, sequences, dtype), so the ordering by weight is
          // still the right answer to "which is smallest that I could try first". Say so instead of
          // letting an all-empty ladder read as "none of these will ever work".
          ...(kvUnsized
            ? {
                rankingStillValid: true,
                rankingCaveat:
                  'No rung could be judged a pass: the KV cache is unsized, so every verdict is ' +
                  '`unchecked`. The ORDER below is still correct (KV cost is identical across rungs), ' +
                  'but pass `path` or declare layers+kvHeads to learn which of these actually fit.',
              }
            : {}),
          warnings: [...geomWarnings, ...cmp.warnings, ...probeWarnings].slice(0, MAX_WARNINGS),
        };
        return ok(
          NAME,
          'read',
          elapsed(),
          clamp(JSON.stringify(summarizeQuants(payload, device)), MAX_OUTPUT_CHARS),
          payload,
        );
      }

      // ── estimate / max-context / max-sequences share one estimator call. ──
      // maxContextTokens and maxSequences are solved INSIDE estimateCapacity by a bounded binary
      // search whose judge is the same estimator (every probe sets internalNoHeadroomSearch so it
      // cannot recurse). The action therefore only steers the summary, never the arithmetic — two
      // actions cannot produce two different answers for the same inputs.
      const est = estimateCapacity({
        device,
        geometry,
        contextTokens,
        sequences,
        kvDtype,
        ...(input.gpuLayers !== undefined ? { gpuLayers: input.gpuLayers } : {}),
        ...(input.computeBufferBytes !== undefined ? { computeBufferBytes: input.computeBufferBytes } : {}),
        ...(input.batchTokens !== undefined ? { batchTokens: input.batchTokens } : {}),
        ...(input.ignoreSafetyMargin === true ? { ignoreSafetyMargin: true } : {}),
      });

      const payload = {
        action,
        verdict: est.verdict,
        device: deviceOut(device, deviceProvenance, est.deviceAvailableBytes),
        geometry: tagged(stripUndef(geometry), geomProvenance),
        weights: tagged(
          {
            totalBytes: est.weightBytes,
            total: gib(est.weightBytes),
            gpuBytes: est.gpuWeightBytes,
            cpuBytes: est.cpuWeightBytes,
            gpuLayers: est.gpuLayers,
            offloadAll: est.offloadAll,
          },
          geomProvenance === 'MEASURED' ? 'MEASURED' : 'MODELLED',
        ),
        kv: {
          sized: est.kvPlan !== undefined,
          bytes: est.kvBytes,
          total: gib(est.kvBytes),
          gpuBytes: est.gpuKvBytes,
          cpuBytes: est.cpuKvBytes,
          contextTokens,
          sequences,
          dtype: kvDtype,
          // The plan's own inputs, so a wrong headDimSource is visible rather than buried.
          ...(est.kvPlan
            ? {
                plan: tagged(
                  {
                    bytesPerSequence: est.kvPlan.bytesPerSequence,
                    bytesPerToken: est.kvPlan.bytesPerToken,
                    layers: est.kvPlan.layers,
                    kvHeads: est.kvPlan.kvHeads,
                    headDim: est.kvPlan.headDim,
                    headDimSource: est.kvPlan.headDimSource,
                  },
                  est.kvPlan.headDimSource === 'explicit' ? 'MEASURED' : 'DERIVED',
                ),
              }
            : {}),
          ...(est.kvPlan?.warnings.length ? { warnings: est.kvPlan.warnings.slice(0, MAX_WARNINGS) } : {}),
          provenance: 'MODELLED' as Provenance,
        },
        // Kept separate from `totals` because these are the numbers that decide the verdict, and
        // conflating "what the process holds" with "what each pool must hold" is how a partial
        // offload gets misjudged.
        pools: {
          gpuPoolBytes: est.gpuPoolBytes,
          gpuPool: gib(est.gpuPoolBytes),
          gpuPoolAvailableBytes: est.gpuPoolAvailableBytes,
          gpuPoolAvailable: gib(est.gpuPoolAvailableBytes),
          gpuHeadroomBytes: est.gpuHeadroomBytes,
          gpuHeadroom: gib(est.gpuHeadroomBytes),
          ...(est.cpuPoolBytes !== undefined ? { cpuPoolBytes: est.cpuPoolBytes, cpuPool: gib(est.cpuPoolBytes) } : {}),
          ...(est.cpuPoolAvailableBytes !== undefined
            ? { cpuPoolAvailableBytes: est.cpuPoolAvailableBytes, cpuPoolAvailable: gib(est.cpuPoolAvailableBytes) }
            : {}),
          ...(est.cpuHeadroomBytes !== undefined
            ? { cpuHeadroomBytes: est.cpuHeadroomBytes, cpuHeadroom: gib(est.cpuHeadroomBytes) }
            : {}),
        },
        totals: tagged(
          {
            computeBufferBytes: est.computeBufferBytes,
            safetyMarginBytes: est.safetyMarginBytes,
            totalBytes: est.totalBytes,
            total: gib(est.totalBytes),
            headroomBytes: est.headroomBytes,
            headroom: gib(est.headroomBytes),
            measuredBytes: est.measuredBytes,
            modelledBytes: est.modelledBytes,
            modelledShare: est.modelledShare,
          },
          'MODELLED',
        ),
        solved: {
          maxContextTokens: est.maxContextTokens ?? null,
          maxSequences: est.maxSequences ?? null,
          // A bound is a FLOOR ("at least N"), not a maximum. Reporting the number alone would let a
          // caller plan to exactly it and then under-serve by 2x or more.
          maxContextTokensBounded: est.maxContextTokensBounded === true,
          maxSequencesBounded: est.maxSequencesBounded === true,
        },
        identity,
        resolvedPath,
        ggufSummary,
        notes: [...geomNotes, ...est.notes].slice(0, MAX_NOTES),
        warnings: [...geomWarnings, ...est.warnings, ...probeWarnings].slice(0, MAX_WARNINGS),
      };

      return ok(NAME, 'read', elapsed(), clamp(JSON.stringify(summarizeEstimate(payload, action)), MAX_OUTPUT_CHARS), payload);
    } catch (e) {
      if (e instanceof GgufError) return fail(NAME, 'read', elapsed(), `gguf_${e.code}`, e.message);
      return fail(NAME, 'read', elapsed(), 'capacity_failed', e instanceof Error ? e.message : String(e));
    }
  },
};

// ── Device resolution ────────────────────────────────────────────────────────

type DeviceResolution =
  | { device: CapacityDevice; deviceProvenance: Provenance; inventory?: ReturnType<typeof inventoryAccelerators> }
  | { error: true; code: string; message: string };

/**
 * Resolve the device to size against.
 *
 * An explicit `device` is a DECLARED claim and is labelled as such. A host probe is MEASURED truth
 * and is the default. The probe runner and CPU arch come from ToolContext, never from the input
 * schema: letting model-supplied arguments drive them would let a model invent a GPU it does not
 * have and then "pass" a capacity check against it.
 */
function resolveDevice(
  input: InferCapacityInput,
  ctx: { inferProbeRunner?: unknown; inferArch?: string; inferPlatform?: NodeJS.Platform },
): DeviceResolution {
  if (input.device) {
    const d = input.device;
    return {
      device: {
        totalMemoryBytes: d.totalMemoryBytes,
        ...(d.unified !== undefined ? { unified: d.unified } : {}),
        ...(d.reservedBytes !== undefined ? { reservedBytes: d.reservedBytes } : {}),
        ...(d.systemRamBytes !== undefined ? { systemRamBytes: d.systemRamBytes } : {}),
        label: d.label ?? 'declared device',
      },
      deviceProvenance: 'DECLARED',
    };
  }

  if (input.probe === false) {
    return {
      error: true,
      code: 'no_device',
      message: 'No `device` given and probing is disabled. Pass a `device`, or leave `probe` enabled.',
    };
  }

  const inv = inventoryAccelerators({
    ...(ctx.inferPlatform ? { platform: ctx.inferPlatform } : {}),
    ...(ctx.inferArch ? { arch: ctx.inferArch } : {}),
    ...(ctx.inferProbeRunner ? { runner: ctx.inferProbeRunner as ProbeRunner } : {}),
  });

  if (inv.devices.length === 0) {
    return {
      error: true,
      code: 'no_device',
      message:
        'The host probe found no sizable device — no accelerator and no usable host-memory pool. ' +
        'Pass an explicit `device` to size against hardware you are not sitting on.',
    };
  }

  // Default to the device with the most AVAILABLE memory, which is the question people actually ask
  // ("can I serve this here"), not the one with the largest nameplate.
  const device =
    input.deviceIndex !== undefined && input.deviceIndex < inv.devices.length
      ? inv.devices[input.deviceIndex]
      : inv.devices.reduce((best, cur) => (availableBytes(cur) > availableBytes(best) ? cur : best), inv.devices[0]);

  return { device, deviceProvenance: 'MEASURED', inventory: inv };
}

// ── Declared geometry ────────────────────────────────────────────────────────

type DeclaredGeometry =
  | { geometry: ModelGeometry; parameters?: number; provenance: Provenance; warnings: string[] }
  | { error: true; code: string; message: string };

/**
 * Build a ModelGeometry from declared inputs when no GGUF path is given. Weaker provenance.
 *
 * `action` matters because the weight requirement differs. `estimate` needs a real footprint, but
 * `compare-quants` does NOT: that path derives a weightBytes per rung from the parameter count and
 * overrides whatever is passed (`{ ...input.geometry, weightBytes }` in compareQuantizations).
 * Requiring weightBytes there would reject a perfectly answerable question with an error naming a
 * field the action ignores.
 */
function declaredGeometry(input: InferCapacityInput, action: string): DeclaredGeometry {
  const warnings: string[] = [];
  let weightBytes = input.weightBytes;
  let provenance: Provenance = 'DECLARED';

  if (weightBytes === undefined) {
    if (input.parameters !== undefined) {
      const bpw = input.bitsPerWeight ?? 4.5;
      weightBytes = Math.round((input.parameters * bpw) / 8);
      provenance = 'MODELLED';
      if (action !== 'compare-quants') {
        warnings.push(
          `weightBytes MODELLED as parameters(${input.parameters.toExponential(3)}) × ${bpw} bpw / 8 = ${gib(weightBytes)}. ` +
            'Point `path` at the actual GGUF for a MEASURED footprint.',
        );
      }
    }
  }

  if (weightBytes === undefined) {
    if (action === 'compare-quants') {
      // compareQuantizations replaces this per rung; the value is never read. 0 is honest here in a
      // way a fabricated estimate would not be, because nothing downstream can mistake it for real.
      weightBytes = 0;
      provenance = 'DERIVED';
    } else {
      return {
        error: true,
        code: 'needs_weights',
        message:
          'Cannot size weights without a file: pass `path` (a GGUF, measured), or `weightBytes`, ' +
          'or `parameters` (with optional `bitsPerWeight`, modelled).',
      };
    }
  }

  const geometry: ModelGeometry = {
    weightBytes,
    ...(input.layers !== undefined ? { layers: input.layers } : {}),
    ...(input.kvHeads !== undefined ? { kvHeads: input.kvHeads } : {}),
    ...(input.headDim !== undefined ? { headDim: input.headDim } : {}),
    ...(input.embeddingLength !== undefined ? { embeddingLength: input.embeddingLength } : {}),
    ...(input.heads !== undefined ? { headCount: input.heads } : {}),
  };

  if (geometry.layers === undefined || geometry.kvHeads === undefined) {
    warnings.push(
      'layers and/or kvHeads are not declared, so the KV cache cannot be sized. The verdict will be ' +
        '`unchecked` rather than `fits` — declare them, or pass `path` so they are measured.',
    );
  }
  if (input.heads !== undefined && input.kvHeads === undefined) {
    warnings.push(
      '`heads` (query heads) was given but `kvHeads` was not. Query heads are NEVER substituted for KV ' +
        'heads: on a GQA model that overstates the cache by up to 8×.',
    );
  }

  return { geometry, ...(input.parameters !== undefined ? { parameters: input.parameters } : {}), provenance, warnings };
}

// ── Output shaping ───────────────────────────────────────────────────────────

function stripUndef<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

function deviceOut(device: CapacityDevice, provenance: Provenance, available?: number) {
  return {
    label: device.label ?? 'device',
    totalMemoryBytes: device.totalMemoryBytes,
    total: gib(device.totalMemoryBytes),
    availableBytes: available ?? availableBytes(device),
    available: gib(available ?? availableBytes(device)),
    unified: device.unified ?? false,
    ...(device.reservedBytes !== undefined ? { reservedBytes: device.reservedBytes } : {}),
    ...(device.systemRamBytes !== undefined ? { systemRamBytes: device.systemRamBytes } : {}),
    provenance,
  };
}

type EstimatePayload = {
  verdict: string;
  device: { label: string };
  weights: { total: string };
  kv: { sized: boolean; total: string };
  pools: { gpuPool: string; gpuPoolAvailable: string };
  solved: {
    maxContextTokens: number | null;
    maxSequences: number | null;
    maxContextTokensBounded: boolean;
    maxSequencesBounded: boolean;
  };
  warnings: string[];
};

/** One-line human summary. The verdict leads, because that is the answer to the question asked. */
function summarizeEstimate(p: EstimatePayload, action: string): Record<string, unknown> {
  const line = `${p.verdict} on ${p.device.label} — weights ${p.weights.total}, GPU pool ${p.pools.gpuPool} of ${p.pools.gpuPoolAvailable}`;
  const out: Record<string, unknown> = { verdict: p.verdict, summary: line };
  if (action === 'max-context') {
    out.summary =
      p.solved.maxContextTokens === null
        ? `${line}; max context UNSOLVED (KV geometry unknown)`
        : p.solved.maxContextTokensBounded
          ? `${line}; max context ≥ ${p.solved.maxContextTokens.toLocaleString('en-US')} tokens (search bound — the real ceiling is higher)`
          : `${line}; max context ≈ ${p.solved.maxContextTokens.toLocaleString('en-US')} tokens`;
  } else if (action === 'max-sequences') {
    out.summary =
      p.solved.maxSequences === null
        ? `${line}; max sequences UNSOLVED (KV geometry unknown)`
        : p.solved.maxSequencesBounded
          ? `${line}; max sequences ≥ ${p.solved.maxSequences.toLocaleString('en-US')} (search bound — the real ceiling is higher)`
          : `${line}; max sequences ≈ ${p.solved.maxSequences.toLocaleString('en-US')}`;
  }
  if (!p.kv.sized) out.kvUnsized = 'KV cache not sized — geometry insufficient; verdict cannot be a clean pass';
  if (p.solved.maxContextTokensBounded || p.solved.maxSequencesBounded) {
    out.boundedCeiling = 'a solved ceiling hit the search bound, so it is a floor ("at least N"), not a maximum';
  }
  if (p.warnings.length) out.warnings = p.warnings.slice(0, 5);
  return out;
}

type QuantPayload = { options: Array<{ dtype: string; fits: boolean }> };

function summarizeQuants(p: QuantPayload, device: CapacityDevice): Record<string, unknown> {
  const servable = p.options.filter((o) => o.fits).map((o) => o.dtype);
  return {
    summary:
      servable.length === 0
        ? `No quantization of this parameter count fits ${device.label ?? 'the device'}`
        : `${servable.length}/${p.options.length} quantizations fit ${device.label ?? 'the device'}: ${servable.join(', ')}`,
    servable,
  };
}
