/**
 * GGUF container metadata — read the model file's own header instead of trusting a filename.
 *
 * Why this exists: `src/gguf.ts` LAUNCHES servers and parses what they report over HTTP
 * (`contextValue`, `detectServerContextWindow`). It never opens the model file. So before a server
 * is running — the moment you are deciding whether a model FITS on a device — Shadow knew nothing
 * about the model beyond its path and its size on disk. This module closes that: a pure, read-only
 * cursor over the GGUF container that yields architecture, layer/head geometry, context length,
 * and an EXACT tensor inventory.
 *
 * Two facts here are ground truth rather than lookup-table guesses, and they matter:
 *  - `totalParameters` is summed from the tensor dimension products, so a 70B model reports as the
 *    number of weights it actually contains — not what its name claims.
 *  - `measuredBitsPerWeight` is `totalBytes * 8 / totalParameters` from the real quantized extents,
 *    so a hand-made mix (Q4_K weights, Q6_K attention, F16 output) reports its true density. A
 *    `file_type` enum cannot express a mix; this can.
 *
 * Safety shape (deliberate, and load-bearing):
 *  - READ-ONLY. Opens with 'r'; there is no write path in this module.
 *  - CURSOR, not a load. A GGUF is routinely 1–100 GiB; nothing here buffers the tensor DATA.
 *    Only the header/KV/tensor-info region is walked, through a 1 MiB sliding chunk cache.
 *  - MAGIC-FIRST. `GGUF` is verified before any other byte is interpreted, and a non-GGUF file
 *    yields a typed `GgufError` carrying NO file content. That is what makes it safe for this
 *    module to open a path outside the workspace jail: it is a GGUF reader, not a file reader, so
 *    it cannot be pointed at `~/.ssh/id_rsa` to exfiltrate it.
 *  - BOUNDED. Every count read from the file is checked against a hard cap and against the real
 *    file size before it is used to advance the cursor. A corrupt or hostile header that claims
 *    2^60 tensors is refused, not followed.
 *
 * Format reference: GGUF v2/v3 — magic, u32 version, u64 tensor_count, u64 metadata_kv_count,
 * then KV pairs, then tensor infos (name, u32 n_dims, u64 dims[], u32 type, u64 offset), then
 * padding to `general.alignment` (default 32), then tensor data. v1 used u32 counts and is
 * refused here: it predates every model in circulation and guessing at it would be a lie.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { resolveWithin } from '../safety/workspaceJail.js';

// ── Bounds ───────────────────────────────────────────────────────────────────
// Generous enough for real models (a large MoE has a few thousand tensors and ~150k vocab
// entries), small enough that a corrupt count cannot make us walk forever.
const MAX_METADATA_KV = 4_000_000;
const MAX_TENSOR_INFOS = 2_000_000;
const MAX_ARRAY_ELEMENTS = 4_000_000;
const MAX_DIMS = 8;
/** Longest string we will COPY out. Longer values (a giant prompt template) are skipped. */
const MAX_CAPTURED_STRING = 64 * 1024;
/** Longest key we accept; a longer one means the cursor has desynchronised — refuse. */
const MAX_KEY_BYTES = 4 * 1024;
const CHUNK = 1 << 20; // 1 MiB sliding window for the header walk
/** Bytes hashed for a cheap, stable file identity used in benchmark receipts. */
const IDENTITY_BYTES = 1 << 20;

export class GgufError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'not_a_file'
      | 'unreadable'
      | 'bad_magic'
      | 'unsupported_version'
      | 'truncated'
      | 'corrupt'
      | 'too_large'
      | 'invalid_path',
    message: string,
  ) {
    super(message);
    this.name = 'GgufError';
  }
}

// ── ggml type table ──────────────────────────────────────────────────────────
/**
 * Block size (weights per quant block) and bytes per block, per ggml type.
 *
 * bits-per-weight falls out as `bytesPerBlock * 8 / blockSize`, which reproduces the figures
 * llama.cpp itself prints (Q4_K → 4.5, Q5_K → 5.5, Q6_K → 6.5625, Q2_K → 2.625, Q3_K → 3.4375,
 * IQ2_XXS → 2.0625). The struct sizes behind these: block_q2_K = 16 scales + 64 qs + 2 d + 2 dmin
 * = 84; block_q3_K = 32 hmask + 64 qs + 12 scales + 2 d = 110; block_q4_K = 2 + 2 + 12 + 128 = 144;
 * block_q5_K = 2 + 2 + 12 + 32 + 128 = 176; block_q6_K = 128 ql + 64 qh + 16 scales + 2 d = 210.
 */
export interface GgmlTypeInfo {
  name: string;
  blockSize: number;
  bytesPerBlock: number;
  /** Bytes per weight, derived. Authoritative for sizing math. */
  bitsPerWeight: number;
}

