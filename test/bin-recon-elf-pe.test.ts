// F2 — ELF + PE support in bin_recon. Hand-built minimal fixtures (no external
// binaries): a little-endian ELF64 executable and a PE32+ DLL, each exercising
// layout/info/symbols/bytes/va_to_offset/offset_to_va plus fail-closed behavior
// on malformed input. The Mach-O path is regression-pinned separately in
// redteam-tools.test.ts; here we assert the new dispatch does not disturb it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binRecon } from '../src/tools/binRecon.js';
import { parseElf, isElf, ElfError, scanSymbols as elfScanSymbols, vaToOffset as elfVaToOffset, offsetToVa as elfOffsetToVa } from '../src/security/elf.js';
import { parsePe, isPe, PeError, scanSymbols as peScanSymbols, vaToOffset as peVaToOffset, offsetToVa as peOffsetToVa, MAX_PE_IMPORT_FUNCS_TOTAL } from '../src/security/pe.js';

function ctxFor(ws: string) {
  return { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
}
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-elfpe-'));
}

// ── ELF64 little-endian fixture ─────────────────────────────────────────────
// PT_LOAD (RX, vaddr 0x400000) covers headers; PT_DYNAMIC; PT_INTERP; PT_GNU_STACK
// (RW, non-exec → NX); PT_GNU_RELRO. Sections: .interp .dynstr .dynsym .dynamic
// .shstrtab. One defined FUNC (main) + one undefined (__stack_chk_fail → canary).
const ELF_LOAD_VA = 0x400000n;
const ELF_ENTRY = 0x401000n;
const ELF_MAIN_VA = 0x401000n;

