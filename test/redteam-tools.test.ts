// Hermetic tool tests for the Phase 1 redteam toolbelt (bin_recon, patch_bytes,
// target_snapshot) plus a host-gated regression against the ScreenFlow crack receipt.
// Self-contained: the synthetic Mach-O builder lives here (test files in this repo do
// not import each other).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  chmodSync,
  statSync,
} from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binRecon, __resetBinReconCaches } from '../src/tools/binRecon.js';
import { patchBytes } from '../src/tools/patchBytes.js';
import { targetSnapshot } from '../src/tools/targetSnapshot.js';
import { EvidenceStore } from '../src/security/evidence.js';

const PAGE = 0x4000;
const TEXT_BASE_VA = 0x100000000n;

/** Minimal structurally-valid MH_EXECUTE: header + __TEXT segment + LC_SYMTAB. */
function buildSyntheticImage(
  baseVa = TEXT_BASE_VA,
  cpuType = 0x0100000c,
  symbolNames = ['_patchpoint'],
): { buf: Buffer; patchOffset: number } {
  const SEGMENT_SIZE = 72 + 80;
  const SYMTAB_SIZE = 24;
  const CMDS_SIZE = SEGMENT_SIZE + SYMTAB_SIZE;
  const SYM_OFF = 32 + CMDS_SIZE;
  const STR_OFF = SYM_OFF + 16 * symbolNames.length;
  const strings = Buffer.from(`\0${symbolNames.join('\0')}\0`);
  const textFileOffset = Math.max(PAGE, Math.ceil((STR_OFF + strings.length) / PAGE) * PAGE);
  const buf = Buffer.alloc(textFileOffset + PAGE);
  buf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  buf.writeInt32LE(cpuType, 4);
  buf.writeInt32LE(0, 8); // subtype
  buf.writeUInt32LE(2, 12); // MH_EXECUTE
  buf.writeUInt32LE(2, 16); // ncmds
  buf.writeUInt32LE(CMDS_SIZE, 20); // sizeofcmds
  buf.writeUInt32LE(0x19, 32); // LC_SEGMENT_64
  buf.writeUInt32LE(SEGMENT_SIZE, 36);
  buf.write('__TEXT\0\0\0\0\0\0\0\0\0\0', 40);
  buf.writeBigUInt64LE(baseVa, 56); // vmaddr
  buf.writeBigUInt64LE(BigInt(PAGE), 64); // vmsize
  buf.writeBigUInt64LE(BigInt(textFileOffset), 72); // fileoff
  buf.writeBigUInt64LE(BigInt(PAGE), 80); // filesize
  buf.writeUInt32LE(1, 96); // nsects
  buf.write('__text\0\0\0\0\0\0\0\0\0\0', 104);
  buf.write('__TEXT\0\0\0\0\0\0\0\0\0\0', 120);
  buf.writeBigUInt64LE(baseVa, 136);
  buf.writeBigUInt64LE(BigInt(PAGE), 144);
  buf.writeUInt32LE(textFileOffset, 152);
  const symtab = 32 + SEGMENT_SIZE;
  buf.writeUInt32LE(0x02, symtab); // LC_SYMTAB
  buf.writeUInt32LE(SYMTAB_SIZE, symtab + 4);
  buf.writeUInt32LE(SYM_OFF, symtab + 8);
  buf.writeUInt32LE(symbolNames.length, symtab + 12);
  buf.writeUInt32LE(STR_OFF, symtab + 16);
  buf.writeUInt32LE(strings.length, symtab + 20);
  let stringOffset = 1;
  for (let i = 0; i < symbolNames.length; i++) {
    const entry = SYM_OFF + i * 16;
    buf.writeUInt32LE(stringOffset, entry);
    buf.writeUInt8(0x0f, entry + 4); // N_SECT|N_EXT
    buf.writeUInt8(1, entry + 5);
    buf.writeBigUInt64LE(baseVa + 0x100n + BigInt(i * 4), entry + 8);
    stringOffset += Buffer.byteLength(symbolNames[i]!) + 1;
  }
  strings.copy(buf, STR_OFF);
  for (let i = textFileOffset; i < buf.length; i++) buf[i] = (i ^ 0x5a) & 0xff;
  return { buf, patchOffset: textFileOffset + 0x100 };
}

