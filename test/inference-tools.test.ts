/**
 * infer_recon + infer_capacity — tool-level behaviour.
 *
 * The engine maths have their own suites (`inference-capacity.test.ts`, `inference-gguf-meta.test.ts`).
 * What is tested HERE is the layer that only exists once a model can drive it:
 *
 *  - the tool refuses a GGUF outside the jail and says how to fix it, instead of failing opaquely;
 *  - host facts come from ToolContext, never from the input schema — a model cannot invent a GPU and
 *    then pass a capacity check against it;
 *  - `unchecked` survives the trip out of the estimator rather than being smoothed into `fits`;
 *  - KV geometry is refused, not guessed, and query heads are never substituted for KV heads;
 *  - declared provenance is labelled as declared, measured as measured.
 *
 * Everything runs offline against in-memory fixtures. No model download, no real SMI binary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../src/tools/types.js';
import { inferRecon } from '../src/tools/inferRecon.js';
import { inferCapacity } from '../src/tools/inferCapacity.js';
import { smallGgufModel, LINUX_4090_RUNNER, LINUX_CPU_ONLY_RUNNER, writeGguf } from './helpers/ggufFixture.js';

/**
 * The host the LINUX_4090_RUNNER fixture reports, as `inventoryAccelerators` actually maps it.
 *
 * These constants were derived by printing the inventory, not by reading the fixture CSV and
 * assuming the mapping. Two places where the assumption would have been wrong:
 *
 *  - A discrete GPU is mapped to `memory.free` (23500 MiB), NOT the nameplate (24564 MiB) and not
 *    `total - used` (23540 MiB). The driver's own free figure accounts for its private reservation;
 *    reporting the larger number is what causes OOM.
 *  - Host RAM is `reclaimable` (MemAvailable), not MemTotal. Wired pages cannot be handed to a
 *    new process, so counting them turns "fits" into an OOM.
 */
const MIB = 1024 * 1024;
const RTX4090_NAMEPLATE = 24564 * MIB;
const RTX4090_FREE = 23500 * MIB;
/** MemAvailable 120000000 kB → bytes. */
const HOST_RECLAIMABLE = 120000000 * 1024;
/** MemTotal 131762248 kB → bytes. Deliberately NOT what the device reports. */
const HOST_TOTAL = 131762248 * 1024;
/** The CPU-only fixture: MemAvailable 12000000 kB. */
const CPUONLY_RECLAIMABLE = 12000000 * 1024;

// Guard against the constants above drifting away from the fixture they describe.
assert.notEqual(RTX4090_NAMEPLATE, RTX4090_FREE, 'nameplate and free must differ or the test proves nothing');
assert.ok(HOST_RECLAIMABLE < HOST_TOTAL);

function makeCtx(root: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: root,
    additionalRoots: [],
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
    ...extra,
  };
}

/** Run a tool through its own zod schema, exactly as the registry would. */
function run(tool: { inputSchema: { parse(v: unknown): unknown }; run(i: never, c: ToolContext): Promise<unknown> }, input: unknown, ctx: ToolContext): Promise<unknown> {
  const parsed = tool.inputSchema.parse(input);
  return tool.run(parsed as never, ctx);
}

/**
 * Is this verdict a pass?
 *
 * Deliberately the SAME definition the engine uses internally (`fits: verdict === 'fits' ||
 * verdict === 'tight'` in compareQuantizations). `tight` means "it fits, but fragmentation or a
 * longer prompt could push it over" — a confirmed-but-narrow pass, not a failure. Tests that
 * asserted `=== 'fits'` would wrongly reject a legitimately tight ceiling, and would disagree with
 * the ladder the same module publishes.
 */
function isPass(verdict: unknown): boolean {
  return verdict === 'fits' || verdict === 'tight';
}

function resultOf(r: unknown): { ok: boolean; code?: string; summary?: string; data: Record<string, unknown> } {
  const out = r as { ok: boolean; summary?: string; error?: { code: string }; data?: Record<string, unknown> };
  return {
    ok: out.ok,
    // Failure codes live on `error`, not at the top level — read them from where they actually are.
    ...(out.error ? { code: out.error.code } : {}),
    ...(out.summary !== undefined ? { summary: out.summary } : {}),
    data: out.data ?? {},
  };
}

