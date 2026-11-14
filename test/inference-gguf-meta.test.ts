/**
 * Hermetic tests for the GGUF container reader (src/inference/ggufMeta.ts).
 *
 * The strategy is a round trip: a tiny GGUF WRITER builds byte-exact containers with the same
 * field ordering the real format uses, then the reader must recover exactly what was written. That
 * tests the wire format rather than the reader's agreement with itself — and it needs no model
 * download, no network, and no llama.cpp on the host.
 *
 * The writer below is deliberately literal about encoding so a mistake cannot be mirrored on both
 * sides: u64 little-endian, strings as length-prefixed UTF-8 with NO NUL, tensor offsets relative
 * to the (aligned) data start, and the alignment padding itself.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  alignUp,
  formatBytes,
  formatParameters,
  GGML_TYPES,
  GGUF_FILE_TYPE_LABELS,
  GgufError,
  ggmlRowBytes,
  parseGgufMeta,
  summarizeGgufMeta,
} from '../src/inference/ggufMeta.js';

// ── A minimal GGUF writer ────────────────────────────────────────────────────

type MetaVal =
  | { t: 'u32'; v: number }
  | { t: 'i32'; v: number }
  | { t: 'u64'; v: number }
  | { t: 'f32'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'str'; v: string }
  | { t: 'arr'; elem: number; v: Array<number | string> }
  | { t: 'raw'; bytes: Buffer };

const VT = {
  u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, f32: 6, bool: 7, str: 8, array: 9,
  u64: 10, i64: 11, f64: 12,
};

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
    case 'raw': return val.bytes;
    case 'arr': {
      const parts: Buffer[] = [encU32(VT.array), encU32(val.elem), encU64(val.v.length)];
      for (const item of val.v) {
        if (val.elem === VT.str) parts.push(encStr(String(item)));
        else if (val.elem === VT.f32) {
          const b = Buffer.alloc(4);
          b.writeFloatLE(Number(item));
          parts.push(b);
        } else if (val.elem === VT.u32) parts.push(encU32(Number(item)));
        else throw new Error(`test writer: unsupported array element type ${val.elem}`);
      }
      return Buffer.concat(parts);
    }
  }
}

interface TestTensor {
  name: string;
  dims: number[];
  typeId: number;
}

/** Build a complete, valid GGUF container. Returns the bytes. */
function writeGguf(input: {
  version?: number;
  alignment?: number;
  meta: Array<[string, MetaVal]>;
  tensors: TestTensor[];
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

  // Tensor infos: name, n_dims, dims[], type, offset. Offsets are assigned in order, each aligned
  // to nothing in particular (ggml packs them), relative to the data start.
  let rel = 0;
  for (const t of input.tensors) {
    parts.push(encStr(t.name));
    parts.push(encU32(t.dims.length));
    for (const d of t.dims) parts.push(encU64(d));
    parts.push(encU32(t.typeId));
    parts.push(encU64(rel));
    rel += ggmlRowBytes(t.typeId, t.dims.reduce((a, b) => a * b, 1)) ?? 0;
  }

  const header = Buffer.concat(parts);
  const dataStart = alignUp(header.length, alignment);
  const padding = Buffer.alloc(dataStart - header.length);
  const dataLen = input.dataBytes ?? rel;
  return Buffer.concat([header, padding, Buffer.alloc(dataLen)]);
}

const ARCH = 'llama';

/** A small but structurally realistic 2-layer model. */
function smallModel(alignment = 32): Buffer {
  return writeGguf({
    alignment,
    meta: [
      ['general.architecture', { t: 'str', v: ARCH }],
      ['general.name', { t: 'str', v: 'Shadow Test Tiny' }],
      ['general.file_type', { t: 'u32', v: 15 }], // MOSTLY_Q4_K_M
      ['general.alignment', { t: 'u32', v: alignment }],
      [`${ARCH}.block_count`, { t: 'u32', v: 2 }],
      [`${ARCH}.context_length`, { t: 'u32', v: 4096 }],
      [`${ARCH}.embedding_length`, { t: 'u32', v: 256 }],
      [`${ARCH}.feed_forward_length`, { t: 'u32', v: 512 }],
      [`${ARCH}.attention.head_count`, { t: 'u32', v: 8 }],
      [`${ARCH}.attention.head_count_kv`, { t: 'u32', v: 2 }],
      [`${ARCH}.vocab_size`, { t: 'u32', v: 32 }],
      ['tokenizer.ggml.model', { t: 'str', v: 'llama' }],
      // A big string array, like a real vocab. Must be walked without capture.
      ['tokenizer.ggml.tokens', {
        t: 'arr', elem: VT.str,
        v: Array.from({ length: 32 }, (_, i) => `tok${i}`),
      }],
      // A float array (real vocab scores).
      ['tokenizer.ggml.scores', {
        t: 'arr', elem: VT.f32,
        v: Array.from({ length: 32 }, (_, i) => -1 - i * 0.5),
      }],
      // A short u32 array — small enough to be worth capturing.
      [`${ARCH}.rope.scaling.factor`, { t: 'f32', v: 1.5 }],
    ],
    tensors: [
      { name: 'token_embd.weight', dims: [256, 32], typeId: 12 }, // Q4_K
      { name: 'blk.0.attn_q.weight', dims: [256, 256], typeId: 12 }, // Q4_K
      { name: 'blk.0.attn_k.weight', dims: [64, 256], typeId: 14 }, // Q6_K
      { name: 'blk.1.attn_q.weight', dims: [256, 256], typeId: 12 },
      { name: 'blk.1.attn_k.weight', dims: [64, 256], typeId: 14 },
      { name: 'output.weight', dims: [32, 256], typeId: 1 }, // F16
      { name: 'output_norm.weight', dims: [256], typeId: 0 }, // F32
    ],
  });
}

const dir = mkdtempSync(join(tmpdir(), 'shadow-gguf-meta-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function withFile(name: string, bytes: Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ggmlRowBytes', () => {
  it('reproduces the bits-per-weight llama.cpp reports', () => {
    // These are the published figures; if the table drifts they fail loudly.
    assert.equal(GGML_TYPES[12].bitsPerWeight, 4.5); // Q4_K
    assert.equal(GGML_TYPES[13].bitsPerWeight, 5.5); // Q5_K
    assert.equal(GGML_TYPES[14].bitsPerWeight, 6.5625); // Q6_K
    assert.equal(GGML_TYPES[10].bitsPerWeight, 2.625); // Q2_K
    assert.equal(GGML_TYPES[11].bitsPerWeight, 3.4375); // Q3_K
    assert.equal(GGML_TYPES[2].bitsPerWeight, 4.5); // Q4_0
    assert.equal(GGML_TYPES[0].bitsPerWeight, 32); // F32
    assert.equal(GGML_TYPES[1].bitsPerWeight, 16); // F16
  });

  it('sizes quantized blocks with the ceil row rule', () => {
    // Q4_K: 144 bytes per 256 weights. 1024 weights = 4 blocks = 576 bytes.
    assert.equal(ggmlRowBytes(12, 1024), 576);
    // F16: 2 bytes each.
    assert.equal(ggmlRowBytes(1, 65536), 131072);
    // A partial block rounds UP to a whole block — never under-report a footprint.
    assert.equal(ggmlRowBytes(12, 100), 144);
    assert.equal(ggmlRowBytes(12, 257), 288);
    assert.equal(ggmlRowBytes(1, 0), 0);
    // Nonsense sizes are refused, not turned into a number.
    assert.equal(ggmlRowBytes(12, -1), undefined);
    assert.equal(ggmlRowBytes(12, Number.POSITIVE_INFINITY), undefined);
  });

  it('returns undefined for an unknown type id rather than guessing', () => {
    assert.equal(ggmlRowBytes(999, 1024), undefined);
    // 4 and 5 (Q4_2, Q4_3) were removed upstream; treat as unknown, not zero.
    assert.equal(ggmlRowBytes(4, 1024), undefined);
    assert.equal(ggmlRowBytes(5, 1024), undefined);
  });

  it('covers the newer upstream types', () => {
    // Verified against ggml-common.h static_asserts: MXFP4 = 1 + 32/2 = 17 bytes per 32 weights.
    assert.equal(GGML_TYPES[39].bytesPerBlock, 17);
    assert.equal(GGML_TYPES[39].blockSize, 32);
    // NVFP4 = 4 + 32 = 36 bytes per 64 weights.
    assert.equal(GGML_TYPES[40].bytesPerBlock, 36);
    assert.equal(GGML_TYPES[40].blockSize, 64);
    // Q8_K is 292, not the commonly-misquoted 260.
    assert.equal(GGML_TYPES[15].bytesPerBlock, 292);
    // IQ2_XS is 74, not 70.
    assert.equal(GGML_TYPES[17].bytesPerBlock, 74);
    assert.ok(GGML_TYPES[34] && GGML_TYPES[35], 'TQ1_0/TQ2_0 present');
    assert.ok(GGML_TYPES[41] && GGML_TYPES[42], 'Q1_0/Q2_0 present');
  });
});

describe('alignUp', () => {
  it('rounds to the alignment boundary', () => {
    assert.equal(alignUp(0, 32), 0);
    assert.equal(alignUp(1, 32), 32);
    assert.equal(alignUp(32, 32), 32);
    assert.equal(alignUp(33, 32), 64);
    assert.equal(alignUp(100, 1), 100);
  });
});

describe('parseGgufMeta', () => {
  it('reads the header of a well-formed container', () => {
    const path = withFile('tiny.gguf', smallModel());
    const meta = parseGgufMeta({ path });

    assert.equal(meta.version, 3);
    assert.equal(meta.architecture, 'llama');
    assert.equal(meta.name, 'Shadow Test Tiny');
    assert.equal(meta.fileType, 15);
    assert.equal(meta.fileTypeLabel, 'MOSTLY_Q4_K_M');
    assert.equal(meta.alignment, 32);
    assert.equal(meta.tokenizerModel, 'llama');
    assert.equal(meta.arch.blockCount, 2);
    assert.equal(meta.arch.contextLength, 4096);
    assert.equal(meta.arch.embeddingLength, 256);
    assert.equal(meta.arch.feedForwardLength, 512);
    assert.equal(meta.arch.headCount, 8);
    assert.equal(meta.arch.headCountKv, 2);
    assert.equal(meta.arch.vocabSize, 32);
    assert.equal(meta.tensors.tensorCount, 7);
    assert.deepEqual(meta.warnings, []);
  });

  it('counts parameters exactly from tensor dimensions', () => {
    const path = withFile('tiny-params.gguf', smallModel());
    const meta = parseGgufMeta({ path });
    // token_embd 256*32=8192; two attn_q 256*256=65536 each; two attn_k 64*256=16384 each;
    // output 32*256=8192; output_norm 256. Total 180480.
    const expected = 8192 + 65536 * 2 + 16384 * 2 + 8192 + 256;
    assert.equal(expected, 180_480);
    assert.equal(meta.tensors.totalParameters, expected);
    assert.equal(formatParameters(expected), '180.48K');
  });

  it('reports measured bits-per-weight that a mixed file cannot hide', () => {
    const path = withFile('tiny-bpw.gguf', smallModel());
    const meta = parseGgufMeta({ path });
    const { totalParameters, totalBytes, measuredBitsPerWeight } = meta.tensors;
    // Recompute independently from the type table.
    let bytes = 0;
    let params = 0;
    for (const share of meta.tensors.byType) {
      bytes += share.bytes;
      params += share.parameters;
    }
    assert.equal(bytes, totalBytes);
    assert.equal(params, totalParameters);
    assert.ok(measuredBitsPerWeight !== undefined);
    // Within one ULP of the definition.
    assert.ok(
      Math.abs(measuredBitsPerWeight! - (totalBytes * 8) / totalParameters) < 1e-9,
      `measuredBitsPerWeight ${measuredBitsPerWeight} != totalBytes*8/totalParameters`,
    );
    // The file is mostly Q4_K (4.5) with F32/F16 tensors pulling it up — so it must NOT equal the
    // declared MOSTLY_Q4_K_M figure. That divergence is the whole point of measuring.
    assert.notEqual(Number(measuredBitsPerWeight!.toFixed(4)), 4.5);
    assert.ok(measuredBitsPerWeight! > 4.5, 'F32/F16 tensors should raise the mean above Q4_K');
  });

  it('sums tensor extents exactly, per type', () => {
    const path = withFile('tiny-bytes.gguf', smallModel());
    const meta = parseGgufMeta({ path });
    // Hand-computed from the writer's tensor list.
    // Q4_K (144 per 256): token_embd 8192w -> 4608B; each attn_q 65536w -> 36864B (x2)
    // Q6_K (210 per 256): each attn_k 16384w -> 13440B (x2)
    // F16: output 8192w -> 16384B
    // F32: output_norm 256w -> 1024B
    const expected = 4608 + 36864 * 2 + 13440 * 2 + 16384 + 1024;
    assert.equal(expected, 122_624);
    assert.equal(meta.tensors.totalBytes, expected);

    const q4k = meta.tensors.byType.find((t) => t.type === 'Q4_K');
    const q6k = meta.tensors.byType.find((t) => t.type === 'Q6_K');
    assert.ok(q4k && q6k);
    assert.equal(q4k.tensors, 3);
    assert.equal(q4k.bytes, 4608 + 36864 * 2);
    assert.equal(q6k.tensors, 2);
    assert.equal(q6k.bytes, 13440 * 2);
    // Largest first.
    assert.equal(meta.tensors.byType[0].type, 'Q4_K');
  });

  it('splits block vs non-block bytes so -ngl offload can be reasoned about', () => {
    const path = withFile('tiny-split.gguf', smallModel());
    const meta = parseGgufMeta({ path });
    const { blockBytes, nonBlockBytes, totalBytes, observedBlockCount, bytesPerLayer } = meta.tensors;
    assert.equal(blockBytes + nonBlockBytes, totalBytes);
    // blk.0/blk.1 hold attn_q (36864) + attn_k (13440) each.
    assert.equal(blockBytes, (36864 + 13440) * 2);
    assert.equal(nonBlockBytes, 4608 + 16384 + 1024);
    assert.equal(observedBlockCount, 2);
    assert.equal(bytesPerLayer, 36864 + 13440);
  });

  it('identifies the largest tensor', () => {
    const path = withFile('tiny-largest.gguf', smallModel());
    const meta = parseGgufMeta({ path });
    assert.ok(meta.tensors.largest);
    assert.equal(meta.tensors.largest.name, 'blk.0.attn_q.weight');
    assert.equal(meta.tensors.largest.bytes, 36864);
    assert.equal(meta.tensors.largest.type, 'Q4_K');
  });

  it('walks large string and float arrays without capturing them', () => {
    const path = withFile('tiny-arrays.gguf', smallModel());
    const meta = parseGgufMeta({ path });
    // The cursor survived the 32-token vocab and the 32-float scores, so everything AFTER them in
    // the tensor section parsed correctly — which is itself the assertion that matters.
    assert.equal(meta.tensors.tensorCount, 7);
    // Contents are never captured into `extra`...
    assert.equal(meta.extra['tokenizer.ggml.tokens'], undefined);
    assert.equal(meta.extra['tokenizer.ggml.scores'], undefined);
    // ...but the element COUNT is, because it confirms the vocab size a tokenizer expects.
    assert.equal(meta.arrays['tokenizer.ggml.tokens'], 32);
    assert.equal(meta.arrays['tokenizer.ggml.scores'], 32);
    // A scalar f32 IS captured as a value.
    assert.equal(meta.extra['llama.rope.scaling.factor'], 1.5);
    // No warnings leaked from walking the arrays (a real vocab would emit one per token).
    assert.deepEqual(meta.warnings, []);
  });

  it('honours a non-default alignment and computes the data start', () => {
    const path = withFile('tiny-align64.gguf', smallModel(64));
    const meta = parseGgufMeta({ path });
    assert.equal(meta.alignment, 64);
    assert.equal(meta.dataStart % 64, 0);
    assert.ok(meta.dataStart >= meta.metadataCount);
  });

  it('rejects a non-GGUF file without echoing its contents', () => {
    const path = withFile('not-a-model.gguf', Buffer.from('this is a private key, not a model', 'utf8'));
    let err: unknown;
    try {
      parseGgufMeta({ path });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof GgufError);
    assert.equal(err.code, 'bad_magic');
    // The SECURITY property: the refusal must not carry file content back to the transcript.
    assert.ok(!err.message.includes('private key'), 'error message leaked file content');
    assert.ok(err.message.includes('74 68 69 73'), 'shows hex magic for diagnosis');
  });

  it('rejects a file shorter than a GGUF header', () => {
    const path = withFile('short.gguf', Buffer.from('GGUF', 'ascii'));
    assert.throws(() => parseGgufMeta({ path }), (e: unknown) => {
      assert.ok(e instanceof GgufError);
      assert.equal(e.code, 'bad_magic');
      return true;
    });
  });

  it('rejects version 1 with actionable advice instead of guessing', () => {
    const bytes = smallModel();
    bytes.writeUInt32LE(1, 4);
    const path = withFile('v1.gguf', bytes);
    assert.throws(() => parseGgufMeta({ path }), (e: unknown) => {
      assert.ok(e instanceof GgufError);
      assert.equal(e.code, 'unsupported_version');
      assert.ok(e.message.includes('re-convert'));
      return true;
    });
  });

  it('accepts version 2', () => {
    const bytes = smallModel();
    bytes.writeUInt32LE(2, 4);
    const path = withFile('v2.gguf', bytes);
    const meta = parseGgufMeta({ path });
    assert.equal(meta.version, 2);
    assert.equal(meta.architecture, 'llama');
  });

  it('reports a missing file as a typed error', () => {
    assert.throws(() => parseGgufMeta({ path: join(dir, 'nope.gguf') }), (e: unknown) => {
      assert.ok(e instanceof GgufError);
      assert.equal(e.code, 'not_found');
      return true;
    });
  });

  it('reports a directory as not-a-file', () => {
    assert.throws(() => parseGgufMeta({ path: dir }), (e: unknown) => {
      assert.ok(e instanceof GgufError);
      assert.equal(e.code, 'not_a_file');
      return true;
    });
  });

  it('rejects an empty path', () => {
    assert.throws(() => parseGgufMeta({ path: '   ' }), (e: unknown) => {
      assert.ok(e instanceof GgufError);
      assert.equal(e.code, 'invalid_path');
      return true;
    });
  });

  it('refuses an absurd tensor count rather than walking forever', () => {
    // Build a container whose declared tensor count exceeds the cap, with enough real tensor infos
    // that the walk would genuinely be long if the cap did not fire first.
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `blk.0.t${i}`,
      dims: [16],
      typeId: 12,
    }));
    const path = withFile('huge-tensor-count.gguf', writeGguf({
      meta: [['general.architecture', { t: 'str', v: ARCH }]],
      tensors: many,
      dataBytes: 200 * ggmlRowBytes(12, 16)!,
    }));
    assert.throws(
      () => parseGgufMeta({ path, maxTensors: 50 }),
      (e: unknown) => {
        assert.ok(e instanceof GgufError);
        assert.equal(e.code, 'too_large');
        assert.ok(e.message.includes('200'), 'names the declared count');
        return true;
      },
    );
    // Under a higher cap the same file parses fine — proving the cap is what fired, not corruption.
    assert.equal(parseGgufMeta({ path, maxTensors: 500 }).tensors.tensorCount, 200);
  });

  it('throws when the HEADER is truncated mid-walk', () => {
    // Cut inside the metadata section: the cursor cannot reach the declared KV count.
    const full = smallModel();
    const path = withFile('trunc-header.gguf', full.subarray(0, 60));
    assert.throws(() => parseGgufMeta({ path }), (e: unknown) => {
      assert.ok(e instanceof GgufError);
      assert.ok(e.code === 'truncated' || e.code === 'corrupt', `unexpected code ${e.code}`);
      return true;
    });
  });

  it('warns but still parses when only the DATA region is truncated', () => {
    // The header is intact, so the metadata is still fully trustworthy and worth returning: a
    // half-downloaded file still tells you exactly what model it is and how big it should be.
    // Refusing to parse it would throw away the one diagnosis the user needs ("your download is
    // short"). Cutting in half leaves the header whole and the tensors overflowing.
    const full = smallModel();
    const path = withFile('trunc-data.gguf', full.subarray(0, Math.floor(full.length / 2)));
    const meta = parseGgufMeta({ path });
    assert.equal(meta.architecture, 'llama');
    assert.equal(meta.tensors.tensorCount, 7);
    assert.ok(
      meta.warnings.some((w) => w.includes('exceeds the file size')),
      `expected a truncation warning, got ${JSON.stringify(meta.warnings)}`,
    );
  });

  it('warns when the tensor data region is missing', () => {
    // Header intact, but zero bytes of tensor data: the extents no longer fit the file.
    const path = withFile('no-data.gguf', writeGguf({
      alignment: 32,
      meta: [
        ['general.architecture', { t: 'str', v: ARCH }],
        [`${ARCH}.block_count`, { t: 'u32', v: 1 }],
      ],
      tensors: [{ name: 'blk.0.attn_q.weight', dims: [256, 256], typeId: 12 }],
      dataBytes: 0,
    }));
    const meta = parseGgufMeta({ path });
    assert.ok(
      meta.warnings.some((w) => w.includes('exceeds the file size')),
      `expected a truncation warning, got ${JSON.stringify(meta.warnings)}`,
    );
    // The parameters are still exactly right — the header described them truthfully.
    assert.equal(meta.tensors.totalParameters, 65536);
  });

  it('warns on an unknown ggml type and still counts parameters', () => {
    const path = withFile('unknown-type.gguf', writeGguf({
      meta: [['general.architecture', { t: 'str', v: ARCH }]],
      tensors: [
        { name: 'blk.0.attn_q.weight', dims: [64, 64], typeId: 12 },
        { name: 'blk.0.weird.weight', dims: [64, 64], typeId: 999 },
      ],
    }));
    const meta = parseGgufMeta({ path });
    // Both counted as parameters; only the known one contributes bytes.
    assert.equal(meta.tensors.totalParameters, 4096 * 2);
    assert.equal(meta.tensors.totalBytes, 2304); // 4096 weights of Q4_K
    assert.ok(meta.warnings.some((w) => w.includes('LOWER bound')), JSON.stringify(meta.warnings));
  });

  it('warns when declared block_count disagrees with the tensors', () => {
    // A header claiming 40 layers over a file that contains 2.
    const mismatched = writeGguf({
      meta: [
        ['general.architecture', { t: 'str', v: ARCH }],
        [`${ARCH}.block_count`, { t: 'u32', v: 40 }],
      ],
      tensors: [
        { name: 'blk.0.attn_q.weight', dims: [64, 64], typeId: 12 },
        { name: 'blk.1.attn_q.weight', dims: [64, 64], typeId: 12 },
      ],
    });
    const path = withFile('layer-mismatch.gguf', mismatched);
    const meta = parseGgufMeta({ path });
    assert.equal(meta.arch.blockCount, 40);
    assert.equal(meta.tensors.observedBlockCount, 2);
    assert.ok(meta.warnings.some((w) => w.includes('block_count')), JSON.stringify(meta.warnings));
    // The well-formed model stays warning-free.
    assert.deepEqual(parseGgufMeta({ path: withFile('layer-ok.gguf', smallModel()) }).warnings, []);
  });

  it('ignores a non-power-of-two alignment and says so', () => {
    const path = withFile('bad-align.gguf', writeGguf({
      meta: [
        ['general.architecture', { t: 'str', v: ARCH }],
        ['general.alignment', { t: 'u32', v: 7 }],
      ],
      tensors: [{ name: 'blk.0.w', dims: [16], typeId: 1 }],
    }));
    const meta = parseGgufMeta({ path });
    assert.equal(meta.alignment, 32, 'falls back to the default');
    assert.ok(meta.warnings.some((w) => w.includes('not a power of two')), JSON.stringify(meta.warnings));
  });

  it('produces a stable, cheap identity for receipts', () => {
    const bytes = smallModel();
    const p1 = withFile('id-a.gguf', bytes);
    const p2 = withFile('id-b.gguf', Buffer.from(bytes));
    const a = parseGgufMeta({ path: p1 });
    const b = parseGgufMeta({ path: p2 });
    assert.match(a.identity, /^[0-9a-f]{64}$/);
    assert.equal(a.identity, b.identity, 'same bytes → same identity, regardless of path');
    // A one-byte change in the header region changes the identity. Flip the first tensor's type
    // from Q4_K (12) to Q6_K (14) via its declared type u32, located by searching the layout
    // rather than hardcoding an offset.
    const changed = Buffer.from(bytes);
    const keyAt = changed.indexOf(Buffer.from('token_embd.weight', 'utf8'));
    assert.ok(keyAt > 0, 'found the first tensor name');
    // `indexOf` lands on the name bytes (the u64 length prefix precedes them), so the type u32 is
    // at: name + n_dims(4) + two dims(8 each).
    const typeAt = keyAt + 17 + 4 + 8 + 8;
    assert.equal(changed.readUInt32LE(typeAt), 12, 'sanity: it is Q4_K before we change it');
    changed.writeUInt32LE(14, typeAt);
    const p3 = withFile('id-c.gguf', changed);
    assert.notEqual(parseGgufMeta({ path: p3 }).identity, a.identity);
  });

  it('omits extra metadata when captureExtra is false', () => {
    const path = withFile('tiny-noextra.gguf', smallModel());
    const withExtra = parseGgufMeta({ path, captureExtra: true });
    const without = parseGgufMeta({ path, captureExtra: false });
    assert.ok(Object.keys(withExtra.extra).length > 0);
    assert.deepEqual(without.extra, {});
    // Array counts are always reported: they are diagnostic and cost one integer each.
    assert.equal(without.arrays['tokenizer.ggml.tokens'], 32);
    // Core fields survive either way.
    assert.equal(without.architecture, withExtra.architecture);
    assert.equal(without.tensors.totalParameters, withExtra.tensors.totalParameters);
  });

  it('reads a corrupt metadata value type as a typed error, not a crash', () => {
    const bytes = smallModel();
    // Locate the first metadata key, then the u32 value type that follows it.
    // Layout: magic(4) version(4) tensorCount(8) metaCount(8) = offset 24, then u64 key length + key.
    const KEY = 'general.architecture';
    const keyAt = bytes.indexOf(Buffer.from(KEY, 'utf8'));
    // `indexOf` lands on the key BYTES; the u64 length prefix sits BEFORE them. So the value type
    // follows the key immediately.
    assert.equal(keyAt, 24 + 8, 'first key bytes start right after the fixed header + length prefix');
    const typeOffset = keyAt + KEY.length;
    assert.equal(typeOffset, 52);
    assert.equal(bytes.readUInt32LE(typeOffset), VT.str, 'sanity: it is a string value');
    bytes.writeUInt32LE(99, typeOffset);
    const path = withFile('bad-type.gguf', bytes);
    assert.throws(() => parseGgufMeta({ path }), (e: unknown) => {
      assert.ok(e instanceof GgufError);
      assert.equal(e.code, 'corrupt');
      assert.ok(e.message.includes('unknown value type 99'), `message was: ${e.message}`);
      return true;
    });
  });

  it('never reads tensor data into memory for a large sparse file', () => {
    // Write a header describing a 1 GiB tensor, then truncate the data to almost nothing. If the
    // reader buffered tensor data this would blow up; instead it must parse the header and warn.
    const bytes = writeGguf({
      meta: [
        ['general.architecture', { t: 'str', v: ARCH }],
        [`${ARCH}.block_count`, { t: 'u32', v: 1 }],
      ],
      tensors: [{ name: 'blk.0.big.weight', dims: [65536, 16384], typeId: 12 }], // 1 Gi weights
      dataBytes: 0,
    });
    const path = withFile('sparse.gguf', bytes);
    const meta = parseGgufMeta({ path });
    assert.equal(meta.tensors.totalParameters, 65536 * 16384);
    // Q4_K: ceil(144 * 1073741824 / 256) = 603979776 bytes
    assert.equal(meta.tensors.totalBytes, 603979776);
    assert.ok(meta.warnings.some((w) => w.includes('exceeds the file size')));
    // The FILE is small; we only ever read the header.
    assert.ok(readFileSync(path).length < 1 << 16);
  });

  it('labels declared file types', () => {
    assert.equal(GGUF_FILE_TYPE_LABELS[15], 'MOSTLY_Q4_K_M');
    assert.equal(GGUF_FILE_TYPE_LABELS[1], 'MOSTLY_F16');
    assert.equal(GGUF_FILE_TYPE_LABELS[30], 'MOSTLY_BF16');
  });
});