// Every entry below is DERIVED, not recalled, from llama.cpp's own source:
//   - ids + names: `enum ggml_type` in ggml/include/ggml.h
//   - blck_size:   `type_traits[]` in ggml/src/ggml.c
//   - type_size:   the `static_assert(sizeof(block_X) == ...)` beside each struct in
//                  ggml/src/ggml-common.h, with QK_K=256, K_SCALE_SIZE=12, IQ3S_N_SCALE=QK_K/64.
// ids 4, 5 (Q4_2, Q4_3) and 31-33, 36-38 are removed from GGUF support upstream, so they are
// absent here and surface as an unknown-type warning rather than a silent zero.
// NOTE: 15 (Q8_K) is 292 bytes and 17 (IQ2_XS) is 74 — the widely-quoted 260/70 are wrong and
// would understate a model's footprint.
const RAW_TYPES: Record<number, [name: string, blockSize: number, bytesPerBlock: number]> = {
  0: ['F32', 1, 4],
  1: ['F16', 1, 2],
  2: ['Q4_0', 32, 18],
  3: ['Q4_1', 32, 20],
  6: ['Q5_0', 32, 22],
  7: ['Q5_1', 32, 24],
  8: ['Q8_0', 32, 34],
  9: ['Q8_1', 32, 36],
  10: ['Q2_K', 256, 84],
  11: ['Q3_K', 256, 110],
  12: ['Q4_K', 256, 144],
  13: ['Q5_K', 256, 176],
  14: ['Q6_K', 256, 210],
  15: ['Q8_K', 256, 292], // 4 + QK_K + QK_K/16*2
  16: ['IQ2_XXS', 256, 66],
  17: ['IQ2_XS', 256, 74], // 2 + QK_K/8*2 + QK_K/32
  18: ['IQ3_XXS', 256, 98],
  19: ['IQ1_S', 256, 50],
  20: ['IQ4_NL', 32, 18],
  21: ['IQ3_S', 256, 110],
  22: ['IQ2_S', 256, 82],
  23: ['IQ4_XS', 256, 136],
  24: ['I8', 1, 1],
  25: ['I16', 1, 2],
  26: ['I32', 1, 4],
  27: ['I64', 1, 8],
  28: ['F64', 1, 8],
  29: ['IQ1_M', 256, 56],
  30: ['BF16', 1, 2],
  34: ['TQ1_0', 256, 54],
  35: ['TQ2_0', 256, 66],
  39: ['MXFP4', 32, 17], // 1 + QK_MXFP4/2
  40: ['NVFP4', 64, 36], // QK_NVFP4/QK_NVFP4_SUB + QK_NVFP4/2 = 4 + 32
  41: ['Q1_0', 128, 18],
  42: ['Q2_0', 64, 18],
};

export const GGML_TYPES: Record<number, GgmlTypeInfo> = Object.fromEntries(
  Object.entries(RAW_TYPES).map(([id, [name, blockSize, bytesPerBlock]]) => [
    Number(id),
    { name, blockSize, bytesPerBlock, bitsPerWeight: (bytesPerBlock * 8) / blockSize },
  ]),
);

/**
 /** Bytes occupied by `ne` weights of `typeId`.
  *
  * Rounds UP to a whole quant block. In a valid file `ne` is always a multiple of `blck_size`, so
  * this equals ggml's own `type_size * ne / blck_size`. For a malformed one it over-reports rather
  * than under-reports, which is the direction a fit check must err in: a partial block still
  * occupies a whole block in memory.
  */
 export function ggmlRowBytes(typeId: number, ne: number): number | undefined {
   const t = GGML_TYPES[typeId];
   if (!t) return undefined;
   if (!Number.isFinite(ne) || ne < 0) return undefined;
   return Math.ceil(ne / t.blockSize) * t.bytesPerBlock;
 }

 /** Reverse lookup: `"Q4_K"` → `12`, `"f16"` → `1`. Case-insensitive. */
 export function ggmlTypeByName(name: string): number | undefined {
   const want = name.trim().toUpperCase();
   for (const [id, info] of Object.entries(GGML_TYPES)) {
     if (info.name === want) return Number(id);
   }
   return undefined;
 }

 /**
  * Bytes per SINGLE element of a ggml type — the right unit for a KV cache, where what matters is
  * the cost of one K or V scalar rather than a block of weights.
  *
  * This is why the type table doubles as the KV dtype table: llama.cpp's `-ctk`/`-ctv` accept the
  * same names (`f16`, `bf16`, `q8_0`, `q4_0`), and the densities are the ones ggml actually uses —
  * f16 → 2, q8_0 → 1.0625, q4_0 → 0.5625. One table, no second source to drift.
  */
 export function ggmlBytesPerElement(typeId: number): number | undefined {
   const t = GGML_TYPES[typeId];
   return t ? t.bytesPerBlock / t.blockSize : undefined;
 }

 /** Resolve a KV cache dtype by name (`"f16"`, `"q8_0"`) to bytes per element. */
 export function kvBytesPerElement(name: string): number | undefined {
   const id = ggmlTypeByName(name);
   return id === undefined ? undefined : ggmlBytesPerElement(id);
 }