/** A ctx pinned to the Linux fixtures, so the probe path matches the fake runner's answers. */
function linuxCtx(root: string, runner: unknown = LINUX_4090_RUNNER): ToolContext {
  return makeCtx(root, { inferProbeRunner: runner, inferArch: 'x86_64', inferPlatform: 'linux' });
}

// ── Schema shape: the contract a reviewer can check without reading the source ──

test('infer_recon and infer_capacity are read-only, deferred, and tool_search-findable', () => {
  for (const tool of [inferRecon, inferCapacity]) {
    assert.equal(tool.risk, 'read', `${tool.name} must not be able to execute anything`);
    assert.equal(tool.deferred, true, `${tool.name} must cost nothing in the default schema`);
    assert.ok((tool.searchAliases ?? []).length > 5, `${tool.name} needs aliases or nobody will find it`);
  }
  // Discovery is by intent, not by guessing the tool name.
  assert.ok(inferCapacity.searchAliases?.includes('will it fit'));
  assert.ok(inferCapacity.searchAliases?.includes('oom'));
  assert.ok(inferRecon.searchAliases?.includes('what gpu do i have'));
  assert.ok(inferRecon.searchAliases?.includes('how big is this model'));
});

test('capacity input schema rejects unknown keys and bad device shapes', () => {
  // `strict()` means a typo'd argument fails loudly instead of being ignored.
  assert.throws(() => inferCapacity.inputSchema.parse({ action: 'estimate', totalMemoryBytes: 1 }));
  // device.totalMemoryBytes must be positive — a zero-memory device is not a device.
  assert.throws(() => inferCapacity.inputSchema.parse({ action: 'estimate', device: { totalMemoryBytes: 0 } }));
  assert.throws(() => inferCapacity.inputSchema.parse({ action: 'estimate', device: { totalMemoryBytes: -1 } }));
  // A valid shape parses.
  assert.ok(inferCapacity.inputSchema.parse({ action: 'estimate', device: { totalMemoryBytes: 24 * 1024 ** 3 } }));
});

// ── infer_recon ──

test('infer_recon parses a GGUF and reports MEASURED geometry', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-recon-'));
  const file = join(ws, 'tiny.gguf');
  writeFileSync(file, smallGgufModel());

  const r = resultOf(await run(inferRecon, { action: 'model', path: file }, makeCtx(ws)));
  assert.equal(r.ok, true, `${String(r.code)}: ${String(r.summary)}`);

  const g = r.data.geometry as { layers: number; kvHeads: number; headDim?: number; embeddingLength: number; headCount: number; weightBytes: number };
  assert.equal(g.layers, 2);
  // The whole point of the fixture's 8-query/2-KV head split: KV heads must be read as 2.
  assert.equal(g.kvHeads, 2, 'must use attention.head_count_kv, never head_count');
  assert.equal(g.headCount, 8);
  assert.equal(g.embeddingLength, 256);
  // headDim is NOT fabricated here: the fixture declares no rope_dimension_count, so recon reports
  // it absent and leaves the derivation to planKvCache (where its source is labelled). Inventing it
  // at recon time would hide a wrong derivation behind a confident-looking number.
  assert.equal(g.headDim, undefined, 'headDim must stay undeclared unless the file states it');
  assert.ok(g.weightBytes > 0);

  const tensors = r.data.tensors as { tensorCount: number; measuredBitsPerWeight: number };
  assert.equal(tensors.tensorCount, 7);
  assert.ok(tensors.measuredBitsPerWeight > 0 && tensors.measuredBitsPerWeight < 8);

  // The vocab array is reported as a COUNT, never as 32 captured strings.
  const arrays = r.data.arrayMetadata as Array<{ key: string; count: number }>;
  const vocab = arrays.find((a) => a.key === 'tokenizer.ggml.tokens');
  assert.equal(vocab?.count, 32);
  assert.ok(!JSON.stringify(r.data).includes('tok7'), 'vocab strings must never be captured');

  const prov = r.data.provenance as Record<string, unknown>;
  assert.equal(prov.tokenizerModel, 'llama');
});

test('infer_recon refuses a model outside the workspace jail and says how to fix it', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-jail-'));
  const outside = mkdtempSync(join(tmpdir(), 'infer-outside-'));
  // A realistic case: models live in a cache directory, not in the repo.
  mkdirSync(join(outside, 'models'), { recursive: true });
  const file = join(outside, 'models', 'tiny.gguf');
  writeFileSync(file, smallGgufModel());

  const r = resultOf(await run(inferRecon, { action: 'model', path: file }, makeCtx(ws)));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'outside_workspace');
  // The error must be actionable, not just a rejection.
  assert.match(String(r.summary), /--add-dir/);
});

