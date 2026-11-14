/**
 * infer_recon — read-only reconnaissance for self-hosted inference.
 *
 * Answers the two questions that precede every serving decision:
 *   1. **What hardware am I on?** (`action: 'host'`) — accelerators, VRAM, host RAM, and a
 *      `CapacityDevice[]` that `infer_capacity` consumes directly.
 *   2. **What is in this checkpoint?** (`action: 'model'`) — GGUF header, metadata, architecture and
 *      a tensor summary separating the bytes `-ngl` can actually move from the bytes that stay
 *      resident regardless.
 *
 * Boundaries a reviewer should check, in order:
 *
 *  - **It never slurps the model.** GGUF checkpoints run 4–140 GiB. `parseGgufMeta` reads through a
 *    file descriptor with bounded, bounds-checked reads, so peak memory here is kilobytes regardless
 *    of file size. Contrast `bin_recon`, which may `readFileSync` because it caps at 512 MiB —
 *    copying that pattern here would OOM the agent on the first real checkpoint.
 *  - **It stays inside the workspace jail.** `parseGgufMeta` is handed the same `[workspaceRoot,
 *    ...additionalRoots]` the file tools use and resolves the path itself. Models usually live
 *    OUTSIDE the workspace (`~/.cache/huggingface`, `~/models`), so the common outcome is a clear
 *    `outside_workspace` error naming the flag that grants access — never a silent bypass of a
 *    documented boundary.
 *  - **It executes nothing.** No server starts, no model loads, no inference runs. The only child
 *    processes are vendor SMI probes, which get `scrubbedEnv()` and `shell: false`.
 *  - **Host facts are not model-controllable.** The probe runner and CPU architecture come from
 *    ToolContext, not the input schema, so a model cannot invent a GPU and then pass a capacity
 *    check against it.
 *  - **Unknown stays unknown.** A GPU whose VRAM cannot be read is reported without a figure rather
 *    than sized by guesswork, and every probe records status, argv, exit code and duration so a
 *    receipt shows what actually ran.
 */
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { GgufError, parseGgufMeta, summarizeGgufMeta, type GgufMeta } from '../inference/ggufMeta.js';
import { inventoryAccelerators, summarizeInventory, type ProbeRunner } from '../inference/gpu.js';
import { geometryFromGguf } from '../inference/capacity.js';
import { clamp } from './util.js';
import { fail, ok, type Tool, type ToolResult } from './types.js';

/** Output cap. A full by-type breakdown for a mixed-precision MoE would otherwise crowd out the rest. */
const MAX_OUTPUT_CHARS = 24_000;
const MAX_METADATA_KEYS = 400;
const MAX_WARNINGS = 40;

// There is deliberately no file-size cap here. `parseGgufMeta` streams through a file descriptor and
// bounds its own work (tensor count, metadata KV count, per-key length), so peak memory is kilobytes
// for a 4 GiB file and a 140 GiB file alike. A size cap would only reject legitimate checkpoints.

const GIB = 1024 ** 3;

function gib(bytes: number, digits = 2): string {
  return `${(bytes / GIB).toFixed(digits)} GiB`;
}

/**
 * Map a typed `GgufError.code` onto a tool failure code plus the hint that makes it actionable.
 *
 * The parser already distinguishes these cases; collapsing them into one generic `parse_failed`
 * would throw away exactly the information the user needs to fix the problem.
 */
function ggufFailure(code: GgufError['code'], message: string, requested: string): { code: string; message: string } {
  switch (code) {
    case 'not_found':
      return { code: 'not_found', message: `No such file: ${requested}. ${message}` };
    case 'unreadable':
      return { code: 'unreadable', message: `Permission denied reading ${requested}: ${message}` };
    case 'not_a_file':
      return { code: 'not_a_file', message: `${requested} is not a regular file (directory, device, or socket).` };
    case 'too_large':
      return { code: 'too_large', message: `${requested} exceeds the size cap: ${message}` };
    case 'bad_magic':
      return {
        code: 'not_a_gguf',
        message:
          `${requested} is not a GGUF checkpoint — the magic bytes were not "GGUF". ${message} ` +
          'safetensors and .bin files are not supported by this tool. If this is a split checkpoint ' +
          '(…-00001-of-00003.gguf), point at the FIRST part.',
      };
    case 'unsupported_version':
      return {
        code: 'unsupported_gguf_version',
        message: `${requested}: ${message} — this reader handles GGUF v1–v3.`,
      };
    case 'truncated':
      return {
        code: 'truncated',
        message:
          `${requested} is truncated or the download did not complete: ${message} ` +
          'Re-download the file; a partial checkpoint cannot be inspected safely.',
      };
    case 'corrupt':
      return { code: 'corrupt', message: `${requested}: ${message}` };
    case 'invalid_path':
      return { code: 'invalid_path', message: `Rejected path ${requested}: ${message}` };
    default:
      return { code: 'parse_failed', message: `${requested}: ${message}` };
  }
}