/**
 * `general.file_type` → the quantization label a user recognises (llama_ftype enum).
 *
 * Presented as DECLARED, never as measured: MoE and mixed-precision files routinely carry a
 * file_type that does not describe their dominant weight type. `measuredBitsPerWeight` is the
 * number to trust; this is the human-readable name that usually goes with it.
 */
export const GGUF_FILE_TYPE_LABELS: Record<number, string> = {
  0: 'ALL_F32',
  1: 'MOSTLY_F16',
  2: 'MOSTLY_Q4_0',
  3: 'MOSTLY_Q4_1',
  4: 'MOSTLY_Q4_1_SOME_F16',
  7: 'MOSTLY_Q8_0',
  8: 'MOSTLY_Q5_0',
  9: 'MOSTLY_Q5_1',
  10: 'MOSTLY_Q2_K',
  11: 'MOSTLY_Q3_K_S',
  12: 'MOSTLY_Q3_K_M',
  13: 'MOSTLY_Q3_K_L',
  14: 'MOSTLY_Q4_K_S',
  15: 'MOSTLY_Q4_K_M',
  16: 'MOSTLY_Q5_K_S',
  17: 'MOSTLY_Q5_K_M',
  18: 'MOSTLY_Q6_K',
  19: 'MOSTLY_IQ2_XXS',
  20: 'MOSTLY_IQ2_XS',
  21: 'MOSTLY_Q2_K_S',
  22: 'MOSTLY_IQ3_XS',
  23: 'MOSTLY_IQ3_XXS',
  24: 'MOSTLY_IQ1_S',
  25: 'MOSTLY_IQ4_NL',
  26: 'MOSTLY_IQ3_S',
  27: 'MOSTLY_IQ2_S',
  28: 'MOSTLY_IQ4_XS',
  29: 'MOSTLY_IQ1_M',
  30: 'MOSTLY_BF16',
};

// ── Metadata value types ─────────────────────────────────────────────────────
const V_UINT8 = 0;
const V_INT8 = 1;
const V_UINT16 = 2;
const V_INT16 = 3;
const V_UINT32 = 4;
const V_INT32 = 5;
const V_FLOAT32 = 6;
const V_BOOL = 7;
const V_STRING = 8;
const V_ARRAY = 9;
const V_UINT64 = 10;
const V_INT64 = 11;
const V_FLOAT64 = 12;

type MetaValue = number | boolean | string;

/** Sentinel: a value we deliberately walked past without capturing. */
const SKIP = Symbol('skip');

/**
 * A positioned cursor over the file with a 1 MiB sliding chunk cache.
 *
 * The header walk is sequential but touches millions of small values (a 150k-entry vocab array),
 * so one positioned read per value would be thousands of syscalls. The cache makes that one read
 * per megabyte. Spans that cross a chunk boundary, or that exceed a chunk, are read exactly —
 * never by loading the tensor data.
 */
class Cursor {
  private buf = Buffer.alloc(0);
  private bufStart = -1;
  pos = 0;

  constructor(
    private readonly fd: number,
    readonly fileSize: number,
    private readonly chunkSize = CHUNK,
  ) {}

  /** Guarantee `n` readable bytes at `pos`, or throw `truncated`. */
  private ensure(n: number): Buffer {
    if (n <= 0) throw new GgufError('corrupt', `non-positive read length ${n} at offset ${this.pos}`);
    if (this.pos + n > this.fileSize) {
      throw new GgufError(
        'truncated',
        `header claims ${n} bytes at offset ${this.pos}, but the file is only ${this.fileSize} bytes`,
      );
    }
    const cached = this.pos >= this.bufStart && this.pos + n <= this.bufStart + this.buf.length;
    if (cached) return this.buf.subarray(this.pos - this.bufStart, this.pos - this.bufStart + n);
    const want = Math.min(this.chunkSize, this.fileSize - this.pos);
    if (n > want) {
      // Bigger than one chunk: read exactly what was asked for.
      const out = Buffer.alloc(n);
      this.readAt(out, this.pos, n);
      this.buf = Buffer.alloc(0);
      this.bufStart = -1;
      return out;
    }
    const chunk = Buffer.alloc(want);
    this.readAt(chunk, this.pos, want);
    this.buf = chunk;
    this.bufStart = this.pos;
    return chunk.subarray(0, n);
  }

  private readAt(target: Buffer, position: number, length: number): void {
    let done = 0;
    while (done < length) {
      // readSync can return fewer bytes than requested; loop rather than trust a short read.
      const got = readSync(this.fd, target, done, length - done, position + done);
      if (got <= 0) {
        throw new GgufError(
          'truncated',
          `read stopped at ${position + done} of ${length} requested bytes (EOF or short read)`,
        );
      }
      done += got;
    }
  }