test('infer_recon fails closed on a non-GGUF file rather than misreporting it', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-bad-'));
  const file = join(ws, 'notamodel.gguf');
  writeFileSync(file, Buffer.from('this is a safetensors file pretending to be gguf'));

  const r = resultOf(await run(inferRecon, { action: 'model', path: file }, makeCtx(ws)));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_a_gguf', 'a non-GGUF must be named as such, not reported as a tiny model');
});

test('infer_recon reports a truncated container as truncated, not as a smaller model', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-trunc-'));
  const file = join(ws, 'short.gguf');
  // Declare 512 KiB of tensor data but supply only 64 bytes of it.
  writeFileSync(file, writeGguf({
    meta: [['general.architecture', { t: 'str', v: 'llama' }], [`${'llama'}.block_count`, { t: 'u32', v: 2 }]],
    tensors: [{ name: 'blk.0.attn_q.weight', dims: [256, 512], typeId: 12 }],
    dataBytes: 64,
  }));

  const r = resultOf(await run(inferRecon, { action: 'model', path: file }, makeCtx(ws)));
  assert.equal(r.ok, true, 'a partial read is still useful');
  const warnings = r.data.warnings as string[];
  assert.ok(warnings.some((w) => /truncat/i.test(w)), `expected a truncation warning, got: ${JSON.stringify(warnings)}`);
});

test('infer_recon output stays bounded even with hundreds of tensors', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-many-'));
  const file = join(ws, 'wide.gguf');
  const tensors = Array.from({ length: 400 }, (_, i) => ({
    name: `blk.${i % 40}.attn_q.weight.${i}`,
    dims: [256, 256],
    typeId: 12,
  }));
  writeFileSync(file, writeGguf({
    meta: [['general.architecture', { t: 'str', v: 'llama' }]],
    tensors,
    dataBytes: 1024,
  }));

  const r = resultOf(await run(inferRecon, { action: 'model', path: file }, makeCtx(ws)));
  assert.equal(r.ok, true, `${String(r.code)}: ${String(r.summary)}`);
  assert.ok(String(r.summary).length <= 24_000, `summary must be clamped, got ${String(r.summary).length} chars`);
});

// ── infer_capacity: measured device ──

test('infer_capacity probes the host and sizes against the measured device', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-cap-'));
  const file = join(ws, 'tiny.gguf');
  writeFileSync(file, smallGgufModel());

  const r = resultOf(await run(
    inferCapacity,
    { action: 'estimate', path: file, contextTokens: 512 },
    linuxCtx(ws),
  ));
  assert.equal(r.ok, true, r.code ?? r.summary);

  const dev = r.data.device as Record<string, unknown>;
  assert.equal(dev.provenance, 'MEASURED', 'a probed device is measured truth');
  assert.equal(dev.totalMemoryBytes, RTX4090_FREE,
    'a discrete GPU must be planned against its FREE memory, not its nameplate');
  assert.equal(dev.unified, false);
  // Host RAM rides along on a discrete GPU because a partial offload would spill into it, and it is
  // the reclaimable figure rather than MemTotal.
  assert.equal(dev.systemRamBytes, HOST_RECLAIMABLE);
  assert.notEqual(dev.systemRamBytes, HOST_TOTAL, 'must not report wired host memory as available');
  assert.equal(r.data.verdict, 'fits');

  const weights = r.data.weights as { provenance: string; totalBytes: number };
  assert.equal(weights.provenance, 'MEASURED', 'weights came from a real file');
  assert.ok(weights.totalBytes > 0);

  const kv = r.data.kv as { sized: boolean; plan?: { kvHeads: number; headDim: number; headDimSource: string } };
  assert.equal(kv.sized, true);
  assert.equal(kv.plan?.kvHeads, 2);
  // Derived here (256/8), and the source says so — an unstated derivation is how a KV figure doubles.
  assert.equal(kv.plan?.headDim, 32);
  assert.equal(kv.plan?.headDimSource, 'derived');
});

