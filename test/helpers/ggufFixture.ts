/**
 * Hermetic GGUF + host-probe fixtures for the inference tools.
 *
 * Why this lives in `test/helpers` rather than being copied into each test file: the GGUF wire
 * format has to be encoded byte-exactly (u64 LE, length-prefixed UTF-8 with NO NUL, tensor offsets
 * relative to the aligned data start), and two independently-maintained copies of that encoder
 * would eventually disagree — at which point a passing test would mean less than it appears to.
 *
 * Everything here is offline and deterministic: no model download, no network, no real SMI binary.
 */
import type { ProbeOutcome, ProbeRunner } from '../../src/inference/gpu.js';

// ── GGUF value encoding ──────────────────────────────────────────────────────

/** GGUF metadata value type tags, per the format spec. */
export const VT = {
  u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, f32: 6, bool: 7, str: 8, array: 9,
  u64: 10, i64: 11, f64: 12,
} as const;

export type MetaVal =
  | { t: 'u32'; v: number }
  | { t: 'i32'; v: number }
  | { t: 'u64'; v: number }
  | { t: 'f32'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'str'; v: string }
  | { t: 'arr'; elem: number; v: Array<number | string> };

export interface FixtureTensor {
  name: string;
  dims: number[];
  /** ggml type id, e.g. 12 = Q4_K, 14 = Q6_K, 1 = F16, 0 = F32. */
  typeId: number;
}

function encStr(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(body.length));
  return Buffer.concat([len, body]);
}

function encU32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}