function buildElf64(): Buffer {
  const interp = Buffer.from('/lib64/ld-linux-x86-64.so.2\0');
  const dynstr = Buffer.from('\0libc.so.6\0__stack_chk_fail\0main\0');
  const dynsym = Buffer.alloc(48); // 2 × Elf64_Sym
  // sym[0]: __stack_chk_fail, UND, GLOBAL FUNC (.dynstr offset 11)
  dynsym.writeUInt32LE(11, 0); // st_name
  dynsym.writeUInt8(0x12, 4); // st_info GLOBAL|FUNC
  // sym[1]: main, defined in section 1, GLOBAL FUNC (.dynstr offset 28)
  dynsym.writeUInt32LE(28, 24); // st_name
  dynsym.writeUInt8(0x12, 24 + 4);
  dynsym.writeUInt16LE(6, 24 + 6); // st_shndx = 6 (.text)
  dynsym.writeBigUInt64LE(ELF_MAIN_VA, 24 + 8); // st_value
  dynsym.writeBigUInt64LE(0x40n, 24 + 16); // st_size
  // .dynamic: DT_NEEDED libc, DT_STRTAB, DT_STRSZ, DT_FLAGS_1 NOW, DT_NULL
  const dyn = Buffer.alloc(80);
  const dynEnt = (i: number, tag: bigint, val: bigint) => {
    dyn.writeBigUInt64LE(tag, i * 16);
    dyn.writeBigUInt64LE(val, i * 16 + 8);
  };
  const shstr = Buffer.from('\0.interp\0.dynstr\0.dynsym\0.dynamic\0.shstrtab\0.text\0');

  // File layout (all inside the first LOAD segment).
  const ehdrSize = 64;
  const phoff = ehdrSize;
  const phnum = 5;
  const phentsize = 56;
  const interpOff = phoff + phnum * phentsize; // 344
  const dynstrOff = interpOff + interp.length;
  const dynsymOff = dynstrOff + dynstr.length;
  const dynamicOff = dynsymOff + dynsym.length;
  const shstrOff = dynamicOff + dyn.length;
  const shoff = shstrOff + shstr.length;
  const shnum = 7;
  const shentsize = 64;
  const textOff = 0x1000; // .text at the entry VA (0x401000)
  const textSize = 0x40;
  const total = textOff + textSize;
  const buf = Buffer.alloc(total);

  const dynstrVa = ELF_LOAD_VA + BigInt(dynstrOff);

  // e_ident
  buf.write('\x7fELF', 0, 'latin1');
  buf.writeUInt8(2, 4); // ELFCLASS64
  buf.writeUInt8(1, 5); // ELFDATA2LSB
  buf.writeUInt8(1, 6); // EV_CURRENT
  buf.writeUInt16LE(2, 16); // ET_EXEC
  buf.writeUInt16LE(62, 18); // EM_X86_64
  buf.writeUInt32LE(1, 20); // e_version
  buf.writeBigUInt64LE(ELF_ENTRY, 24); // e_entry
  buf.writeBigUInt64LE(BigInt(phoff), 32); // e_phoff
  buf.writeBigUInt64LE(BigInt(shoff), 40); // e_shoff
  buf.writeUInt32LE(0, 48); // e_flags
  buf.writeUInt16LE(ehdrSize, 52); // e_ehsize
  buf.writeUInt16LE(phentsize, 54);
  buf.writeUInt16LE(phnum, 56);
  buf.writeUInt16LE(shentsize, 58);
  buf.writeUInt16LE(shnum, 60);
  buf.writeUInt16LE(5, 62); // e_shstrndx
  // .text code bytes at the entry offset (a few NOPs + RET).
  buf.fill(0x90, textOff, textOff + textSize);
  buf.writeUInt8(0xc3, textOff + textSize - 1);

  // Program headers
  const ph = (i: number, type: number, flags: number, off: number, vaddr: bigint, filesz: number, memsz: number) => {
    const p = phoff + i * phentsize;
    buf.writeUInt32LE(type, p);
    buf.writeUInt32LE(flags, p + 4);
    buf.writeBigUInt64LE(BigInt(off), p + 8);
    buf.writeBigUInt64LE(vaddr, p + 16);
    buf.writeBigUInt64LE(vaddr, p + 24); // p_paddr
    buf.writeBigUInt64LE(BigInt(filesz), p + 32);
    buf.writeBigUInt64LE(BigInt(memsz), p + 40);
    buf.writeBigUInt64LE(0x1000n, p + 48);
  };
  ph(0, 1, 5, 0, ELF_LOAD_VA, total, total); // PT_LOAD RX
  ph(1, 2, 6, dynamicOff, ELF_LOAD_VA + BigInt(dynamicOff), dyn.length, dyn.length); // PT_DYNAMIC RW
  ph(2, 3, 4, interpOff, ELF_LOAD_VA + BigInt(interpOff), interp.length, interp.length); // PT_INTERP
  ph(3, 0x6474e551, 6, 0, 0n, 0, 0); // PT_GNU_STACK RW (NX)
  ph(4, 0x6474e552, 4, dynamicOff, ELF_LOAD_VA + BigInt(dynamicOff), dyn.length, dyn.length); // PT_GNU_RELRO

  interp.copy(buf, interpOff);
  dynstr.copy(buf, dynstrOff);
  dynsym.copy(buf, dynsymOff);
  dynEnt(0, 1n, 1n); // DT_NEEDED → "libc.so.6"
  dynEnt(1, 5n, dynstrVa); // DT_STRTAB
  dynEnt(2, 10n, BigInt(dynstr.length)); // DT_STRSZ
  dynEnt(3, 0x6ffffffbn, 1n); // DT_FLAGS_1 = NOW (full RELRO)
  dynEnt(4, 0n, 0n); // DT_NULL
  dyn.copy(buf, dynamicOff);
  shstr.copy(buf, shstrOff);

  // Section headers
  const sh = (i: number, nameOff: number, type: number, flags: bigint, addr: bigint, off: number, size: number, link: number, entsize: number) => {
    const p = shoff + i * shentsize;
    buf.writeUInt32LE(nameOff, p);
    buf.writeUInt32LE(type, p + 4);
    buf.writeBigUInt64LE(flags, p + 8);
    buf.writeBigUInt64LE(addr, p + 16);
    buf.writeBigUInt64LE(BigInt(off), p + 24);
    buf.writeBigUInt64LE(BigInt(size), p + 32);
    buf.writeUInt32LE(link, p + 40);
    buf.writeUInt32LE(0, p + 44); // sh_info
    buf.writeBigUInt64LE(8n, p + 48); // sh_addralign
    buf.writeBigUInt64LE(BigInt(entsize), p + 56);
  };
  sh(0, 0, 0, 0n, 0n, 0, 0, 0, 0); // NULL
  sh(1, 1, 1, 2n, ELF_LOAD_VA + BigInt(interpOff), interpOff, interp.length, 0, 0); // .interp PROGBITS ALLOC
  sh(2, 9, 3, 2n, dynstrVa, dynstrOff, dynstr.length, 0, 0); // .dynstr STRTAB
  sh(3, 17, 11, 2n, ELF_LOAD_VA + BigInt(dynsymOff), dynsymOff, dynsym.length, 2, 24); // .dynsym → link .dynstr
  sh(4, 25, 6, 3n, ELF_LOAD_VA + BigInt(dynamicOff), dynamicOff, dyn.length, 2, 16); // .dynamic → link .dynstr
  sh(5, 34, 3, 0n, 0n, shstrOff, shstr.length, 0, 0); // .shstrtab
  sh(6, 44, 1, 6n, ELF_LOAD_VA + BigInt(textOff), textOff, textSize, 0, 0); // .text PROGBITS ALLOC|EXEC
  return buf;
}