test('infer_capacity solves max-context, and a solved ceiling is a SHARP boundary', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-maxctx-'));
  // Weights large enough that KV, not weights, becomes the binding constraint — so the search finds
  // a real edge instead of running into its own bound. With a 120 KB toy model the ceiling is the
  // search bound (see the bounded-ceiling test below), which is a different thing entirely.
  const ctx = linuxCtx(ws);
  const input = {
    action: 'estimate',
    weightBytes: 20 * 1024 ** 3,
    layers: 80,
    kvHeads: 8,
    headDim: 128,
    contextTokens: 512,
  };

  const base = resultOf(await run(inferCapacity, input, ctx));
  const solved = base.data.solved as { maxContextTokens: number | null; maxContextTokensBounded: boolean };
  assert.ok(solved.maxContextTokens !== null && solved.maxContextTokens >= 512,
    `the solved ceiling must be at least the requested context, got ${solved.maxContextTokens}`);
  assert.equal(solved.maxContextTokensBounded, false,
    'this scenario should find a true edge, not hit the search bound');

  // The ceiling must be a real boundary: it passes, one token past it does not.
  const atMax = resultOf(await run(inferCapacity, { ...input, contextTokens: solved.maxContextTokens! }, ctx));
  assert.ok(isPass(atMax.data.verdict),
    `maxContextTokens=${solved.maxContextTokens} should itself pass, got ${String(atMax.data.verdict)}`);

  const past = resultOf(await run(inferCapacity, { ...input, contextTokens: solved.maxContextTokens! + 1 }, ctx));
  assert.equal(isPass(past.data.verdict), false, 'one token past the ceiling must not pass');
});

test('a ceiling that hit the search bound is reported as a FLOOR, never as a maximum', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-maxctx-bound-'));
  // The tiny fixture (120 KB of weights) fits almost any context, so the binary search terminates at
  // its own bound. That number must NOT be presented as "max context" — it is "at least this much".
  // Reporting it bare would under-state capacity by 2x+ and read as an exact answer.
  const file = join(ws, 'tiny.gguf');
  writeFileSync(file, smallGgufModel());

  const r = resultOf(await run(inferCapacity, { action: 'max-context', path: file, contextTokens: 512 }, linuxCtx(ws)));
  const solved = r.data.solved as { maxContextTokens: number | null; maxContextTokensBounded: boolean };
  assert.ok(solved.maxContextTokens !== null);
  assert.equal(solved.maxContextTokensBounded, true, 'a bound must be flagged as a bound');

  // The summary has to say so in words a human reads, not only in a field a caller must remember.
  assert.match(String(r.summary), /at least|≥|bound/i);
  assert.doesNotMatch(String(r.summary), /max context ≈/, 'must not present a bound with the ≈ "maximum" phrasing');

  // And unlike a true ceiling, going past a bound is expected to still pass — that IS what "bound"
  // means. Assert it, so a future change that silently converts a floor into a fake maximum fails.
  const past = resultOf(await run(
    inferCapacity,
    { action: 'estimate', path: file, contextTokens: solved.maxContextTokens! + 1000 },
    linuxCtx(ws),
  ));
  assert.ok(isPass(past.data.verdict), 'past a search bound there is still room; that is the point of the flag');
});

test('infer_capacity reports max-sequences as a sharp boundary and stays consistent with estimate', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-maxseq-'));
  // Same discipline as max-context: a weight-heavy geometry so the search finds a true edge rather
  // than its own bound. The toy fixture would pin at the 4096 bound and prove nothing.
  const ctx = linuxCtx(ws);
  const base = {
    action: 'estimate',
    weightBytes: 20 * 1024 ** 3,
    layers: 80,
    kvHeads: 8,
    headDim: 128,
    contextTokens: 2048,
  };

  const solved = resultOf(await run(inferCapacity, { ...base, action: 'max-sequences' }, ctx));
  const s = solved.data.solved as { maxSequences: number | null; maxSequencesBounded: boolean };
  assert.ok(s.maxSequences !== null && s.maxSequences >= 1, `expected a solved sequence ceiling, got ${s.maxSequences}`);
  assert.equal(s.maxSequencesBounded, false, 'this scenario should find a true edge');

  // Same question asked as a plain estimate must give the same number — the action steers the
  // summary, never the arithmetic. Two actions producing two answers for identical inputs would
  // mean the solver is not the single source of truth.
  const viaEstimate = resultOf(await run(inferCapacity, base, ctx));
  assert.equal((viaEstimate.data.solved as { maxSequences: number | null }).maxSequences, s.maxSequences);

  // The ceiling is real: at max it passes, one sequence above it, it does not.
  const atMax = resultOf(await run(inferCapacity, { ...base, sequences: s.maxSequences! }, ctx));
  assert.ok(isPass(atMax.data.verdict), `maxSequences=${s.maxSequences} should itself pass, got ${String(atMax.data.verdict)}`);
  const past = resultOf(await run(inferCapacity, { ...base, sequences: s.maxSequences! + 1 }, ctx));
  assert.equal(isPass(past.data.verdict), false, 'one sequence past the ceiling must not pass');
});