const schema = z
  .object({
    action: z
      .enum(['host', 'model'])
      .describe(
        "'host' = inventory this machine's accelerators and memory (no path needed). " +
          "'model' = inspect a GGUF checkpoint's header, metadata, architecture and tensors.",
      ),
    path: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('Path to a GGUF file. Required for action=model, ignored for action=host.'),
  })
  .strict();

export type InferReconInput = z.infer<typeof schema>;

export const inferRecon: Tool<InferReconInput> = {
  name: 'infer_recon',
  description: [
    'READ-ONLY reconnaissance for self-hosted inference: inventory the host accelerators, or inspect',
    'a GGUF checkpoint. It never starts a server, loads a model, or runs inference, and it never reads',
    'the whole file — parsing streams through a file descriptor, so a 140 GiB checkpoint costs',
    'kilobytes of memory. Use this BEFORE infer_capacity: recon establishes what hardware and what',
    'geometry you have, capacity decides whether it fits. For "does model X fit my GPU" you want both.',
    'Read-only; never mutates anything.',
  ].join(' '),
  risk: 'read',
  deferred: true,
  searchAliases: [
    'inference',
    'infer',
    'llm',
    'gpu',
    'vram',
    'gguf',
    'model file',
    'checkpoint',
    'quantization',
    'nvidia-smi',
    'rocm-smi',
    'accelerator',
    'self-host',
    'selfhost',
    'ollama',
    'llama.cpp',
    'vllm',
    'what gpu do i have',
    'how big is this model',
    'inspect model',
    'model metadata',
    'tensor',
    'offload',
    'ngl',
  ],
  inputSchema: schema,
  async run(input, ctx): Promise<ToolResult<unknown>> {
    const start = Date.now();

    // ── action: host ──
    if (input.action === 'host') {
      const inv = inventoryAccelerators({
        ...(ctx.inferPlatform ? { platform: ctx.inferPlatform } : {}),
        ...(ctx.inferArch ? { arch: ctx.inferArch } : {}),
        ...(ctx.inferProbeRunner ? { runner: ctx.inferProbeRunner as ProbeRunner } : {}),
      });
      const payload = {
        action: 'host' as const,
        platform: inv.platform,
        osRelease: inv.osRelease,
        summary: summarizeInventory(inv),
        gpus: inv.gpus,
        hostMemory: inv.hostMemory,
        // Already the shape infer_capacity wants — hand it over unchanged.
        capacityDevices: inv.devices,
        probes: inv.probes,
        warnings: inv.warnings.slice(0, MAX_WARNINGS),
        notes: inv.notes,
        durationMs: inv.durationMs,
      };
      return ok('infer_recon', 'read', Date.now() - start, clamp(JSON.stringify(payload), MAX_OUTPUT_CHARS), payload);
    }

    // ── action: model ──
    if (!input.path) {
      return fail('infer_recon', 'read', Date.now() - start, 'missing_path', 'action=model requires `path`.');
    }
    const requested = isAbsolute(input.path) ? input.path : resolve(ctx.workspaceRoot, input.path);

    let meta: GgufMeta;
    try {
      // parseGgufMeta resolves within the roots itself and streams via fd; peak memory is
      // independent of file size.
      meta = parseGgufMeta({
        path: input.path,
        roots: [ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])],
        captureExtra: true,
      });
    } catch (err) {
      // A path outside the jail is the EXPECTED failure for a model in ~/.cache/huggingface. Report
      // what to do about it rather than quietly escaping the boundary to read it anyway.
      if (err instanceof GgufError && err.code === 'invalid_path') {
        return fail(
          'infer_recon',
          'read',
          Date.now() - start,
          'outside_workspace',
          `Model path is outside the workspace jail: ${err.message}. Models usually live in ` +
            '~/.cache/huggingface or ~/models. Grant access with --add-dir <dir> (or run with that ' +
            `directory as the workspace) and retry. Requested: ${requested}`,
        );
      }
      if (err instanceof GgufError) {
        const mapped = ggufFailure(err.code, err.message, requested);
        return fail('infer_recon', 'read', Date.now() - start, mapped.code, mapped.message);
      }
      return fail(
        'infer_recon',
        'read',
        Date.now() - start,
        'parse_failed',
        `Could not inspect ${requested}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const bridge = geometryFromGguf(meta);
    // `extra` is the scalar metadata outside the promoted arch keys; `arrays` reports element COUNTS
    // only (the 150k-string vocab is walked but never captured — the count is what is diagnostic).
    const metaEntries = Object.entries(meta.extra);
    const metaRows = metaEntries.slice(0, MAX_METADATA_KEYS).map(([key, value]) => ({ key, value }));
    const arrayRows = Object.entries(meta.arrays).map(([key, count]) => ({ key, count }));
    const warnings = [...meta.warnings, ...bridge.warnings];

    const payload = {
      action: 'model' as const,
      path: meta.path,
      resolvedPath: meta.resolvedPath,
      fileSizeBytes: meta.fileSize,
      fileSize: gib(meta.fileSize),
      // One-line human summary, e.g. "name arch=llama params=8.03B weights=4.58 GiB 4.56 bpw measured".
      summary: summarizeGgufMeta(meta),
      header: {
        identity: meta.identity,
        version: meta.version,
        alignment: meta.alignment,
        metadataCount: meta.metadataCount,
        dataStart: meta.dataStart,
        tensorCount: meta.tensors.tensorCount,
      },
      identity: {
        architecture: meta.architecture,
        name: meta.name,
        fileType: meta.fileType,
        fileTypeLabel: meta.fileTypeLabel,
      },
      architecture: meta.arch,
      tensors: {
        tensorCount: meta.tensors.tensorCount,
        totalParameters: meta.tensors.totalParameters,
        totalBytes: meta.tensors.totalBytes,
        total: gib(meta.tensors.totalBytes),
        // Ground-truth density. Trust this over `fileTypeLabel`, which describes how the file was
        // REQUANTIZED and can disagree with what is actually stored.
        measuredBitsPerWeight: meta.tensors.measuredBitsPerWeight ?? null,
        blockBytes: meta.tensors.blockBytes,
        block: gib(meta.tensors.blockBytes),
        nonBlockBytes: meta.tensors.nonBlockBytes,
        nonBlock: gib(meta.tensors.nonBlockBytes),
        bytesPerLayer: meta.tensors.bytesPerLayer ?? null,
        observedBlockCount: meta.tensors.observedBlockCount,
        largest: meta.tensors.largest ?? null,
        byType: meta.tensors.byType,
      },
      // The bridge output is what infer_capacity consumes. Keeping it here means the two tools
      // cannot disagree about how a GGUF maps onto geometry.
      geometry: bridge.geometry,
      geometryNotes: bridge.notes,
      // Free-text provenance the file declares, surfaced separately because it is what you quote when
      // you need to know where a checkpoint came from before serving it.
      provenance: {
        author: meta.author,
        url: meta.url,
        license: meta.license,
        description: meta.description,
        tokenizerModel: meta.tokenizerModel,
        quantizationVersion: meta.quantizationVersion,
      },
      metadata: metaRows,
      metadataTruncated: metaEntries.length > metaRows.length,
      /** Array-valued metadata as element counts (vocab + scores). Never contents. */
      arrayMetadata: arrayRows,
      warnings: warnings.slice(0, MAX_WARNINGS),
    };

    return ok('infer_recon', 'read', Date.now() - start, clamp(JSON.stringify(payload), MAX_OUTPUT_CHARS), payload);
  },
};