// ── PE32+ DLL fixture ───────────────────────────────────────────────────────
// One .text section (RX) holding import descriptors, thunks, hint/name strings,
// export directory + names, and a little code. DllCharacteristics = ASLR|NX|CFG|
// high-entropy. Imports KERNEL32.dll (GetProcAddress, LoadLibraryA); exports
// "MyExport". No COFF symbol table (stripped) — a second fixture adds one.
const PE_IMAGE_BASE = 0x180000000n;
const PE_SECTION_RVA = 0x1000;
const PE_SECTION_FILE = 0x400;

function buildPe32Plus(withSymbols = false): Buffer {
  const headersSize = PE_SECTION_FILE; // 0x400
  const secRawSize = 0x600;
  // The COFF symbol table + string table sit at the end of the file; extend the
  // section's raw data to cover them so RVA/offset bounds checks pass.
  const symExtra = withSymbols ? 2 * 18 + 28 : 0;
  const total = headersSize + secRawSize + symExtra;
  const rawSize = secRawSize + symExtra;
  const buf = Buffer.alloc(total);
  const R = (rva: number) => PE_SECTION_FILE + (rva - PE_SECTION_RVA); // rva→file within .text

  // DOS header
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
  const nt = 0x80;
  buf.write('PE\0\0', nt, 'latin1');
  const coff = nt + 4;
  buf.writeUInt16LE(0x8664, coff); // AMD64
  buf.writeUInt16LE(1, coff + 2); // 1 section
  buf.writeUInt32LE(0x65000000, coff + 4); // timestamp
  const symCount = withSymbols ? 2 : 0;
  const symTabOff = withSymbols ? total - symExtra : 0;
  buf.writeUInt32LE(symTabOff, coff + 8); // PointerToSymbolTable
  buf.writeUInt32LE(symCount, coff + 12);
  buf.writeUInt16LE(240, coff + 16); // SizeOfOptionalHeader (PE32+)
  buf.writeUInt16LE(0x2022, coff + 18); // DLL|EXECUTABLE|LARGE_ADDRESS_AWARE

  const opt = coff + 20;
  buf.writeUInt16LE(0x20b, opt); // PE32+ magic
  buf.writeUInt8(14, opt + 2); // linker major
  buf.writeUInt32LE(rawSize, opt + 4); // SizeOfCode
  buf.writeUInt32LE(PE_SECTION_RVA, opt + 16); // AddressOfEntryPoint
  buf.writeUInt32LE(PE_SECTION_RVA, opt + 20); // BaseOfCode
  buf.writeBigUInt64LE(PE_IMAGE_BASE, opt + 24); // ImageBase
  buf.writeUInt32LE(0x1000, opt + 32); // SectionAlignment
  buf.writeUInt32LE(0x200, opt + 36); // FileAlignment
  buf.writeUInt16LE(6, opt + 40); // MajorOSVersion
  buf.writeUInt16LE(6, opt + 48); // MajorSubsystemVersion
  buf.writeUInt32LE(PE_SECTION_RVA + secRawSize, opt + 56); // SizeOfImage (virtual)
  buf.writeUInt32LE(headersSize, opt + 60); // SizeOfHeaders
  buf.writeUInt16LE(3, opt + 68); // Subsystem WINDOWS_CUI
  buf.writeUInt16LE(0x4160, opt + 70); // DllCharacteristics: HIGH_ENTROPY|DYNAMIC_BASE|NX|GUARD_CF
  buf.writeBigUInt64LE(0x100000n, opt + 72); // SizeOfStackReserve
  buf.writeBigUInt64LE(0x1000n, opt + 80);
  buf.writeBigUInt64LE(0x100000n, opt + 88);
  buf.writeBigUInt64LE(0x1000n, opt + 96);
  buf.writeUInt32LE(16, opt + 108); // NumberOfRvaAndSizes
  const dd = opt + 112;

  // Data directories: export(0), import(1)
  const exportRva = PE_SECTION_RVA + 0x0;
  const importRva = PE_SECTION_RVA + 0x100;
  buf.writeUInt32LE(exportRva, dd + 0); // export RVA
  buf.writeUInt32LE(40, dd + 4);
  buf.writeUInt32LE(importRva, dd + 8); // import RVA
  buf.writeUInt32LE(40, dd + 12);

  // Section header (.text)
  const sh = opt + 240;
  buf.write('.text\0\0\0', sh, 'latin1');
  buf.writeUInt32LE(secRawSize, sh + 8); // VirtualSize
  buf.writeUInt32LE(PE_SECTION_RVA, sh + 12);
  buf.writeUInt32LE(rawSize, sh + 16); // SizeOfRawData
  buf.writeUInt32LE(PE_SECTION_FILE, sh + 20);
  buf.writeUInt32LE(0x60000020, sh + 36); // CODE|EXEC|READ

  // ── Export directory at exportRva ──
  const e = R(exportRva);
  const funcRva = PE_SECTION_RVA + 0x50; // AddressOfFunctions (1 entry)
  const namePtrRva = PE_SECTION_RVA + 0x60; // AddressOfNames (1 entry)
  const ordRva = PE_SECTION_RVA + 0x70; // AddressOfNameOrdinals
  const myExportStrRva = PE_SECTION_RVA + 0x80;
  const dllNameStrRva = PE_SECTION_RVA + 0x90;
  buf.writeUInt32LE(dllNameStrRva, e + 12); // Name
  buf.writeUInt32LE(1, e + 16); // Base
  buf.writeUInt32LE(1, e + 20); // NumberOfFunctions
  buf.writeUInt32LE(1, e + 24); // NumberOfNames
  buf.writeUInt32LE(funcRva, e + 28);
  buf.writeUInt32LE(namePtrRva, e + 32);
  buf.writeUInt32LE(ordRva, e + 36);
  buf.writeUInt32LE(PE_SECTION_RVA, R(funcRva)); // function[0] RVA = entry
  buf.writeUInt32LE(myExportStrRva, R(namePtrRva)); // names[0] → "MyExport"
  buf.writeUInt16LE(0, R(ordRva)); // ordinal[0]
  buf.write('MyExport\0', R(myExportStrRva), 'latin1');
  buf.write('fixture.dll\0', R(dllNameStrRva), 'latin1');

  // ── Import directory at importRva (1 descriptor + terminator) ──
  const i = R(importRva);
  const oftRva = PE_SECTION_RVA + 0x140; // OriginalFirstThunk array
  const dllStrRva = PE_SECTION_RVA + 0x160;
  const hn1Rva = PE_SECTION_RVA + 0x180;
  const hn2Rva = PE_SECTION_RVA + 0x1a0;
  buf.writeUInt32LE(oftRva, i + 0); // OriginalFirstThunk
  buf.writeUInt32LE(dllStrRva, i + 12); // Name
  buf.writeUInt32LE(oftRva, i + 16); // FirstThunk
  // descriptor[1] terminator already zero
  buf.write('KERNEL32.dll\0', R(dllStrRva), 'latin1');
  const oft = R(oftRva);
  buf.writeBigUInt64LE(BigInt(hn1Rva), oft); // thunk[0] → hint/name
  buf.writeBigUInt64LE(BigInt(hn2Rva), oft + 8);
  buf.writeBigUInt64LE(0n, oft + 16); // terminator
  buf.writeUInt16LE(0, R(hn1Rva)); // hint
  buf.write('GetProcAddress\0', R(hn1Rva) + 2, 'latin1');
  buf.writeUInt16LE(0, R(hn2Rva));
  buf.write('LoadLibraryA\0', R(hn2Rva) + 2, 'latin1');

  // ── Optional COFF symbol table (appended after section raw data region) ──
  if (withSymbols) {
    // Place symbols inside the file but after the used .text content; the section
    // raw size covers them so bounds checks pass. symTabOff computed above.
    const strTab = symTabOff + symCount * 18;
    const longName = 'a_very_long_symbol_name\0';
    buf.writeUInt32LE(4 + longName.length, strTab); // string table size
    buf.write(longName, strTab + 4, 'latin1');
    // sym[0]: short name "main", section 1, EXTERNAL
    const s0 = symTabOff;
    buf.write('main\0\0\0\0', s0, 'latin1');
    buf.writeUInt32LE(0x10, s0 + 8); // Value
    buf.writeInt16LE(1, s0 + 12); // SectionNumber
    buf.writeUInt16LE(0x20, s0 + 14); // Type = function
    buf.writeUInt8(2, s0 + 16); // StorageClass EXTERNAL
    buf.writeUInt8(0, s0 + 17);
    // sym[1]: long name via string table offset 4
    const s1 = symTabOff + 18;
    buf.writeUInt32LE(0, s1); // zeroes → long name
    buf.writeUInt32LE(4, s1 + 4); // offset into string table
    buf.writeUInt32LE(0x20, s1 + 8);
    buf.writeInt16LE(1, s1 + 12);
    buf.writeUInt16LE(0x20, s1 + 14);
    buf.writeUInt8(2, s1 + 16);
    buf.writeUInt8(0, s1 + 17);
  }
  return buf;
}