function encU64(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function alignUp(n: number, a: number): number {
  return Math.ceil(n / a) * a;
}

/**
 * On-disk extent of a tensor row set for a ggml type.
 *
 * Written out independently of `ggmlRowBytes` on purpose: if the two agree only because one imports
 * the other, a wrong block-size table passes unnoticed. These values were checked against
 * `RAW_TYPES` in `src/inference/ggufMeta.ts` — Q6_K is 210 bytes per 256-weight block, not 208,
 * which is exactly the kind of off-by-two that silently mis-sizes every fixture tensor.
 */
export function fixtureRowBytes(typeId: number, n: number): number | undefined {
  // blockSize / typeSize for the handful of types the fixtures use.
  switch (typeId) {
    case 0: return n * 4; // F32
    case 1: return n * 2; // F16
    case 12: return Math.ceil(n / 256) * 144; // Q4_K: 256 weights per 144-byte block
    case 14: return Math.ceil(n / 256) * 210; // Q6_K: 256 weights per 210-byte block
    default: return undefined;
  }
}

function encValue(val: MetaVal): Buffer {
  switch (val.t) {
    case 'u32': return Buffer.concat([encU32(VT.u32), encU32(val.v)]);
    case 'i32': {
      const b = Buffer.alloc(4);
      b.writeInt32LE(val.v);
      return Buffer.concat([encU32(VT.i32), b]);
    }
    case 'u64': return Buffer.concat([encU32(VT.u64), encU64(val.v)]);
    case 'f32': {
      const b = Buffer.alloc(4);
      b.writeFloatLE(val.v);
      return Buffer.concat([encU32(VT.f32), b]);
    }
    case 'bool': return Buffer.concat([encU32(VT.bool), Buffer.from([val.v ? 1 : 0])]);
    case 'str': return Buffer.concat([encU32(VT.str), encStr(val.v)]);
    case 'arr': {
      const parts: Buffer[] = [encU32(VT.array), encU32(val.elem), encU64(val.v.length)];
      for (const item of val.v) {
        if (val.elem === VT.str) parts.push(encStr(String(item)));
        else if (val.elem === VT.f32) {
          const b = Buffer.alloc(4);
          b.writeFloatLE(Number(item));
          parts.push(b);
        } else if (val.elem === VT.u32) parts.push(encU32(Number(item)));
        else throw new Error(`fixture writer: unsupported array element type ${val.elem}`);
      }
      return Buffer.concat(parts);
    }
  }
}

/** Build a complete, valid GGUF container and return its bytes. */
export function writeGguf(input: {
  version?: number;
  alignment?: number;
  meta: Array<[string, MetaVal]>;
  tensors: FixtureTensor[];
  /** Override the raw tensor-data length, to exercise truncation detection. */
  dataBytes?: number;
  magic?: string;
}): Buffer {
  const version = input.version ?? 3;
  const alignment = input.alignment ?? 32;
  const parts: Buffer[] = [];
  parts.push(Buffer.from(input.magic ?? 'GGUF', 'ascii'));
  parts.push(encU32(version));
  parts.push(encU64(input.tensors.length));
  parts.push(encU64(input.meta.length));

  for (const [key, val] of input.meta) {
    parts.push(encStr(key));
    parts.push(encValue(val));
  }

  let rel = 0;
  for (const t of input.tensors) {
    parts.push(encStr(t.name));
    parts.push(encU32(t.dims.length));
    for (const d of t.dims) parts.push(encU64(d));
    parts.push(encU32(t.typeId));
    parts.push(encU64(rel));
    rel += fixtureRowBytes(t.typeId, t.dims.reduce((a, b) => a * b, 1)) ?? 0;
  }

  const header = Buffer.concat(parts);
  const dataStart = alignUp(header.length, alignment);
  const padding = Buffer.alloc(dataStart - header.length);
  return Buffer.concat([header, padding, Buffer.alloc(input.dataBytes ?? rel)]);
}

export const FIXTURE_ARCH = 'llama';

/**
 * A small but structurally realistic GQA model: 2 layers, 8 query heads, 2 KV heads.
 *
 * The query/KV head asymmetry is the point — it is what makes "did you use KV heads?" observable
 * rather than a coincidence, since using query heads here would overstate the cache 4×.
 */
export function smallGgufModel(opts: { alignment?: number; omitKvHeads?: boolean } = {}): Buffer {
  const alignment = opts.alignment ?? 32;
  const meta: Array<[string, MetaVal]> = [
    ['general.architecture', { t: 'str', v: FIXTURE_ARCH }],
    ['general.name', { t: 'str', v: 'Shadow Test Tiny' }],
    ['general.file_type', { t: 'u32', v: 15 }],
    ['general.alignment', { t: 'u32', v: alignment }],
    [`${FIXTURE_ARCH}.block_count`, { t: 'u32', v: 2 }],
    [`${FIXTURE_ARCH}.context_length`, { t: 'u32', v: 4096 }],
    [`${FIXTURE_ARCH}.embedding_length`, { t: 'u32', v: 256 }],
    [`${FIXTURE_ARCH}.feed_forward_length`, { t: 'u32', v: 512 }],
    [`${FIXTURE_ARCH}.attention.head_count`, { t: 'u32', v: 8 }],
    [`${FIXTURE_ARCH}.vocab_size`, { t: 'u32', v: 32 }],
    ['tokenizer.ggml.model', { t: 'str', v: 'llama' }],
    // A vocab-sized string array: must be walked but never captured.
    ['tokenizer.ggml.tokens', {
      t: 'arr', elem: VT.str, v: Array.from({ length: 32 }, (_, i) => `tok${i}`),
    }],
    [`${FIXTURE_ARCH}.rope.scaling.factor`, { t: 'f32', v: 1.5 }],
  ];
  if (!opts.omitKvHeads) {
    meta.splice(9, 0, [`${FIXTURE_ARCH}.attention.head_count_kv`, { t: 'u32', v: 2 }]);
  }
  return writeGguf({
    alignment,
    meta,
    tensors: [
      { name: 'token_embd.weight', dims: [256, 32], typeId: 12 },
      { name: 'blk.0.attn_q.weight', dims: [256, 256], typeId: 12 },
      { name: 'blk.0.attn_k.weight', dims: [64, 256], typeId: 14 },
      { name: 'blk.1.attn_q.weight', dims: [256, 256], typeId: 12 },
      { name: 'blk.1.attn_k.weight', dims: [64, 256], typeId: 14 },
      { name: 'output.weight', dims: [32, 256], typeId: 1 },
      { name: 'output_norm.weight', dims: [256], typeId: 0 },
    ],
  });
}

// ── Host probe fixtures ──────────────────────────────────────────────────────

/**
 * Build a runner from a name → outcome map. Anything unlisted comes back `absent`, which is what a
 * host without that vendor tool really does — so an omitted probe is an honest "not installed"
 * rather than a silent empty answer.
 */
export function fakeProbeRunner(table: Record<string, Partial<ProbeOutcome>>): ProbeRunner {
  return (name) => {
    const hit = table[name];
    return {
      status: hit?.status ?? 'absent',
      stdout: hit?.stdout ?? '',
      stderr: hit?.stderr ?? '',
      ...(hit?.exitCode !== undefined ? { exitCode: hit.exitCode } : {}),
      ...(hit?.signal !== undefined ? { signal: hit.signal } : {}),
      durationMs: hit?.durationMs ?? 1,
    };
  };
}

/** A Linux box with one RTX 4090 and 128 GiB of RAM, as the probes would report it. */
export const LINUX_4090_RUNNER = fakeProbeRunner({
  'nvidia-smi': {
    status: 'ok',
    exitCode: 0,
    // index, name, memory.total, memory.used, memory.free, driver, compute_cap, power, temp, util, bus
    stdout: '0, NVIDIA GeForce RTX 4090, 24564, 1024, 23500, 550.127.08, 8.9, 450.00, 41, 3, 00000000:01:00.0',
  },
  'proc-meminfo': {
    status: 'ok',
    exitCode: 0,
    stdout: 'MemTotal:       131762248 kB\nMemFree:          8123456 kB\nMemAvailable:   120000000 kB\n',
  },
  nproc: { status: 'ok', exitCode: 0, stdout: '32\n' },
  uname: { status: 'ok', exitCode: 0, stdout: '6.8.0-45-generic\n' },
});

/** A CPU-only Linux host: no accelerator probe is installed at all. */
export const LINUX_CPU_ONLY_RUNNER = fakeProbeRunner({
  'proc-meminfo': {
    status: 'ok',
    exitCode: 0,
    stdout: 'MemTotal:       16384000 kB\nMemAvailable:   12000000 kB\n',
  },
  nproc: { status: 'ok', exitCode: 0, stdout: '8\n' },
  uname: { status: 'ok', exitCode: 0, stdout: '6.8.0-45-generic\n' },
});