// ── infer_capacity: host facts are not model-controllable ──

test('a model cannot declare a fake probe result to invent hardware', () => {
  // Schema-only assertion: no tool call, so no workspace and no temp directory is needed.
  // The schema is strict: probe-shaped arguments are rejected outright rather than ignored.
  assert.throws(
    () => inferCapacity.inputSchema.parse({
      action: 'estimate',
      weightBytes: 1024,
      runner: LINUX_4090_RUNNER,
    }),
    /runner|unrecognized/i,
  );
  assert.throws(
    () => inferCapacity.inputSchema.parse({ action: 'estimate', weightBytes: 1024, arch: 'x86_64' }),
    /arch|unrecognized/i,
  );
});

test('without a probe and without a device, capacity refuses instead of assuming infinite memory', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-nodev-'));
  // No accelerator present and no host RAM reported: there is nothing to size against.
  const r = resultOf(await run(
    inferCapacity,
    { action: 'estimate', parameters: 7e9 },
    makeCtx(ws, {
      inferProbeRunner: () => ({ status: 'absent' as const, stdout: '', stderr: '', durationMs: 1 }),
      inferArch: 'x86_64',
      inferPlatform: 'linux',
    }),
  ));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_device');
});

test('probe:false with no device is a clear refusal, not a silent zero-memory verdict', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-noprobe-'));
  const r = resultOf(await run(inferCapacity, { action: 'estimate', parameters: 7e9, probe: false }, makeCtx(ws)));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_device');
});

test('an explicit device is labelled DECLARED, not passed off as measured', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-declared-'));
  const r = resultOf(await run(
    inferCapacity,
    {
      action: 'estimate',
      parameters: 7e9,
      layers: 32,
      kvHeads: 8,
      headDim: 128,
      device: { totalMemoryBytes: 24 * 1024 ** 3, label: 'RTX 4090 (claimed)' },
    },
    linuxCtx(ws),
  ));
  assert.equal(r.ok, true, r.code ?? r.summary);
  const dev = r.data.device as { provenance: string; label: string };
  assert.equal(dev.provenance, 'DECLARED');
  assert.equal(dev.label, 'RTX 4090 (claimed)');
  // The DEVICE is declared, but the geometry came from `parameters` — a modelled footprint, not a
  // measured one. Two different provenances in one answer, which is exactly why each is tagged.
  const geom = r.data.geometry as { provenance: string };
  assert.equal(geom.provenance, 'MODELLED');
});

// ── infer_capacity: fail-closed behaviour ──

test('missing host RAM on a discrete GPU with partial offload is unchecked, never fits', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-failclosed-'));
  // Weights MUST exceed the device, or there is nothing to spill and no CPU pool to leave unjudged.
  // 30 GiB into a 23.5 GiB card with -ngl 20/40 puts ~15 GiB on the CPU side; claiming no
  // systemRamBytes means that half was never measured.
  const r = resultOf(await run(
    inferCapacity,
    {
      action: 'estimate',
      weightBytes: 30 * 1024 ** 3,
      layers: 40,
      kvHeads: 8,
      headDim: 128,
      gpuLayers: 20,
      contextTokens: 1024,
      device: { totalMemoryBytes: 24564 * MIB, unified: false, label: 'small discrete GPU' },
    },
    makeCtx(ws),
  ));
  assert.equal(r.ok, true, `${String(r.code)}: ${String(r.summary)}`);
  const weights = r.data.weights as { cpuBytes: number };
  assert.ok(weights.cpuBytes > 0, 'the scenario needs a CPU-resident half or it proves nothing');
  assert.equal(r.data.verdict, 'unchecked',
    `an unjudgeable CPU pool must not be reported as a pass; got ${String(r.data.verdict)}`);
  const pools = r.data.pools as { cpuPoolAvailableBytes?: number };
  assert.equal(pools.cpuPoolAvailableBytes, undefined, 'no host RAM was declared, so the pool was never sized');
});