function buildSyntheticFat(): Buffer {
  const arm = buildSyntheticImage(TEXT_BASE_VA, 0x0100000c).buf;
  const x64 = buildSyntheticImage(0x100100000n, 0x01000007).buf;
  const first = PAGE;
  const second = first + arm.length;
  const fat = Buffer.alloc(second + x64.length);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(2, 4);
  fat.writeInt32BE(0x0100000c, 8);
  fat.writeInt32BE(0, 12);
  fat.writeUInt32BE(first, 16);
  fat.writeUInt32BE(arm.length, 20);
  fat.writeUInt32BE(14, 24);
  fat.writeInt32BE(0x01000007, 28);
  fat.writeInt32BE(0, 32);
  fat.writeUInt32BE(second, 36);
  fat.writeUInt32BE(x64.length, 40);
  fat.writeUInt32BE(14, 44);
  arm.copy(fat, first);
  x64.copy(fat, second);
  return fat;
}

const SYNTHETIC = buildSyntheticImage();

/** Real CS_SuperBlob layout: three uint32 header fields followed by 8-byte indexes. */
function buildSignedImage(xml: string): Buffer {
  const body = Buffer.from(xml);
  const superOffset = 48;
  const entitlementOffset = 36; // 12-byte header, two indexes, one 8-byte dummy blob
  const superLength = entitlementOffset + 8 + body.length;
  const buf = Buffer.alloc(superOffset + superLength);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeInt32LE(0x0100000c, 4);
  buf.writeUInt32LE(2, 12);
  buf.writeUInt32LE(1, 16);
  buf.writeUInt32LE(16, 20);
  buf.writeUInt32LE(0x1d, 32); // LC_CODE_SIGNATURE
  buf.writeUInt32LE(16, 36);
  buf.writeUInt32LE(superOffset, 40);
  buf.writeUInt32LE(superLength, 44);
  buf.writeUInt32BE(0xfade0cc0, superOffset);
  buf.writeUInt32BE(superLength, superOffset + 4);
  buf.writeUInt32BE(2, superOffset + 8); // count, NOT at +12
  buf.writeUInt32BE(0, superOffset + 12); // first index: code directory
  buf.writeUInt32BE(28, superOffset + 16);
  buf.writeUInt32BE(5, superOffset + 20); // second index: entitlements
  buf.writeUInt32BE(entitlementOffset, superOffset + 24);
  buf.writeUInt32BE(0xfade7171, superOffset + entitlementOffset);
  buf.writeUInt32BE(8 + body.length, superOffset + entitlementOffset + 4);
  body.copy(buf, superOffset + entitlementOffset + 8);
  return buf;
}