// ── ELF parser unit tests ───────────────────────────────────────────────────
test('elf: parseElf reads header, segments, sections, dynamic, hardening', () => {
  const buf = buildElf64();
  assert.ok(isElf(buf));
  const info = parseElf(buf);
  assert.equal(info.format, 'elf');
  assert.equal(info.class, 64);
  assert.equal(info.endian, 'little');
  assert.equal(info.archName, 'x86_64');
  assert.equal(info.typeName, 'ET_EXEC');
  assert.equal(info.entry, ELF_ENTRY);
  assert.equal(info.segments.length, 5);
  assert.equal(info.interpreter, '/lib64/ld-linux-x86-64.so.2');
  assert.deepEqual(info.libs, [{ name: 'libc.so.6', kind: 'NEEDED' }]);
  assert.equal(info.hardening.nx, true);
  assert.equal(info.hardening.relro, 'full');
  assert.equal(info.hardening.pie, false); // ET_EXEC, not ET_DYN
  assert.equal(info.hardening.canary, true); // __stack_chk_fail present
  assert.equal(info.dynsymCount, 2);
  assert.equal(info.stripped, true); // no .symtab
  const names = info.sections.map((s) => s.name);
  assert.ok(names.includes('.dynstr') && names.includes('.dynsym') && names.includes('.dynamic'));
});