describe('formatters', () => {
  it('formats bytes in binary units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.00 KiB');
    assert.equal(formatBytes(1024 ** 2), '1.00 MiB');
    assert.equal(formatBytes(1024 ** 3), '1.00 GiB');
    assert.equal(formatBytes(1536 * 1024 ** 3), '1.50 TiB');
    assert.equal(formatBytes(-1), '-1 B');
  });

  it('formats parameter counts the way ML engineers write them', () => {
    assert.equal(formatParameters(500), '500');
    assert.equal(formatParameters(1500), '1.50K');
    assert.equal(formatParameters(6_738_000_000), '6.74B');
    assert.equal(formatParameters(70_000_000_000), '70.00B');
    assert.equal(formatParameters(1_500_000_000_000), '1.50T');
  });

  it('summarizes a header on one line', () => {
    const path = withFile('tiny-summary.gguf', smallModel());
    const meta = parseGgufMeta({ path });
    const s = summarizeGgufMeta(meta);
    assert.ok(s.includes('Shadow Test Tiny'));
    assert.ok(s.includes('arch=llama'));
    assert.ok(s.includes('params=180.48K'));
    assert.ok(s.includes('bpw measured'));
    assert.ok(s.includes('file_type=MOSTLY_Q4_K_M'));
    assert.ok(s.includes('layers=2'));
    assert.ok(s.includes('ctx=4096'));
    assert.ok(s.includes('heads=8/2 kv'));
    assert.ok(s.includes('weights='));
  });
});