test('supplying host RAM turns the same unjudgeable case into a real verdict', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-withram-'));
  const input = {
    action: 'estimate',
    weightBytes: 30 * 1024 ** 3,
    layers: 40,
    kvHeads: 8,
    headDim: 128,
    gpuLayers: 20,
    contextTokens: 1024,
  };
  const without = resultOf(await run(inferCapacity, {
    ...input,
    device: { totalMemoryBytes: 24564 * MIB, unified: false },
  }, makeCtx(ws)));
  const withRam = resultOf(await run(inferCapacity, {
    ...input,
    device: { totalMemoryBytes: 24564 * MIB, unified: false, systemRamBytes: HOST_RECLAIMABLE },
  }, makeCtx(ws)));

  assert.equal(without.data.verdict, 'unchecked');
  assert.equal(withRam.data.verdict, 'fits',
    'one variable changed (host RAM), so the verdict must change — this is the controlled comparison');
});

test('unknown KV geometry refuses the KV plan instead of guessing from query heads', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-nokv-'));
  const file = join(ws, 'nokv.gguf');
  // omitKvHeads drops attention.head_count_kv: 8 query heads remain, which is exactly the
  // temptation to substitute.
  writeFileSync(file, smallGgufModel({ omitKvHeads: true }));

  const r = resultOf(await run(
    inferCapacity,
    { action: 'estimate', path: file, contextTokens: 512 },
    linuxCtx(ws),
  ));
  assert.equal(r.ok, true, r.code ?? r.summary);
  const kv = r.data.kv as { sized: boolean; bytes: number };
  assert.equal(kv.sized, false, 'KV must be refused when head_count_kv is absent');
  assert.equal(kv.bytes, 0);
  assert.notEqual(r.data.verdict, 'fits', 'a verdict cannot be a clean pass on an unsized KV cache');
});

test('declaring query heads but no KV heads warns about the 8x GQA overstatement', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-gqa-'));
  const r = resultOf(await run(
    inferCapacity,
    { action: 'estimate', weightBytes: 1024 ** 2, heads: 64, contextTokens: 512 },
    makeCtx(ws),
  ));
  assert.equal(r.ok, true, r.code ?? r.summary);
  const warnings = r.data.warnings as string[];
  assert.ok(
    warnings.some((w) => /query heads|head_count_kv|kvHeads/i.test(w)),
    `expected a GQA substitution warning, got: ${JSON.stringify(warnings)}`,
  );
});

test('declared parameters without a file are labelled MODELLED and carry the derived figure', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-modelled-'));
  const r = resultOf(await run(
    inferCapacity,
    { action: 'estimate', parameters: 7e9, bitsPerWeight: 4.5, layers: 32, kvHeads: 8, headDim: 128 },
    linuxCtx(ws),
  ));
  assert.equal(r.ok, true, r.code ?? r.summary);
  const weights = r.data.weights as { provenance: string; totalBytes: number };
  assert.equal(weights.provenance, 'MODELLED');
  // 7e9 × 4.5 bits / 8 ≈ 3.94 GiB
  assert.ok(weights.totalBytes > 3.5 * 1024 ** 3 && weights.totalBytes < 4.5 * 1024 ** 3,
    `expected ≈3.94 GiB, got ${weights.totalBytes}`);
  const geom = r.data.geometry as { provenance: string };
  assert.equal(geom.provenance, 'MODELLED');
  assert.ok((r.data.warnings as string[]).some((w) => /MODELLED/i.test(w)));
});

test('sizing without weights is a clear refusal, not a zero-byte fit', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-noweights-'));
  // A device is supplied on purpose: this test isolates the MISSING-WEIGHTS failure. Without it,
  // the outcome would depend on whether the host happened to have an accelerator — a GPU-less
  // machine would report `no_device` first and the test would pass for the wrong reason.
  const r = resultOf(await run(
    inferCapacity,
    { action: 'estimate', layers: 32, kvHeads: 8, device: { totalMemoryBytes: RTX4090_NAMEPLATE } },
    makeCtx(ws),
  ));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'needs_weights');
  assert.match(String(r.summary), /path|weightBytes|parameters/);
});