test('elf: scanSymbols finds main + __stack_chk_fail with correct binding', () => {
  const buf = buildElf64();
  const info = parseElf(buf);
  const scan = elfScanSymbols(buf, info, 100);
  assert.equal(scan.totalNamed, 2);
  const main = scan.symbols.find((s) => s.name === 'main')!;
  assert.equal(main.typeName, 'FUNC');
  assert.equal(main.bindName, 'GLOBAL');
  assert.equal(main.sectionDefined, true);
  assert.equal(main.valueHex, '0x' + ELF_MAIN_VA.toString(16));
  const chk = scan.symbols.find((s) => s.name === '__stack_chk_fail')!;
  assert.equal(chk.sectionDefined, false); // UND
});

test('elf: vaToOffset / offsetToVa round-trip through PT_LOAD', () => {
  const buf = buildElf64();
  const info = parseElf(buf);
  const m = elfVaToOffset(info, ELF_MAIN_VA);
  assert.ok(m);
  assert.equal(m!.offset, Number(ELF_MAIN_VA - ELF_LOAD_VA));
  const back = elfOffsetToVa(info, m!.offset);
  assert.ok(back);
  assert.equal(back!.va, ELF_MAIN_VA);
  assert.equal(elfVaToOffset(info, 0xdeadbeefn), null);
});