  u8(): number {
    const v = this.ensure(1).readUInt8(0);
    this.pos += 1;
    return v;
  }
  i8(): number {
    const v = this.ensure(1).readInt8(0);
    this.pos += 1;
    return v;
  }
  u16(): number {
    const v = this.ensure(2).readUInt16LE(0);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.ensure(2).readInt16LE(0);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.ensure(4).readUInt32LE(0);
    this.pos += 4;
    return v;
  }
  i32(): number {
    const v = this.ensure(4).readInt32LE(0);
    this.pos += 4;
    return v;
  }
  f32(): number {
    const v = this.ensure(4).readFloatLE(0);
    this.pos += 4;
    return v;
  }
  f64(): number {
    const v = this.ensure(8).readDoubleLE(0);
    this.pos += 8;
    return v;
  }
  /** u64 → number. Refuses anything beyond Number.MAX_SAFE_INTEGER: a count that large is corrupt. */
  u64(what: string): number {
    const v = this.ensure(8).readBigUInt64LE(0);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GgufError('corrupt', `${what} = ${v} exceeds ${Number.MAX_SAFE_INTEGER} — header is not credible`);
    }
    return Number(v);
  }
  /** i64 → number, with the same sanity bound in both directions. */
  i64(what: string): number {
    const v = this.ensure(8).readBigInt64LE(0);
    this.pos += 8;
    const lo = BigInt(Number.MIN_SAFE_INTEGER);
    const hi = BigInt(Number.MAX_SAFE_INTEGER);
    if (v > hi || v < lo) {
      throw new GgufError('corrupt', `${what} = ${v} is outside the safe integer range — header is not credible`);
    }
    return Number(v);
  }
  bytes(n: number): Buffer {
    const out = Buffer.from(this.ensure(n));
    this.pos += n;
    return out;
  }
  /** A GGUF string: u64 byte length, then UTF-8 with no NUL terminator. */
  str(what: string, maxBytes = MAX_CAPTURED_STRING): { value: string | undefined; length: number } {
    const len = this.u64(`${what} length`);
    if (len > this.fileSize) throw new GgufError('corrupt', `${what} length ${len} exceeds the file size`);
    if (len <= maxBytes) {
      const value = this.bytes(len).toString('utf8');
      return { value, length: len };
    }
    this.skip(len);
    return { value: undefined, length: len };
  }
  /** Advance without materialising. Still bounds-checked, so a bad length is caught here. */
  skip(n: number): void {
    if (n < 0) throw new GgufError('corrupt', `negative skip ${n} at offset ${this.pos}`);
    if (this.pos + n > this.fileSize) {
      throw new GgufError('truncated', `cannot skip ${n} bytes at offset ${this.pos} — file is ${this.fileSize} bytes`);
    }
    this.pos += n;
  }
}

// ── Result shapes ────────────────────────────────────────────────────────────

/** One quantization type's share of the file. */
export interface GgufTypeShare {
  type: string;
  tensors: number;
  parameters: number;
  bytes: number;
  bitsPerWeight: number;
}

export interface GgufTensorSummary {
  tensorCount: number;
  /** Sum of dimension products across every tensor — the real weight count. */
  totalParameters: number;
  /** Sum of quantized extents — the real on-disk weight footprint, excluding padding. */
  totalBytes: number;
  /** Ground truth density. Trust this over `fileTypeLabel`. */
  measuredBitsPerWeight: number | undefined;
  /** Breakdown by ggml type, largest first. Shows a mixed-precision file for what it is. */
  byType: GgufTypeShare[];
  /**
   * Bytes inside `blk.<n>.*` tensors — the part `-ngl` moves to the GPU. Everything else
   * (token_embd, output, output_norm, and any non-blk tensors) stays resident no matter what,
   * which is why the split is reported rather than folded into one number.
   */
  blockBytes: number;
  nonBlockBytes: number;
  /** Highest `blk.<n>` index seen, +1 — the layer count implied by the tensors themselves. */
  observedBlockCount: number;
  /** blockBytes / observedBlockCount: marginal cost of offloading one more LAYER. Named `Layer`, not `Block`, because "block" already means a ggml quant block (QK_K) in this codebase. */
  bytesPerLayer: number | undefined;
  /** Largest single tensor, for spotting an unexpectedly huge embedding or expert table. */
  largest?: { name: string; bytes: number; parameters: number; type: string };
}

export interface GgufArchInfo {
  /** `<arch>.block_count` — declared layer count. Compare with `observedBlockCount`. */
  blockCount?: number;
  contextLength?: number;
  embeddingLength?: number;
  feedForwardLength?: number;
  headCount?: number;
  headCountKv?: number;
  vocabSize?: number;
  /** >0 means MoE. Capacity math needs this: experts change the active-parameter story. */
  expertCount?: number;
  expertUsedCount?: number;
  ropeDimensionCount?: number;
}