test('a model too large for the device reports does_not_fit with real numbers', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-toobig-'));
  const r = resultOf(await run(
    inferCapacity,
    {
      action: 'estimate',
      weightBytes: 40 * 1024 ** 3, // 40 GiB into a 24 GiB card
      layers: 80,
      kvHeads: 8,
      headDim: 128,
      contextTokens: 4096,
    },
    linuxCtx(ws),
  ));
  assert.equal(r.ok, true, r.code ?? r.summary);
  assert.equal(r.data.verdict, 'does-not-fit');
  const pools = r.data.pools as { gpuPoolBytes: number; gpuPoolAvailableBytes: number; gpuHeadroomBytes: number };
  assert.equal(pools.gpuPoolAvailableBytes, RTX4090_FREE);
  assert.ok(pools.gpuPoolBytes > pools.gpuPoolAvailableBytes);
  assert.ok(pools.gpuHeadroomBytes < 0, 'negative headroom is the signal');
});

test('partial offload does not charge CPU-resident weights to VRAM', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-offload-'));
  const ctx = linuxCtx(ws);
  const base = {
    action: 'estimate',
    weightBytes: 20 * 1024 ** 3,
    layers: 40,
    kvHeads: 8,
    headDim: 128,
    contextTokens: 1024,
    device: { totalMemoryBytes: RTX4090_FREE, unified: false, systemRamBytes: HOST_RECLAIMABLE, label: 'RTX 4090' },
  };

  const all = resultOf(await run(inferCapacity, { ...base, gpuLayers: 40 }, ctx));
  const none = resultOf(await run(inferCapacity, { ...base, gpuLayers: 0 }, ctx));
  const half = resultOf(await run(inferCapacity, { ...base, gpuLayers: 20 }, ctx));

  const gpuBytes = (r: ReturnType<typeof resultOf>) => (r.data.weights as { gpuBytes: number }).gpuBytes;
  assert.equal(gpuBytes(none), 0, 'zero layers offloaded means zero weights on the GPU');
  assert.equal(gpuBytes(all), 20 * 1024 ** 3, 'full offload puts every weight on the GPU');
  assert.ok(gpuBytes(half) > 0 && gpuBytes(half) < gpuBytes(all), 'partial offload splits the pool');
  // And the split is what makes the difference: half the layers must not bill the full 20 GiB to VRAM.
  assert.ok((half.data.weights as { cpuBytes: number }).cpuBytes > 0);
});

// ── compare-quants ──

test('compare-quants ranks a ladder and names what is actually servable', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-quants-'));
  const r = resultOf(await run(
    inferCapacity,
    { action: 'compare-quants', parameters: 7e9, layers: 32, kvHeads: 8, headDim: 128, contextTokens: 4096, device: { totalMemoryBytes: RTX4090_FREE, systemRamBytes: HOST_RECLAIMABLE } },
    makeCtx(ws),
  ));
  assert.equal(r.ok, true, r.code ?? r.summary);
  const options = r.data.options as Array<{ dtype: string; weightBytes: number; totalBytes: number; fits: boolean }>;
  assert.ok(options.length >= 5, `expected a real ladder, got ${options.length}`);

  // Weights must grow with density and F16 must be the heaviest.
  const byWeight = [...options].sort((a, b) => a.weightBytes - b.weightBytes);
  assert.equal(byWeight[0].dtype.toLowerCase().startsWith('q2'), true, 'Q2_K should be the lightest');
  assert.equal(byWeight[byWeight.length - 1].dtype, 'F16');

  const servable = r.data.servable as string[];
  assert.ok(servable.length > 0);
  assert.deepEqual(servable, options.filter((o) => o.fits).map((o) => o.dtype));
});

test('compare-quants without a parameter count is a clear refusal', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-quants-noparam-'));
  // A device IS given, so this isolates the missing-parameter failure rather than tripping over
  // device resolution first.
  const r = resultOf(await run(
    inferCapacity,
    { action: 'compare-quants', device: { totalMemoryBytes: RTX4090_FREE } },
    makeCtx(ws),
  ));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'compare_needs_parameters');
});

test('compare-quants on a device too small for anything says so instead of returning an empty ladder', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-quants-tiny-'));
  const r = resultOf(await run(
    inferCapacity,
    { action: 'compare-quants', parameters: 70e9, contextTokens: 4096, device: { totalMemoryBytes: 1024 ** 3, unified: true } },
    makeCtx(ws),
  ));
  assert.equal(r.ok, true, r.code ?? r.summary);
  assert.deepEqual(r.data.servable, []);
  assert.match(String(r.summary), /No quantization/i);
});