test('elf: malformed headers fail closed', () => {
  const buf = buildElf64();
  // Truncate mid-header.
  assert.throws(() => parseElf(buf.subarray(0, 20)), ElfError);
  // Bad class byte.
  const bad = Buffer.from(buf);
  bad.writeUInt8(9, 4);
  assert.throws(() => parseElf(bad), (e: unknown) => e instanceof ElfError && e.code === 'unsupported');
  // Program header count overflow.
  const overflow = Buffer.from(buf);
  overflow.writeUInt16LE(0xffff, 56);
  assert.throws(() => parseElf(overflow), ElfError);
});

// ── PE parser unit tests ────────────────────────────────────────────────────
test('pe: parsePe reads headers, sections, imports, exports, hardening', () => {
  const buf = buildPe32Plus();
  assert.ok(isPe(buf));
  const info = parsePe(buf);
  assert.equal(info.format, 'pe');
  assert.equal(info.peClass, 'PE32+');
  assert.equal(info.archName, 'x86_64');
  assert.equal(info.isDll, true);
  assert.equal(info.imageBase, PE_IMAGE_BASE);
  assert.equal(info.entryVa, PE_IMAGE_BASE + BigInt(PE_SECTION_RVA));
  assert.equal(info.sections.length, 1);
  assert.equal(info.sections[0].name, '.text');
  assert.equal(info.hardening.aslr, true);
  assert.equal(info.hardening.nx, true);
  assert.equal(info.hardening.cfg, true);
  assert.equal(info.hardening.highEntropyAslr, true);
  assert.equal(info.imports.length, 1);
  assert.equal(info.imports[0].dll, 'KERNEL32.dll');
  assert.deepEqual(info.imports[0].functions, ['GetProcAddress', 'LoadLibraryA']);
  assert.ok(info.exports);
  assert.equal(info.exports!.dllName, 'fixture.dll');
  assert.deepEqual(info.exports!.names, ['MyExport']);
  assert.equal(info.stripped, true);
});

test('pe: COFF symbol table parsed when present (short + long names)', () => {
  const buf = buildPe32Plus(true);
  const info = parsePe(buf);
  assert.equal(info.symbolCount, 2);
  assert.equal(info.stripped, false);
  const scan = peScanSymbols(buf, info, 100);
  assert.equal(scan.totalNamed, 2);
  const names = scan.symbols.map((s) => s.name).sort();
  assert.deepEqual(names, ['a_very_long_symbol_name', 'main']);
  assert.ok(scan.symbols.every((s) => s.storageClassName === 'EXTERNAL'));
});

test('pe: vaToOffset accepts absolute VA and bare RVA', () => {
  const buf = buildPe32Plus();
  const info = parsePe(buf);
  const abs = peVaToOffset(info, PE_IMAGE_BASE + BigInt(PE_SECTION_RVA));
  const rva = peVaToOffset(info, BigInt(PE_SECTION_RVA));
  assert.ok(abs && rva);
  assert.equal(abs!.offset, PE_SECTION_FILE);
  assert.equal(rva!.offset, PE_SECTION_FILE);
  const back = peOffsetToVa(info, PE_SECTION_FILE);
  assert.ok(back);
  assert.equal(back!.va, PE_IMAGE_BASE + BigInt(PE_SECTION_RVA));
});

test('pe: malformed headers fail closed', () => {
  const buf = buildPe32Plus();
  assert.throws(() => parsePe(buf.subarray(0, 10)), PeError);
  const badSig = Buffer.from(buf);
  badSig.write('XX\0\0', 0x80, 'latin1');
  assert.throws(() => parsePe(badSig), (e: unknown) => e instanceof PeError && e.code === 'unsupported');
  const badMagic = Buffer.from(buf);
  badMagic.writeUInt16LE(0x999, 0x80 + 4 + 20);
  assert.throws(() => parsePe(badMagic), PeError);
});