export interface GgufMeta {
  path: string;
  resolvedPath: string;
  fileSize: number;
  /** SHA-256 of the first MiB — a cheap, stable identity for receipts and drift checks. */
  identity: string;
  version: number;
  alignment: number;
  /** Offset where tensor data begins (KV + tensor infos, padded to `alignment`). */
  dataStart: number;
  metadataCount: number;
  architecture?: string;
  name?: string;
  fileType?: number;
  fileTypeLabel?: string;
  /** Author/organisation and other free-text provenance the file declares. */
  author?: string;
  url?: string;
  license?: string;
  description?: string;
  quantizationVersion?: number;
  arch: GgufArchInfo;
  tokenizerModel?: string;
  tensors: GgufTensorSummary;
  /** Other scalar metadata, for diagnostics. Keys only — never tensor data. */
  extra: Record<string, MetaValue>;
  /**
   * Array-valued metadata, reported as element COUNT rather than contents.
   *
   * Arrays are the vocab (`tokenizer.ggml.tokens` at 150k strings) and its scores. Capturing them
   * would blow the context and buy nothing, but the count is genuinely diagnostic — it confirms
   * the vocab size a tokenizer expects. Every element is still walked so the cursor lands exactly
   * on the next key.
   */
  arrays: Record<string, number>;
  /** Non-fatal oddities worth surfacing (declared vs observed disagreement, skipped values). */
  warnings: string[];
}

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a GGUF header. Read-only, cursor-based, magic-first.
 *
 * @param input.path Absolute or workspace-relative path to a `.gguf` file.
 * @param input.roots Roots the path may resolve under. Model files legitimately live outside the
 *   workspace (`~/llama.cpp/models`, the HF cache), so this defaults to "any readable absolute
 *   path" — the MAGIC check, not a jail, is what keeps this a GGUF reader and not a file reader.
 * @param input.maxTensors Stop walking tensor infos past this many. Real models are well under it;
 *   the cap is for a corrupt header.
 * @param input.captureExtra Capture scalar metadata outside the known-key whitelist.
 */