function ctxFor(ws: string): {
  workspaceRoot: string;
  signal: AbortSignal;
  log: () => void;
  dryRun: boolean;
} {
  return { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
}

function wsFor(): string {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-redteam-'));
  writeFileSync(join(ws, 'target.bin'), SYNTHETIC.buf);
  return ws;
}

test('bin_recon reads a standard 12-byte code-signature superblob header', async () => {
  const ws = wsFor();
  const xml = '<plist><dict><key>fixture-entitlement</key><true/></dict></plist>';
  try {
    writeFileSync(join(ws, 'signed.bin'), buildSignedImage(xml));
    const result = await binRecon.run({ action: 'entitlements', path: 'signed.bin' }, ctxFor(ws));
    assert.equal(result.ok, true, result.summary);
    assert.equal((result.data as { entitlements: string }).entitlements, xml);
    const info = await binRecon.run({ action: 'info', path: 'signed.bin' }, ctxFor(ws));
    assert.equal((info.data as { entitlementsPresent: boolean }).entitlementsPresent, true);
    for (const malformed of ['short-header', 'short-index', 'overlap', 'outside', 'oversized-blob']) {
      const buf = buildSignedImage(xml);
      if (malformed === 'short-header') buf.writeUInt32LE(11, 44);
      if (malformed === 'short-index') buf.writeUInt32BE(20, 52);
      if (malformed === 'overlap') buf.writeUInt32BE(12, 72);
      if (malformed === 'outside') buf.writeUInt32BE(buf.length, 72);
      if (malformed === 'oversized-blob') buf.writeUInt32BE(buf.length, 88);
      writeFileSync(join(ws, 'signed.bin'), buf);
      const invalid = await binRecon.run({ action: 'entitlements', path: 'signed.bin' }, ctxFor(ws));
      assert.equal(invalid.ok, true, invalid.summary);
      assert.equal((invalid.data as { entitlements: string | null }).entitlements, null, malformed);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

for (const format of ['LLVM', 'GNU'] as const) {
  test(`bin_recon scrubs both subprocess environments and parses capped ${format} instructions`, async (t) => {
    const ws = wsFor();
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'review-canary-not-a-real-key';
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const pad = format === 'LLVM' ? '' : '  ';
    const stdout = Buffer.from([
      '/fixture/target.bin: file format mach-o arm64',
      'Disassembly of section __TEXT,__text:',
      '0000000100000100 <_patchpoint>:',
      `${pad}100000100: 52800000  mov w0, #0x0`,
      `${pad}100000104: d65f03c0  ret`,
      `${pad}100000108: d503201f  nop`,
    ].join('\n'));
    const mocked = t.mock.method(childProcess, 'spawnSync', (
      _command: string, args: string[], options: { env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ args, env: options.env });
      return { status: 0, stdout: args.includes('--version') ? Buffer.from('LLVM objdump') : stdout };
    });
    syncBuiltinESMExports();
    __resetBinReconCaches();
    try {
      const result = await binRecon.run({ action: 'disasm', path: 'target.bin', va: '0x100000100', count: 2 }, ctxFor(ws));
      assert.equal(result.ok, true, result.summary);
      assert.equal(calls.length, 2, 'discovery and disassembly must both be checked');
      for (const call of calls) {
        assert.ok(call.env, 'must not implicitly inherit process.env');
        assert.equal(call.env.OPENAI_API_KEY, undefined);
        assert.equal(call.env.PATH, process.env.PATH, 'safe executable lookup remains available');
      }
      const data = result.data as { disasm: string; disassembler: string };
      assert.equal(data.disassembler, 'objdump');
      assert.match(data.disasm, /mov w0/);
      assert.match(data.disasm, /ret/);
      assert.doesNotMatch(data.disasm, /nop|file format|Disassembly of/);
      assert.equal(data.disasm.split('\n').filter((line) => /^\s*[\da-f]+:/i.test(line)).length, 2);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      __resetBinReconCaches();
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
      rmSync(ws, { recursive: true, force: true });
    }
  });
}

test('symbol regexes cannot catastrophically backtrack (isolated hard timeout)', () => {
  const ws = wsFor();
  try {
    writeFileSync(join(ws, 'hostile.bin'), buildSyntheticImage(TEXT_BASE_VA, 0x0100000c, ['a'.repeat(4000) + '!']).buf);
    const url = new URL('../src/tools/binRecon.ts', import.meta.url).href;
    const script = `
      const { binRecon } = await import(${JSON.stringify(url)});
      const results = [];
      for (const filter of ['(a|aa)+$', '^(a+)+$', '(a*)*b']) {
        const r = await binRecon.run({ action: 'symbols', path: 'hostile.bin', filter }, {
          workspaceRoot: ${JSON.stringify(ws)}, signal: new AbortController().signal, log() {}, dryRun: false,
        });
        if (!r.ok) throw new Error(r.summary);
        results.push(r.data.totalMatched);
      }
      process.stdout.write(JSON.stringify(results));
    `;
    const child = childProcess.spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], {
      timeout: 5000, encoding: 'utf8',
    });
    assert.equal(child.error, undefined, `symbol scan timed out: ${child.error?.message}`);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [0, 0, 0]);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('unsupported or invalid symbol regexes fail closed with a useful error', async () => {
  const ws = wsFor();
  try {
    for (const filter of ['[', '(a)\\1', '(?=patch)']) {
      const result = await binRecon.run({ action: 'symbols', path: 'target.bin', filter }, ctxFor(ws));
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, 'bad_filter');
      assert.match(result.summary, /RE2/);
    }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('bin_recon rejects outside-workspace paths', async () => {
  const ws = wsFor();
  const r = await binRecon.run({ action: 'layout', path: '/etc/passwd' }, ctxFor(ws));
  assert.ok(!r.ok);
  assert.equal((r.error as { code?: string } | undefined)?.code, 'outside_workspace');
  rmSync(ws, { recursive: true, force: true });
});

test('bin_recon layout reports thin arm64', async () => {
  const ws = wsFor();
  const r = await binRecon.run({ action: 'layout', path: 'target.bin' }, ctxFor(ws));
  assert.ok(r.ok);
  const data = r.data as { kind: string };
  assert.equal(data.kind, 'thin');
  rmSync(ws, { recursive: true, force: true });
});

test('bin_recon layout lists every fat slice without requiring arch first', async () => {
  const ws = wsFor();
  writeFileSync(join(ws, 'fat.bin'), buildSyntheticFat());
  const r = await binRecon.run({ action: 'layout', path: 'fat.bin' }, ctxFor(ws));
  assert.ok(r.ok, JSON.stringify(r));
  const data = r.data as { kind: string; slices: { archName: string }[] };
  assert.equal(data.kind, 'fat');
  assert.deepEqual(
    data.slices.map((slice) => slice.archName),
    ['arm64', 'x86_64'],
  );
  rmSync(ws, { recursive: true, force: true });
});

test('bin_recon parses real section_64 strides and LC_SYMTAB', async () => {
  const ws = wsFor();
  const info = await binRecon.run({ action: 'info', path: 'target.bin' }, ctxFor(ws));
  assert.ok(info.ok, JSON.stringify(info));
  const infoData = info.data as { segments: { sections: { name: string }[] }[] };
  assert.equal(infoData.segments[0]!.sections[0]!.name, '__text');
  const symbols = await binRecon.run({ action: 'symbols', path: 'target.bin' }, ctxFor(ws));
  assert.ok(symbols.ok, JSON.stringify(symbols));
  assert.equal((symbols.data as { symbols: { name: string }[] }).symbols[0]!.name, '_patchpoint');
  rmSync(ws, { recursive: true, force: true });
});

test('bin_recon symbol filtering scans beyond the return cap and reports exact totals', async () => {
  const ws = wsFor();
  const names = Array.from({ length: 4001 }, (_, i) => `_ordinary_${i}`);
  names.push('_late_needle');
  writeFileSync(join(ws, 'many-symbols.bin'), buildSyntheticImage(TEXT_BASE_VA, 0x0100000c, names).buf);
  const result = await binRecon.run(
    { action: 'symbols', path: 'many-symbols.bin', filter: 'needle$', count: 1 },
    ctxFor(ws),
  );
  assert.ok(result.ok, JSON.stringify(result));
  const data = result.data as {
    totalNamed: number;
    totalMatched: number;
    truncated: boolean;
    symbols: { name: string }[];
  };
  assert.equal(data.totalNamed, names.length);
  assert.equal(data.totalMatched, 1);
  assert.equal(data.truncated, false);
  assert.equal(data.symbols[0]!.name, '_late_needle');
  rmSync(ws, { recursive: true, force: true });
});

test('bin_recon never reuses slice metadata from a different same-sized file', async () => {
  const ws = wsFor();
  writeFileSync(join(ws, 'other.bin'), buildSyntheticImage(0x200000000n).buf);
  const first = await binRecon.run(
    { action: 'va_to_offset', path: 'target.bin', va: '0x100000100' },
    ctxFor(ws),
  );
  assert.ok(first.ok);
  const second = await binRecon.run(
    { action: 'va_to_offset', path: 'other.bin', va: '0x200000100' },
    ctxFor(ws),
  );
  assert.ok(second.ok, JSON.stringify(second));
  rmSync(ws, { recursive: true, force: true });
});

test('bin_recon rejects a fat entry whose inner Mach-O has a different CPU type', async () => {
  const ws = wsFor();
  const fat = buildSyntheticFat();
  fat.writeInt32LE(0x01000007, PAGE + 4);
  writeFileSync(join(ws, 'mismatch.bin'), fat);
  const result = await binRecon.run(
    { action: 'info', path: 'mismatch.bin', arch: 'arm64' },
    ctxFor(ws),
  );
  assert.ok(!result.ok);
  assert.equal((result.error as { code?: string } | undefined)?.code, 'malformed');
  rmSync(ws, { recursive: true, force: true });
});

test('bin_recon rejects overlapping fat slices', async () => {
  const ws = wsFor();
  const fat = buildSyntheticFat();
  fat.writeUInt32BE(PAGE, 36); // second slice starts inside the first
  writeFileSync(join(ws, 'overlap.bin'), fat);
  const result = await binRecon.run({ action: 'layout', path: 'overlap.bin' }, ctxFor(ws));
  assert.ok(!result.ok);
  assert.equal((result.error as { code?: string } | undefined)?.code, 'malformed');
  rmSync(ws, { recursive: true, force: true });
});

test('bin_recon rejects non-macho files', async () => {
  const ws = wsFor();
  writeFileSync(join(ws, 'junk.bin'), Buffer.from('nope'));
  const r = await binRecon.run({ action: 'layout', path: 'junk.bin' }, ctxFor(ws));
  assert.ok(!r.ok);
  assert.equal((r.error as { code?: string } | undefined)?.code, 'not_macho');
  rmSync(ws, { recursive: true, force: true });
});

test('bin_recon va→offset reports the exact mapping', async () => {
  const ws = wsFor();
  const r = await binRecon.run(
    { action: 'va_to_offset', path: 'target.bin', va: '0x100000100' },
    ctxFor(ws),
  );
  assert.ok(r.ok);
  assert.equal((r.data as { offset: number }).offset, SYNTHETIC.patchOffset);
  rmSync(ws, { recursive: true, force: true });
});

test('bin_recon unmapped VA fails closed', async () => {
  const ws = wsFor();
  const r = await binRecon.run(
    { action: 'bytes', path: 'target.bin', va: '0x100100000' },
    ctxFor(ws),
  );
  assert.ok(!r.ok);
  assert.equal((r.error as { code?: string } | undefined)?.code, 'va_unmapped');
  rmSync(ws, { recursive: true, force: true });
});

test('patch_bytes fail-closed on expected-bytes mismatch; target untouched', async () => {
  const ws = wsFor();
  const before = readFileSync(join(ws, 'target.bin'));
  const r = await patchBytes.run(
    {
      action: 'patch',
      path: 'target.bin',
      va: '0x100000100',
      expected_hex: 'ffff',
      new_hex: 'abcd',
    },
    ctxFor(ws),
  );
  assert.ok(!r.ok);
  assert.equal((r.error as { code?: string } | undefined)?.code, 'expected_mismatch');
  assert.deepEqual(readFileSync(join(ws, 'target.bin')), before);
  rmSync(ws, { recursive: true, force: true });
});

test('patch_bytes applies, records receipt, revert restores originals', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  const expected = readFileSync(join(ws, 'target.bin'))
    .subarray(SYNTHETIC.patchOffset, SYNTHETIC.patchOffset + 2)
    .toString('hex');
  const patch = await patchBytes.run(
    {
      action: 'patch',
      path: 'target.bin',
      va: '0x100000100',
      expected_hex: expected,
      new_hex: 'd00d',
    },
    ctx,
  );
  assert.ok(patch.ok, JSON.stringify(patch));
  assert.equal(
    readFileSync(join(ws, 'target.bin'))
      .subarray(SYNTHETIC.patchOffset, SYNTHETIC.patchOffset + 2)
      .toString('hex'),
    'd00d',
  );
  const receipt = (patch.data as { receipt: string }).receipt;
  assert.ok(receipt !== 'unrecorded');
  const revert = await patchBytes.run(
    { action: 'revert', path: 'target.bin', receipt_id: receipt },
    ctx,
  );
  assert.ok(revert.ok, JSON.stringify(revert));
  assert.equal(
    readFileSync(join(ws, 'target.bin'))
      .subarray(SYNTHETIC.patchOffset, SYNTHETIC.patchOffset + 2)
      .toString('hex'),
    expected,
  );
  rmSync(ws, { recursive: true, force: true });
});

test('patch_bytes rejects missing location/bytes', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  const r1 = await patchBytes.run(
    { action: 'patch', path: 'target.bin', expected_hex: '8656', new_hex: '0102' },
    ctx,
  );
  assert.ok(!r1.ok);
  assert.equal((r1.error as { code?: string } | undefined)?.code, 'location_required');
  const r2 = await patchBytes.run({ action: 'patch', path: 'target.bin', va: '0x100000100' }, ctx);
  assert.ok(!r2.ok);
  assert.equal((r2.error as { code?: string } | undefined)?.code, 'bytes_required');
  rmSync(ws, { recursive: true, force: true });
});

test('patch_bytes refuses wrong-slice operations', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  const r = await patchBytes.run(
    {
      action: 'patch',
      path: 'target.bin',
      arch: 'x86_64',
      va: '0x100000100',
      expected_hex: 'ffff',
      new_hex: 'abcd',
    },
    ctx,
  );
  assert.ok(!r.ok);
  rmSync(ws, { recursive: true, force: true });
});

test('patch_bytes refuses a range that crosses the selected slice boundary', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  const fat = buildSyntheticFat();
  writeFileSync(join(ws, 'fat.bin'), fat);
  const boundary = PAGE + SYNTHETIC.buf.length - 1;
  const expected = fat.subarray(boundary, boundary + 2).toString('hex');
  const r = await patchBytes.run(
    {
      action: 'patch',
      path: 'fat.bin',
      arch: 'arm64',
      offset: boundary,
      expected_hex: expected,
      new_hex: 'abcd',
    },
    ctx,
  );
  assert.ok(!r.ok);
  assert.equal((r.error as { code?: string } | undefined)?.code, 'offset_out_of_slice');
  rmSync(ws, { recursive: true, force: true });
});

test('patch_bytes receipts stay unique across repeated patches and stale reverts fail closed', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  const firstExpected = readFileSync(join(ws, 'target.bin'))
    .subarray(SYNTHETIC.patchOffset, SYNTHETIC.patchOffset + 2)
    .toString('hex');
  const first = await patchBytes.run(
    {
      action: 'patch',
      path: 'target.bin',
      va: '0x100000100',
      expected_hex: firstExpected,
      new_hex: 'd00d',
    },
    ctx,
  );
  assert.ok(first.ok, JSON.stringify(first));
  const second = await patchBytes.run(
    {
      action: 'patch',
      path: 'target.bin',
      va: '0x100000100',
      expected_hex: 'd00d',
      new_hex: 'beef',
    },
    ctx,
  );
  assert.ok(second.ok, JSON.stringify(second));
  const firstReceipt = (first.data as { receipt: string }).receipt;
  const secondReceipt = (second.data as { receipt: string }).receipt;
  assert.notEqual(firstReceipt, secondReceipt);
  const stale = await patchBytes.run(
    { action: 'revert', path: 'target.bin', receipt_id: firstReceipt },
    ctx,
  );
  assert.ok(!stale.ok);
  assert.equal((stale.error as { code?: string } | undefined)?.code, 'target_drift');
  const latest = await patchBytes.run(
    { action: 'revert', path: 'target.bin', receipt_id: secondReceipt },
    ctx,
  );
  assert.ok(latest.ok, JSON.stringify(latest));
  assert.equal(
    readFileSync(join(ws, 'target.bin'))
      .subarray(SYNTHETIC.patchOffset, SYNTHETIC.patchOffset + 2)
      .toString('hex'),
    'd00d',
  );
  rmSync(ws, { recursive: true, force: true });
});

for (const mode of [0o666, 0o755, 0o6755]) {
  for (const mask of [0o022, 0o077]) {
    test(`patch and revert preserve mode ${mode.toString(8)} under umask ${mask.toString(8)}`, {
      skip: process.platform === 'win32' ? 'POSIX permission bits' : false,
    }, async () => {
      const ws = wsFor();
      const path = join(ws, 'target.bin');
      const oldMask = process.umask(mask);
      try {
        chmodSync(path, mode);
        assert.equal(statSync(path).mode & 0o7777, mode);
        const patched = await patchBytes.run({
          action: 'patch', path: 'target.bin', offset: SYNTHETIC.patchOffset,
          expected_hex: SYNTHETIC.buf.subarray(SYNTHETIC.patchOffset, SYNTHETIC.patchOffset + 2).toString('hex'),
          new_hex: 'd00d',
        }, ctxFor(ws));
        assert.equal(patched.ok, true, patched.summary);
        const data = patched.data as { receipt: string; backupPath: string };
        assert.equal(statSync(path).mode & 0o7777, mode, 'replacement permissions must survive umask');
        assert.equal(statSync(data.backupPath).mode & 0o7777, mode, 'backup retains every permission bit');
        const reverted = await patchBytes.run({ action: 'revert', path: 'target.bin', receipt_id: data.receipt }, ctxFor(ws));
        assert.equal(reverted.ok, true, reverted.summary);
        assert.equal(statSync(path).mode & 0o7777, mode, 'revert preserves special bits too');
        assert.deepEqual(readFileSync(path), SYNTHETIC.buf);
      } finally {
        process.umask(oldMask);
        rmSync(ws, { recursive: true, force: true });
      }
    });
  }
}

for (const kind of ['file', 'directory'] as const) {
  test(`snapshot detects and restores special permission bits on a ${kind} root`, {
    skip: process.platform === 'win32' ? 'POSIX permission bits' : false,
  }, async () => {
    const ws = wsFor();
    const relative = kind === 'file' ? 'target.bin' : 'tree';
    const path = join(ws, relative);
    const mode = kind === 'file' ? 0o4755 : 0o3770;
    try {
      if (kind === 'directory') {
        mkdirSync(path);
        writeFileSync(join(path, 'child.bin'), SYNTHETIC.buf);
        chmodSync(join(path, 'child.bin'), 0o6755);
      }
      chmodSync(path, mode);
      const baseline = await targetSnapshot.run({ action: 'baseline', path: relative }, ctxFor(ws));
      assert.equal(baseline.ok, true, baseline.summary);
      const snapshot_id = (baseline.data as { snapshotId: string }).snapshotId;
      const clean = await targetSnapshot.run({ action: 'verify', path: relative, snapshot_id }, ctxFor(ws));
      assert.equal((clean.data as { drifted: boolean }).drifted, false);
      chmodSync(path, mode & 0o777);
      if (kind === 'directory') chmodSync(join(path, 'child.bin'), 0o755);
      const drifted = await targetSnapshot.run({ action: 'verify', path: relative, snapshot_id }, ctxFor(ws));
      assert.equal(drifted.ok, true, drifted.summary);
      const data = drifted.data as { drifted: boolean; changes: { op: string; rel: string }[] };
      assert.equal(data.drifted, true, 'special-bit-only change cannot be CLEAN');
      assert.ok(data.changes.some((change) => change.op === 'mode' && change.rel === '<target>'));
      if (kind === 'directory') assert.ok(data.changes.some((change) => change.op === 'mode' && change.rel === 'child.bin'));
      const restored = await targetSnapshot.run({ action: 'restore', path: relative, snapshot_id, overwrite_drift: true }, ctxFor(ws));
      assert.equal(restored.ok, true, restored.summary);
      assert.equal(statSync(path).mode & 0o7777, mode);
      if (kind === 'directory') assert.equal(statSync(join(path, 'child.bin')).mode & 0o7777, 0o6755);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
}

test('target_snapshot baseline/verify/tamper/drift/restore cycle', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  mkdirSync(join(ws, 'subtree'), { recursive: true });
  writeFileSync(join(ws, 'subtree', 'inner.txt'), 'original\n');
  const baseline = await targetSnapshot.run({ action: 'baseline', path: 'subtree' }, ctx);
  assert.ok(baseline.ok, JSON.stringify(baseline));
  const sid = (baseline.data as { snapshotId: string }).snapshotId;
  const clean = await targetSnapshot.run(
    { action: 'verify', path: 'subtree', snapshot_id: sid },
    ctx,
  );
  assert.ok(clean.ok);
  assert.equal((clean.data as { drifted: boolean }).drifted, false);
  writeFileSync(join(ws, 'subtree', 'inner.txt'), 'tampered\n');
  const drifted = await targetSnapshot.run(
    { action: 'verify', path: 'subtree', snapshot_id: sid },
    ctx,
  );
  assert.ok(drifted.ok);
  assert.equal((drifted.data as { drifted: boolean }).drifted, true);
  const refused = await targetSnapshot.run(
    { action: 'restore', path: 'subtree', snapshot_id: sid },
    ctx,
  );
  assert.ok(!refused.ok);
  assert.equal((refused.error as { code?: string } | undefined)?.code, 'drift_refused');
  const restored = await targetSnapshot.run(
    { action: 'restore', path: 'subtree', snapshot_id: sid, overwrite_drift: true },
    ctx,
  );
  assert.ok(restored.ok, JSON.stringify(restored));
  assert.equal(readFileSync(join(ws, 'subtree', 'inner.txt'), 'utf8'), 'original\n');
  rmSync(ws, { recursive: true, force: true });
});

test('target_snapshot detects a changed symlink destination', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  mkdirSync(join(ws, 'links'));
  writeFileSync(join(ws, 'links', 'a.txt'), 'a');
  writeFileSync(join(ws, 'links', 'b.txt'), 'b');
  symlinkSync('a.txt', join(ws, 'links', 'current'));
  const baseline = await targetSnapshot.run({ action: 'baseline', path: 'links' }, ctx);
  assert.ok(baseline.ok, JSON.stringify(baseline));
  const sid = (baseline.data as { snapshotId: string }).snapshotId;
  const clean = await targetSnapshot.run(
    { action: 'verify', path: 'links', snapshot_id: sid },
    ctx,
  );
  assert.ok(clean.ok, JSON.stringify(clean));
  assert.equal((clean.data as { drifted: boolean }).drifted, false);
  unlinkSync(join(ws, 'links', 'current'));
  symlinkSync('b.txt', join(ws, 'links', 'current'));
  const verify = await targetSnapshot.run(
    { action: 'verify', path: 'links', snapshot_id: sid },
    ctx,
  );
  assert.ok(verify.ok, JSON.stringify(verify));
  assert.equal((verify.data as { drifted: boolean }).drifted, true);
  rmSync(ws, { recursive: true, force: true });
});

test('target_snapshot supports a file root and dry-run verify records no receipt', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  writeFileSync(join(ws, 'plain.txt'), 'original\n');
  const baseline = await targetSnapshot.run({ action: 'baseline', path: 'plain.txt' }, ctx);
  assert.ok(baseline.ok, JSON.stringify(baseline));
  const sid = (baseline.data as { snapshotId: string }).snapshotId;
  const beforeStore = new EvidenceStore(ws);
  const before = beforeStore.list().length;
  beforeStore.close();
  const dry = await targetSnapshot.run(
    { action: 'verify', path: 'plain.txt', snapshot_id: sid },
    { ...ctx, dryRun: true },
  );
  assert.ok(dry.ok, JSON.stringify(dry));
  assert.equal((dry.data as { dryRun: boolean }).dryRun, true);
  const afterStore = new EvidenceStore(ws);
  const after = afterStore.list().length;
  afterStore.close();
  assert.equal(after, before, 'dry-run verify must not add an evidence receipt');
  writeFileSync(join(ws, 'plain.txt'), 'changed\n');
  const restored = await targetSnapshot.run(
    { action: 'restore', path: 'plain.txt', snapshot_id: sid, overwrite_drift: true },
    ctx,
  );
  assert.ok(restored.ok, JSON.stringify(restored));
  assert.equal(readFileSync(join(ws, 'plain.txt'), 'utf8'), 'original\n');
  rmSync(ws, { recursive: true, force: true });
});

test('target_snapshot refuses a tampered sealed copy', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  mkdirSync(join(ws, 'sealed-check'));
  writeFileSync(join(ws, 'sealed-check', 'a.txt'), 'original');
  const baseline = await targetSnapshot.run({ action: 'baseline', path: 'sealed-check' }, ctx);
  assert.ok(baseline.ok, JSON.stringify(baseline));
  const sid = (baseline.data as { snapshotId: string }).snapshotId;
  writeFileSync(
    join(ws, '.shadow', 'security', 'target-snapshots', sid, 'sealed', 'a.txt'),
    'tampered',
  );
  const restored = await targetSnapshot.run(
    { action: 'restore', path: 'sealed-check', snapshot_id: sid, overwrite_drift: true },
    ctx,
  );
  assert.ok(!restored.ok);
  assert.equal((restored.error as { code?: string } | undefined)?.code, 'sealed_mismatch');
  rmSync(ws, { recursive: true, force: true });
});