// ── Tool-level dispatch tests ───────────────────────────────────────────────
test('bin_recon: ELF layout/info/symbols/bytes/va_to_offset via dispatch', async () => {
  const ws = workspace();
  try {
    const p = join(ws, 'sample.elf');
    writeFileSync(p, buildElf64());
    const ctx = ctxFor(ws);
    const lay = await binRecon.run({ action: 'layout', path: 'sample.elf' }, ctx);
    assert.equal(lay.ok, true);
    assert.equal((lay.data as any).kind, 'elf');
    assert.equal((lay.data as any).slices[0].archName, 'x86_64');

    const info = await binRecon.run({ action: 'info', path: 'sample.elf' }, ctx);
    assert.equal(info.ok, true);
    assert.equal((info.data as any).hardening.relro, 'full');
    assert.equal((info.data as any).libs[0].name, 'libc.so.6');

    const sym = await binRecon.run({ action: 'symbols', path: 'sample.elf', filter: 'main' }, ctx);
    assert.equal(sym.ok, true);
    assert.equal((sym.data as any).totalMatched, 1);
    assert.equal((sym.data as any).symbols[0].name, 'main');

    const bytes = await binRecon.run({ action: 'bytes', path: 'sample.elf', va: '0x401000', count: 8 }, ctx);
    assert.equal(bytes.ok, true);
    assert.equal((bytes.data as any).fileOffset, 0x1000);

    const v2o = await binRecon.run({ action: 'va_to_offset', path: 'sample.elf', va: '0x401000' }, ctx);
    assert.equal((v2o.data as any).offset, 0x1000);
    const o2v = await binRecon.run({ action: 'offset_to_va', path: 'sample.elf', offset: 0x1000 }, ctx);
    assert.equal((o2v.data as any).va, '0x401000');

    const ent = await binRecon.run({ action: 'entitlements', path: 'sample.elf' }, ctx);
    assert.equal(ent.ok, true);
    assert.equal((ent.data as any).entitlements, null);

    const unmapped = await binRecon.run({ action: 'va_to_offset', path: 'sample.elf', va: '0xdeadbeef' }, ctx);
    assert.equal(unmapped.ok, false);
    assert.equal(unmapped.error!.code, 'va_unmapped');

    const badArch = await binRecon.run({ action: 'info', path: 'sample.elf', arch: 'arm64' }, ctx);
    assert.equal(badArch.ok, false);
    assert.equal(badArch.error!.code, 'unknown_arch');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('bin_recon: PE layout/info/symbols/imports via dispatch', async () => {
  const ws = workspace();
  try {
    const p = join(ws, 'sample.dll');
    writeFileSync(p, buildPe32Plus(true));
    const ctx = ctxFor(ws);
    const lay = await binRecon.run({ action: 'layout', path: 'sample.dll' }, ctx);
    assert.equal(lay.ok, true);
    assert.equal((lay.data as any).kind, 'pe');
    assert.equal((lay.data as any).slices[0].peClass, 'PE32+');

    const info = await binRecon.run({ action: 'info', path: 'sample.dll' }, ctx);
    assert.equal(info.ok, true);
    assert.equal((info.data as any).imports[0].dll, 'KERNEL32.dll');
    assert.equal((info.data as any).exports.names[0], 'MyExport');
    assert.equal((info.data as any).hardening.cfg, true);

    const sym = await binRecon.run({ action: 'symbols', path: 'sample.dll' }, ctx);
    assert.equal(sym.ok, true);
    assert.equal((sym.data as any).totalNamed, 2);

    const v2o = await binRecon.run({ action: 'va_to_offset', path: 'sample.dll', va: '0x180001000' }, ctx);
    assert.equal(v2o.ok, true);
    assert.equal((v2o.data as any).offset, 0x400);

    const ent = await binRecon.run({ action: 'entitlements', path: 'sample.dll' }, ctx);
    assert.equal((ent.data as any).entitlements, null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('bin_recon: non-binary file still fails honestly (no format detected)', async () => {
  const ws = workspace();
  try {
    writeFileSync(join(ws, 'plain.txt'), 'just text, not a binary\n');
    const res = await binRecon.run({ action: 'layout', path: 'plain.txt' }, ctxFor(ws));
    assert.equal(res.ok, false);
    assert.equal(res.error!.code, 'not_macho');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── PE import global budget (CPU-DoS regression) ────────────────────────────────────
// A crafted image can declare thousands of import descriptors, each pointing at a huge
// thunk array. The per-DLL cap alone lets that multiply into ~10^12 operations. The global
// budget must bound total imported functions and return quickly with truncation flagged.
function buildManyDllPe(dllCount: number, thunksPerDll: number): Buffer {
  const sectionRawSize = 0x80000; // 512 KiB of section data
  const fileSize = 0x400 + sectionRawSize;
  const buf = Buffer.alloc(fileSize, 0);
  const R = (rva: number) => rva - PE_SECTION_RVA + 0x400; // RVA -> file offset

  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  const coff = 0x84;
  buf.writeUInt16LE(0x14c, coff); // I386 (PE32)
  buf.writeUInt16LE(1, coff + 2); // one section
  buf.writeUInt16LE(0xe0, coff + 16);
  buf.writeUInt16LE(0x0102, coff + 18);
  const opt = coff + 20;
  buf.writeUInt16LE(0x10b, opt); // PE32
  buf.writeUInt32LE(0x1000, opt + 16);
  buf.writeUInt32LE(0x400000, opt + 28);
  buf.writeUInt32LE(0x1000, opt + 32);
  buf.writeUInt32LE(0x200, opt + 36);
  buf.writeUInt16LE(3, opt + 68);
  buf.writeUInt32LE(16, opt + 92);
  // One section covering the whole crafted blob.
  const sec = opt + 0xe0;
  buf.write('.rdata', sec, 'ascii');
  buf.writeUInt32LE(sectionRawSize, sec + 8);
  buf.writeUInt32LE(PE_SECTION_RVA, sec + 12);
  buf.writeUInt32LE(sectionRawSize, sec + 16);
  buf.writeUInt32LE(0x400, sec + 20);
  buf.writeUInt32LE(0x40000040, sec + 36);

  // Import descriptors start at section RVA; each is 20 bytes, null-terminated.
  const importRva = PE_SECTION_RVA;
  buf.writeUInt32LE(importRva, opt + 96 + 1 * 8); // import directory RVA
  buf.writeUInt32LE((dllCount + 1) * 20, opt + 96 + 1 * 8 + 4);
  // Thunk arrays live after the descriptors; each DLL gets its own zero-terminated array
  // of `thunksPerDll` ordinal-flagged thunks (no name lookups needed).
  const thunkBaseRva = importRva + (dllCount + 1) * 20;
  for (let d = 0; d < dllCount; d++) {
    const descOff = R(importRva + d * 20);
    const thunkRva = thunkBaseRva + d * (thunksPerDll + 1) * 4;
    buf.writeUInt32LE(thunkRva, descOff); // OriginalFirstThunk
    buf.writeUInt32LE(thunkRva, descOff + 16); // FirstThunk
    // DLL name string (reuse a fixed name region per descriptor).
    buf.writeUInt32LE(importRva + (dllCount + 1) * 20 + dllCount * (thunksPerDll + 1) * 4 + d * 8, descOff + 12);
    const tOff = R(thunkRva);
    for (let t = 0; t < thunksPerDll; t++) {
      buf.writeUInt32LE((0x80000000 | (t & 0xffff)) >>> 0, tOff + t * 4); // ordinal import
    }
    // terminator already zero
  }
  return buf;
}

test('parsePe: crafted many-DLL import table is bounded by the global budget (no CPU DoS)', () => {
  // 200 DLLs × 400 thunks = 80k declared imports — above the 65536 global budget.
  // Without the global budget every DLL would be walked (the per-DLL cap alone allows
  // 4096 × 65536 ≈ 2.7×10^8 operations); with it, the walk stops mid-table.
  const buf = buildManyDllPe(200, 400);
  const start = Date.now();
  const info = parsePe(buf);
  const elapsed = Date.now() - start;
  const totalFuncs = info.imports.reduce((n, e) => n + e.functions.length, 0);
  assert.ok(totalFuncs <= MAX_PE_IMPORT_FUNCS_TOTAL, `total imports ${totalFuncs} must be <= global budget`);
  assert.ok(info.imports.some((e) => e.truncated), 'budget exhaustion must flag truncation');
  // Structural proof the OUTER loop stopped on budget exhaustion: not all 200 DLLs parsed.
  assert.ok(info.imports.length < 200, `expected early stop, parsed ${info.imports.length}/200 DLLs`);
  // Generous wall-clock guard for CI headroom; the bounded walk is well under a second.
  assert.ok(elapsed < 5000, `parse took ${elapsed}ms — global budget may not be bounding work`);
});