export function parseGgufMeta(input: {
  path: string;
  roots?: string[];
  maxTensors?: number;
  captureExtra?: boolean;
}): GgufMeta {
  const rawPath = input.path?.trim();
  if (!rawPath) throw new GgufError('invalid_path', 'path must be a non-empty string');
  // Enforce the jail when roots are supplied. Previously `roots` was accepted and documented as a
  // containment boundary but never used — resolvePath() is just node:path.resolve, so any caller
  // that passed roots believed it was confined while actually reading arbitrary absolute paths.
  // A documented jail that does not jail is worse than none, because callers trust it.
  //
  // resolveWithin throws a plain Error; rethrow it as a typed GgufError so callers can branch on
  // `code === 'invalid_path'` and tell "outside the jail" apart from "corrupt file".
  let resolvedPath: string;
  if (input.roots && input.roots.length > 0) {
    try {
      resolvedPath = resolveWithin(input.roots, rawPath);
    } catch (e) {
      throw new GgufError('invalid_path', e instanceof Error ? e.message : String(e));
    }
  } else {
    resolvedPath = resolvePath(rawPath);
  }
  const maxTensors = Math.min(input.maxTensors ?? MAX_TENSOR_INFOS, MAX_TENSOR_INFOS);

  let fd: number;
  try {
    // 'r' — read-only. There is deliberately no write or create path in this module.
    fd = openSync(resolvedPath, 'r');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new GgufError('not_found', `no such file: ${resolvedPath}`);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new GgufError('unreadable', `permission denied reading ${resolvedPath}`);
    }
    if (code === 'EISDIR') throw new GgufError('not_a_file', `not a file (directory): ${resolvedPath}`);
    throw new GgufError('unreadable', `cannot open ${resolvedPath}: ${(e as Error).message}`);
  }

  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new GgufError('not_a_file', `not a regular file: ${resolvedPath}`);
    const fileSize = st.size;
    if (fileSize < 32) throw new GgufError('bad_magic', `${resolvedPath} is ${fileSize} bytes — too small to be a GGUF`);

    const cur = new Cursor(fd, fileSize);

    // MAGIC FIRST. Nothing else in the file is interpreted until these four bytes agree, and the
    // failure path carries no content — so this cannot double as a way to read an arbitrary file.
    const magic = cur.bytes(4).toString('ascii');
    if (magic !== 'GGUF') {
      const shown = [...Buffer.from(magic, 'ascii')].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      throw new GgufError(
        'bad_magic',
        `${resolvedPath} is not a GGUF file (magic bytes ${shown}, expected 47 47 55 46 "GGUF")`,
      );
    }

    const version = cur.u32();
    if (version !== 2 && version !== 3) {
      throw new GgufError(
        'unsupported_version',
        `GGUF version ${version} is not supported (this reader handles v2 and v3). ` +
          (version === 1
            ? 'v1 predates current tooling — re-convert the model with an up-to-date llama.cpp.'
            : 'The file is corrupt, or newer than this reader.'),
      );
    }

    const tensorCount = cur.u64('tensor count');
    const metadataCount = cur.u64('metadata KV count');
    if (tensorCount > maxTensors) {
      throw new GgufError('too_large', `header declares ${tensorCount} tensors (cap ${maxTensors})`);
    }
    if (metadataCount > MAX_METADATA_KV) {
      throw new GgufError('too_large', `header declares ${metadataCount} metadata entries (cap ${MAX_METADATA_KV})`);
    }

    // Cheap identity: hash the first MiB, magic included. A full hash of a 40 GiB file is not a
    // metadata read. Remember where the header walk resumes and restore it explicitly —
    // recomputing the offset from field widths would silently break if the layout above changes.
    const headerEnd = cur.pos;
    cur.pos = 0;
    const identity = createHash('sha256').update(cur.bytes(Math.min(IDENTITY_BYTES, fileSize))).digest('hex');
    cur.pos = headerEnd;

    const warnings: string[] = [];
    const arch: GgufArchInfo = {};
    const extra: Record<string, MetaValue> = {};
    const arrays: Record<string, number> = {};
    let alignment = 32; // GGUF default; `general.alignment` overrides it

    // ── Metadata KV walk ──
    // Keys are `<arch>.<field>`, and <arch> is only known AFTER reading `general.architecture`.
    // Rather than two-pass the file, we remember every scalar under a 2-segment key and resolve
    // the arch-specific ones once the architecture is known.
    const scalars = new Map<string, MetaValue>();

    for (let i = 0; i < metadataCount; i += 1) {
      const { value: key, length: keyLen } = cur.str(`metadata key #${i}`, MAX_KEY_BYTES);
      if (key === undefined) throw new GgufError('corrupt', `metadata key #${i} is longer than ${MAX_KEY_BYTES} bytes`);
      if (keyLen === 0) throw new GgufError('corrupt', `metadata key #${i} is empty`);
      const valueType = cur.u32();
      const parsed = readValue(cur, valueType, key, warnings, arrays);
      if (parsed === SKIP) continue;
      scalars.set(key, parsed);
    }

    // Each of these is read exactly once, straight out of the scalar map, so they are `const`:
    // the KV walk above has already finished and nothing can reassign them.
    const architecture = asString(scalars.get('general.architecture'));
    const name = asString(scalars.get('general.name'));
    const author = asString(scalars.get('general.author'));
    const url = asString(scalars.get('general.url'));
    const license = asString(scalars.get('general.license'));
    const description = asString(scalars.get('general.description'));
    const fileType = asNumber(scalars.get('general.file_type'));
    const quantizationVersion = asNumber(scalars.get('general.quantization_version'));
    const tokenizerModel = asString(scalars.get('tokenizer.ggml.model'));
    const declaredAlignment = asNumber(scalars.get('general.alignment'));
    if (declaredAlignment !== undefined) {
      // Alignment must be a power of two to be meaningful; a bogus value would corrupt the
      // data-offset math, so keep the default and say so.
      if (declaredAlignment > 0 && (declaredAlignment & (declaredAlignment - 1)) === 0) alignment = declaredAlignment;
      else warnings.push(`general.alignment = ${declaredAlignment} is not a power of two; using the default 32`);
    }

    const prefix = architecture ? `${architecture}.` : undefined;
    const pick = (field: string): number | undefined => {
      if (!prefix) return undefined;
      return asNumber(scalars.get(`${prefix}${field}`));
    };
    arch.blockCount = pick('block_count');
    arch.contextLength = pick('context_length');
    arch.embeddingLength = pick('embedding_length');
    arch.feedForwardLength = pick('feed_forward_length');
    arch.headCount = pick('attention.head_count');
    arch.headCountKv = pick('attention.head_count_kv');
    arch.vocabSize = pick('vocab_size');
    arch.expertCount = pick('expert_count');
    arch.expertUsedCount = pick('expert_used_count');
    arch.ropeDimensionCount = pick('rope.dimension_count');

    if (input.captureExtra !== false) {
      // Only the arch keys ALREADY promoted into `arch` are excluded here. Every other
      // `<arch>.*` key (rope.scaling.factor, attention.layer_norm_rms_epsilon, expert_ffn_size, …)
      // is kept: those are the values a practitioner actually wants when a conversion looks wrong,
      // and dropping them because they share a prefix would hide exactly the interesting ones.
      const KNOWN = new Set([
        'general.architecture', 'general.name', 'general.author', 'general.url', 'general.license',
        'general.description', 'general.file_type', 'general.quantization_version', 'general.alignment',
        'tokenizer.ggml.model',
      ]);
      const PROMOTED = new Set([
        'block_count', 'context_length', 'embedding_length', 'feed_forward_length',
        'attention.head_count', 'attention.head_count_kv', 'vocab_size',
        'expert_count', 'expert_used_count', 'rope.dimension_count',
      ]);
      for (const [k, v] of scalars) {
        if (KNOWN.has(k)) continue;
        if (prefix && k.startsWith(prefix) && PROMOTED.has(k.slice(prefix.length))) continue;
        // Per-key caps so one odd value cannot dominate the payload.
        if (typeof v === 'string' && v.length > 512) continue;
        extra[k] = v;
        if (Object.keys(extra).length >= 200) {
          warnings.push('extra metadata truncated at 200 keys');
          break;
        }
      }
    }
    // ── Tensor info walk ──
    const byType = new Map<number, { name: string; tensors: number; parameters: number; bytes: number; bits: number }>();
    let totalParameters = 0;
    let totalBytes = 0;
    let blockBytes = 0;
    let nonBlockBytes = 0;
    let observedBlockCount = 0;
    let largest: GgufTensorSummary['largest'];
    let unknownTypeCount = 0;

    for (let i = 0; i < tensorCount; i += 1) {
      const { value: tname } = cur.str(`tensor #${i} name`, MAX_KEY_BYTES);
      const tnameSafe = tname ?? `<tensor ${i}>`;
      const nDims = cur.u32();
      if (nDims === 0 || nDims > MAX_DIMS) {
        throw new GgufError('corrupt', `tensor "${tnameSafe}" declares ${nDims} dimensions (expected 1..${MAX_DIMS})`);
      }
      let ne = 1;
      for (let d = 0; d < nDims; d += 1) {
        const dim = cur.u64(`tensor "${tnameSafe}" dim ${d}`);
        if (dim === 0) throw new GgufError('corrupt', `tensor "${tnameSafe}" has a zero-length dimension`);
        ne *= dim;
        if (!Number.isFinite(ne)) throw new GgufError('corrupt', `tensor "${tnameSafe}" dimension product overflowed`);
      }
      const typeId = cur.u32();
      // The offset is relative to `dataStart`, not absolute. Read it to keep the cursor honest, and
      // use it to sanity-check that the tensor lies inside the file.
      const relOffset = cur.u64(`tensor "${tnameSafe}" offset`);

      const info = GGML_TYPES[typeId];
      if (!info) {
        unknownTypeCount += 1;
        // Unknown quant: count the parameters (still true) but not the bytes (unknowable). Under-
        // reporting bytes is the safe direction for a fit check, and the warning makes it visible.
        totalParameters += ne;
        continue;
      }
      const bytes = ggmlRowBytes(typeId, ne)!;
      totalParameters += ne;
      totalBytes += bytes;

      const bucket = byType.get(typeId) ?? { name: info.name, tensors: 0, parameters: 0, bytes: 0, bits: info.bitsPerWeight };
      bucket.tensors += 1;
      bucket.parameters += ne;
      bucket.bytes += bytes;
      byType.set(typeId, bucket);

      // `blk.<n>.<rest>` is the transformer-block convention every llama.cpp conversion follows.
      const m = /^blk\.(\d+)\./.exec(tnameSafe);
      if (m) {
        blockBytes += bytes;
        const idx = Number(m[1]);
        if (Number.isFinite(idx) && idx + 1 > observedBlockCount) observedBlockCount = idx + 1;
      } else {
        nonBlockBytes += bytes;
      }

      if (!largest || bytes > largest.bytes) {
        largest = { name: tnameSafe, bytes, parameters: ne, type: info.name };
      }

      // A tensor whose declared extent lands past EOF means the header does not describe this file.
      if (relOffset + bytes > fileSize) {
        warnings.push(
          `tensor "${tnameSafe}" claims ${bytes} bytes at relative offset ${relOffset}, which exceeds the file size — truncated or corrupt download`,
        );
      }
    }
    if (unknownTypeCount > 0) {
      warnings.push(
        `${unknownTypeCount} tensor(s) use a ggml type this reader does not know; their parameters are counted but their bytes are not. Treat totalBytes as a LOWER bound.`,
      );
    }

    const dataStart = alignUp(cur.pos, alignment);
    if (dataStart > fileSize) {
      warnings.push(`computed data start ${dataStart} is past EOF ${fileSize}`);
    }

    // ── Cross-checks: declared vs observed ──
    if (arch.blockCount !== undefined && observedBlockCount > 0 && arch.blockCount !== observedBlockCount) {
      warnings.push(
        `declared <arch>.block_count = ${arch.blockCount} but the tensors show ${observedBlockCount} blk.* layers`,
      );
    }

    const measuredBitsPerWeight = totalParameters > 0 ? (totalBytes * 8) / totalParameters : undefined;

    const tensors: GgufTensorSummary = {
      tensorCount,
      totalParameters,
      totalBytes,
      measuredBitsPerWeight,
      byType: [...byType.values()]
        .map((b) => ({
          type: b.name,
          tensors: b.tensors,
          parameters: b.parameters,
          bytes: b.bytes,
          bitsPerWeight: b.bits,
        }))
        .sort((a, b) => b.bytes - a.bytes),
      blockBytes,
      nonBlockBytes,
      observedBlockCount,
      bytesPerLayer: observedBlockCount > 0 ? blockBytes / observedBlockCount : undefined,
      largest,
    };

    return {
      path: rawPath,
      resolvedPath,
      fileSize,
      identity,
      version,
      alignment,
      dataStart,
      metadataCount,
      architecture,
      name,
      fileType,
      fileTypeLabel: fileType !== undefined ? GGUF_FILE_TYPE_LABELS[fileType] : undefined,
      author,
      url,
      license,
      description,
      quantizationVersion,
      arch,
      tokenizerModel,
      tensors,
      extra,
      arrays,
      warnings,
    };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed by the OS on error paths */
    }
  }
}