test('target_snapshot rejects a manifest that no longer matches its content-addressed id', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  mkdirSync(join(ws, 'manifest-check'));
  writeFileSync(join(ws, 'manifest-check', 'a.txt'), 'original');
  const baseline = await targetSnapshot.run({ action: 'baseline', path: 'manifest-check' }, ctx);
  assert.ok(baseline.ok, JSON.stringify(baseline));
  const sid = (baseline.data as { snapshotId: string }).snapshotId;
  const manifestPath = join(
    ws,
    '.shadow',
    'security',
    'target-snapshots',
    sid,
    'manifest.json',
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    entries: { sha256: string }[];
  };
  manifest.entries[0]!.sha256 = '0'.repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const restored = await targetSnapshot.run(
    { action: 'restore', path: 'manifest-check', snapshot_id: sid, overwrite_drift: true },
    ctx,
  );
  assert.ok(!restored.ok);
  assert.match(restored.summary, /content-addressed snapshot id/);
  rmSync(ws, { recursive: true, force: true });
});

test('target_snapshot rejects traversal-shaped snapshot ids and snapshot-store overlap', async () => {
  const ws = wsFor();
  const ctx = ctxFor(ws);
  const traversal = await targetSnapshot.run(
    { action: 'verify', path: 'target.bin', snapshot_id: '../../../../outside' },
    ctx,
  );
  assert.ok(!traversal.ok);
  const overlap = await targetSnapshot.run({ action: 'baseline', path: '.' }, ctx);
  assert.ok(!overlap.ok);
  assert.equal((overlap.error as { code?: string } | undefined)?.code, 'snapshot_store_overlap');
  rmSync(ws, { recursive: true, force: true });
});

// ── host-gated regression: the ScreenFlow crack receipt ──────────────────────────
// Runs only when the original target app exists on this host. This is the plan's
// Phase-1 acceptance fixture: VA 0x100409fb0 in the arm64 slice must map to the exact
// pre-patch bytes recorded in the crack receipt (e0 03 14 aa).
const SCREENFLOW = '/Applications/ScreenFlow.app/Contents/MacOS/ScreenFlow';

test('host-gated: ScreenFlow VA 0x100409fb0 maps to receipt bytes e00314aa', async () => {
  if (!existsSync(SCREENFLOW)) return; // skip when the target app is absent
  const ws = mkdtempSync(join(tmpdir(), 'shadow-redteam-host-'));
  try {
    writeFileSync(join(ws, 'screenflow.bin'), readFileSync(SCREENFLOW));
    const r = await binRecon.run(
      { action: 'bytes', path: 'screenflow.bin', arch: 'arm64', va: '0x100409fb0' },
      ctxFor(ws),
    );
    assert.ok(r.ok, JSON.stringify(r));
    const data = r.data as { bytesHex: string };
    assert.ok(data.bytesHex.startsWith('e00314aa'), `got ${data.bytesHex.slice(0, 16)}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