// ── CPU-only host ──

test('a CPU-only host is sized as ONE unified pool from measured reclaimable RAM', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-cpuonly-'));
  const r = resultOf(await run(
    inferCapacity,
    { action: 'estimate', parameters: 7e9, layers: 32, kvHeads: 8, headDim: 128, contextTokens: 2048 },
    linuxCtx(ws, LINUX_CPU_ONLY_RUNNER),
  ));
  assert.equal(r.ok, true, `${String(r.code)}: ${String(r.summary)}`);
  const dev = r.data.device as { unified: boolean; totalMemoryBytes: number; provenance: string };
  // Regression guard for a real fail-closed bug: this used to be `unified: false`, which made
  // capacity.ts hunt for a SECOND pool in systemRamBytes — a field meaning "host RAM beside the
  // VRAM", which a CPU-only host does not have. `-ngl 0`, the only correct CPU placement, then
  // returned `unchecked` with "host RAM was not reported" despite MemAvailable having just been
  // measured. One pool means `unified: true`.
  assert.equal(dev.unified, true, 'a CPU-only host has one pool, not a phantom zero-memory GPU');
  assert.equal(dev.totalMemoryBytes, CPUONLY_RECLAIMABLE, 'MemAvailable, not MemTotal: wired pages cannot be handed out');
  assert.equal(dev.provenance, 'MEASURED');
  // And the placement that used to fail closed must now be judged.
  const ngl0 = resultOf(await run(
    inferCapacity,
    { action: 'estimate', parameters: 7e9, layers: 32, kvHeads: 8, headDim: 128, contextTokens: 2048, gpuLayers: 0 },
    linuxCtx(ws, LINUX_CPU_ONLY_RUNNER),
  ));
  assert.equal(ngl0.ok, true, `${String(ngl0.code)}: ${String(ngl0.summary)}`);
  assert.notEqual(ngl0.data.verdict, 'unchecked',
    '-ngl 0 on a CPU-only host is the CORRECT placement and must be judged, not refused');
});

// ── kv dtype ──

test('quantized KV really does cost less than f16 KV', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'infer-kvdtype-'));
  const ctx = linuxCtx(ws);
  const base = { action: 'estimate', parameters: 7e9, layers: 32, kvHeads: 8, headDim: 128, contextTokens: 8192 };

  const f16 = resultOf(await run(inferCapacity, { ...base, kvDtype: 'f16' }, ctx));
  const q8 = resultOf(await run(inferCapacity, { ...base, kvDtype: 'q8_0' }, ctx));
  const q4 = resultOf(await run(inferCapacity, { ...base, kvDtype: 'q4_0' }, ctx));

  const kvBytes = (r: ReturnType<typeof resultOf>) => (r.data.kv as { bytes: number }).bytes;
  assert.ok(kvBytes(q8) < kvBytes(f16), 'q8_0 KV must be cheaper than f16');
  assert.ok(kvBytes(q4) < kvBytes(q8), 'q4_0 KV must be cheaper than q8_0');
  assert.ok((f16.data.kv as { plan: { bytesPerToken: number } }).plan.bytesPerToken > 0);
});

// ── bad input ──

test('an unknown action is rejected rather than defaulting to estimate', () => {
  assert.throws(() => inferCapacity.inputSchema.parse({ action: 'vibe', parameters: 7e9 }));
  assert.throws(() => inferRecon.inputSchema.parse({ action: 'write', path: 'x.gguf' }));
  assert.throws(() => inferRecon.inputSchema.parse({ action: 'read' }), /host|model/);
});

test('infer_recon action=model without a path refuses at RUN time, not in the schema', async () => {
  // The schema must keep accepting a path-less call, because `action: 'host'` legitimately needs no
  // path. So this is enforced where the two actions diverge — in run() — and the error has to be
  // actionable rather than an opaque crash.
  const ws = mkdtempSync(join(tmpdir(), 'infer-recon-nopath-'));
  assert.deepEqual(inferRecon.inputSchema.parse({ action: 'host' }), { action: 'host' });

  const r = resultOf(await run(inferRecon, { action: 'model' }, makeCtx(ws)));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missing_path');
  assert.match(String(r.summary), /requires `path`/);
});