/** Round `offset` up to a multiple of `alignment`. */
export function alignUp(offset: number, alignment: number): number {
  if (alignment <= 1) return offset;
  return Math.ceil(offset / alignment) * alignment;
}

// ── Value reader ─────────────────────────────────────────────────────────────

/**
 * Read one metadata value of `type`, advancing the cursor past it whether or not we keep it.
 *
 * Arrays are the trap: `tokenizer.ggml.tokens` holds one entry per vocab item (150k+ strings) and
 * `tokenizer.ggml.scores` another 150k floats. Capturing them would blow the context and buy
 * nothing for a capacity decision, so every element is walked — to keep the cursor honest — and
 * only the ELEMENT COUNT is recorded, into `arrays`. A joined blob of 150k tokens is worthless and
 * a joined blob of 150k floats is worse: it looks like data a reader would trust.
 */
function readValue(
  cur: Cursor,
  type: number,
  key: string,
  warnings: string[],
  arrays: Record<string, number>,
  depth = 0,
): MetaValue | typeof SKIP {
  if (depth > 4) throw new GgufError('corrupt', `metadata "${key}" nests arrays deeper than 4`);
  switch (type) {
    case V_UINT8: return cur.u8();
    case V_INT8: return cur.i8();
    case V_UINT16: return cur.u16();
    case V_INT16: return cur.i16();
    case V_UINT32: return cur.u32();
    case V_INT32: return cur.i32();
    case V_FLOAT32: return round(cur.f32());
    case V_FLOAT64: return round(cur.f64());
    case V_BOOL: {
      const b = cur.u8();
      if (b > 1) warnings.push(`metadata "${key}" bool value is ${b} (expected 0/1)`);
      return b !== 0;
    }
    case V_UINT64: return cur.u64(`metadata "${key}"`);
    case V_INT64: return cur.i64(`metadata "${key}"`);
    case V_STRING: {
      // Inside an array this is almost always a vocab token: a short string, times 150k. Pass a
      // 0-byte capture limit so `str` skips past it without decoding, and suppress the per-element
      // warning (an array of over-long strings would otherwise emit one warning per token).
      const inArray = depth > 0;
      const { value, length } = cur.str(`metadata "${key}"`, inArray ? 0 : MAX_CAPTURED_STRING);
      if (value === undefined) {
        if (!inArray) {
          warnings.push(`metadata "${key}" is a ${length}-byte string; too long to capture, skipped`);
        }
        return SKIP;
      }
      return value;
    }
    case V_ARRAY: {
      const elemType = cur.u32();
      const len = cur.u64(`metadata "${key}" array length`);
      if (len > MAX_ARRAY_ELEMENTS) {
        throw new GgufError('too_large', `metadata "${key}" declares an array of ${len} elements (cap ${MAX_ARRAY_ELEMENTS})`);
      }
      for (let i = 0; i < len; i += 1) {
        readValue(cur, elemType, `${key}[${i}]`, warnings, arrays, depth + 1);
      }
      // Record the count only at the top level; a nested array's count belongs to its parent's
      // traversal and would just be noise.
      if (depth === 0) arrays[key] = len;
      return SKIP;
    }
    default:
      throw new GgufError('corrupt', `metadata "${key}" has unknown value type ${type}`);
  }
}

/** Keep floats from printing as 0.30000000000000004 in a report. */
function round(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v;
}

function asNumber(v: MetaValue | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function asString(v: MetaValue | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

/** Binary bytes → a short human string. Binary, not decimal: that is what VRAM labels use. */
export function formatBytes(bytes: number, digits = 2): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

/** Parameter count → the shorthand ML engineers use (7.6B, 6.7M). */
export function formatParameters(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n);
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return String(n);
}

/** A one-line human summary of a parsed header, for CLI output and receipts. */
export function summarizeGgufMeta(meta: GgufMeta): string {
  const parts: string[] = [];
  parts.push(meta.name ?? meta.resolvedPath.split('/').pop() ?? 'model');
  if (meta.architecture) parts.push(`arch=${meta.architecture}`);
  parts.push(`params=${formatParameters(meta.tensors.totalParameters)}`);
  parts.push(`weights=${formatBytes(meta.tensors.totalBytes)}`);
  if (meta.tensors.measuredBitsPerWeight !== undefined) {
    parts.push(`${meta.tensors.measuredBitsPerWeight.toFixed(2)} bpw measured`);
  }
  if (meta.fileTypeLabel) parts.push(`file_type=${meta.fileTypeLabel}`);
  if (meta.arch.blockCount !== undefined) parts.push(`layers=${meta.arch.blockCount}`);
  if (meta.arch.contextLength !== undefined) parts.push(`ctx=${meta.arch.contextLength}`);
  if (meta.arch.headCount !== undefined) {
    parts.push(`heads=${meta.arch.headCount}${meta.arch.headCountKv !== undefined ? `/${meta.arch.headCountKv} kv` : ''}`);
  }
  if (meta.arch.expertCount) parts.push(`experts=${meta.arch.expertCount}`);
  return parts.join('  ·  ');
}
