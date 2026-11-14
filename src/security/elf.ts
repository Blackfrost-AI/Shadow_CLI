// Pure ELF parser for `bin_recon`. No execution, no shell-out, no writes.
//
// Covers ELF32/ELF64 in both endiannesses: header, program headers, sections,
// .dynamic (DT_NEEDED / DT_SONAME / DT_RPATH / DT_RUNPATH), .symtab + .dynsym with
// their string tables, and VA↔offset mapping via PT_LOAD segments and sections.
// Every field is bounds-checked against the actual buffer length; hostile headers
// fail closed with a typed ElfError instead of reading out of bounds.
//
// Mirrors the output shapes of src/security/macho.ts (SegmentInfo-like segments,
// SymbolEntry/SymbolScan, VaMapping) so the tool layer can render both formats
// with one contract. ELF has no fat/universal container: one file, one image.

export const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF

export const MAX_ELF_PROGRAM_HEADERS = 4096;
export const MAX_ELF_SECTIONS = 4096;
export const MAX_ELF_SYMBOLS = 2_000_000;
export const MAX_ELF_DYNAMIC_ENTRIES = 65_536;
const MAX_ELF_STRING = 4096;

export class ElfError extends Error {
  constructor(
    public readonly code: 'unsupported' | 'malformed' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'ElfError';
  }
}

export interface ElfSegmentInfo {
  type: number;
  typeName: string;
  flags: number;
  flagsText: string; // e.g. "RWX"
  offset: number;
  vaddr: bigint;
  filesz: number;
  memsz: number;
  align: bigint;
}

export interface ElfSectionInfo {
  index: number;
  name: string;
  type: number;
  typeName: string;
  flags: bigint;
  addr: bigint;
  offset: number;
  size: number;
  link: number;
  entsize: number;
}

export interface ElfDynamicEntry {
  tag: number;
  tagName: string;
  value: bigint;
  /** Decoded string for DT_NEEDED/DT_SONAME/DT_RPATH/DT_RUNPATH; null otherwise. */
  str: string | null;
}

export interface ElfLibEntry {
  name: string;
  kind: string; // 'NEEDED' | 'SONAME'
}

export interface ElfInfo {
  format: 'elf';
  class: 32 | 64;
  endian: 'little' | 'big';
  archName: string;
  machine: number;
  type: number;
  typeName: string;
  entry: bigint;
  flags: number;
  segments: ElfSegmentInfo[];
  sections: ElfSectionInfo[];
  dynamic: ElfDynamicEntry[];
  libs: ElfLibEntry[];
  rpaths: string[]; // DT_RPATH + DT_RUNPATH, in encounter order
  interpreter: string | null;
  symtabCount: number;
  dynsymCount: number;
  stripped: boolean;
  hardening: {
    nx: boolean; // GNU_STACK not executable
    relro: 'none' | 'partial' | 'full';
    pie: boolean; // ET_DYN with an INTERP or dynamic section
    canary: boolean; // __stack_chk_fail referenced
  };
}

export interface ElfVaMapping {
  /** Absolute file offset the VA maps to. */
  offset: number;
  segment: string; // PT_LOAD index label or section name
  section?: string;
}

export interface ElfSymbolEntry {
  name: string;
  valueHex: string;
  size: number;
  info: number;
  other: number;
  shndx: number;
  table: 'symtab' | 'dynsym';
  bindName: string;
  typeName: string;
  external: boolean; // defined here (shndx != SHN_UNDEF)
  sectionDefined: boolean;
}

export interface ElfSymbolScan {
  symbols: ElfSymbolEntry[];
  totalNamed: number;
  totalMatched: number;
}

const ET_NAMES: Record<number, string> = {
  0: 'ET_NONE',
  1: 'ET_REL',
  2: 'ET_EXEC',
  3: 'ET_DYN',
  4: 'ET_CORE',
};

const PT_NAMES: Record<number, string> = {
  0: 'PT_NULL',
  1: 'PT_LOAD',
  2: 'PT_DYNAMIC',
  3: 'PT_INTERP',
  4: 'PT_NOTE',
  5: 'PT_SHLIB',
  6: 'PT_PHDR',
  7: 'PT_TLS',
  0x6474e550: 'PT_GNU_EH_FRAME',
  0x6474e551: 'PT_GNU_STACK',
  0x6474e552: 'PT_GNU_RELRO',
  0x6474e553: 'PT_GNU_PROPERTY',
};

const SHT_NAMES: Record<number, string> = {
  0: 'SHT_NULL',
  1: 'SHT_PROGBITS',
  2: 'SHT_SYMTAB',
  3: 'SHT_STRTAB',
  4: 'SHT_RELA',
  5: 'SHT_HASH',
  6: 'SHT_DYNAMIC',
  7: 'SHT_NOTE',
  8: 'SHT_NOBITS',
  9: 'SHT_REL',
  11: 'SHT_DYNSYM',
  14: 'SHT_INIT_ARRAY',
  15: 'SHT_FINI_ARRAY',
  0x6ffffff6: 'SHT_GNU_HASH',
  0x6fffffff: 'SHT_GNU_VERSYM',
  0x6ffffffd: 'SHT_GNU_VERDEF',
  0x6ffffffe: 'SHT_GNU_VERNEED',
};

const DT_NAMES: Record<number, string> = {
  0: 'DT_NULL',
  1: 'DT_NEEDED',
  2: 'DT_PLTRELSZ',
  3: 'DT_PLTGOT',
  4: 'DT_HASH',
  5: 'DT_STRTAB',
  6: 'DT_SYMTAB',
  7: 'DT_RELA',
  8: 'DT_RELASZ',
  9: 'DT_RELAENT',
  10: 'DT_STRSZ',
  11: 'DT_SYMENT',
  12: 'DT_INIT',
  13: 'DT_FINI',
  14: 'DT_SONAME',
  15: 'DT_RPATH',
  16: 'DT_SYMBOLIC',
  17: 'DT_REL',
  18: 'DT_RELSZ',
  19: 'DT_RELENT',
  20: 'DT_PLTREL',
  21: 'DT_DEBUG',
  22: 'DT_TEXTREL',
  23: 'DT_JMPREL',
  24: 'DT_BIND_NOW',
  25: 'DT_INIT_ARRAY',
  26: 'DT_FINI_ARRAY',
  27: 'DT_INIT_ARRAYSZ',
  28: 'DT_FINI_ARRAYSZ',
  29: 'DT_RUNPATH',
  30: 'DT_FLAGS',
  0x6ffffef5: 'DT_GNU_HASH',
  0x6ffffffb: 'DT_FLAGS_1',
  0x6ffffffe: 'DT_VERNEED',
  0x6fffffff: 'DT_VERNEEDNUM',
  0x6ffffff0: 'DT_VERSYM',
};

const EM_NAMES: Record<number, string> = {
  0: 'none',
  2: 'sparc',
  3: 'x86',
  8: 'mips',
  20: 'ppc',
  21: 'ppc64',
  40: 'arm',
  42: 'superh',
  43: 'sparc64',
  50: 'ia64',
  62: 'x86_64',
  183: 'aarch64',
  243: 'riscv',
  247: 'bpf',
  258: 'loongarch',
};

const STB_NAMES = ['LOCAL', 'GLOBAL', 'WEAK'];
const STT_NAMES = [
  'NOTYPE',
  'OBJECT',
  'FUNC',
  'SECTION',
  'FILE',
  'COMMON',
  'TLS',
];

/** True when the buffer starts with the ELF magic (cheap pre-check for dispatch). */
export function isElf(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ELF_MAGIC);
}

interface Reader {
  u8(off: number): number;
  u16(off: number): number;
  u32(off: number): number;
  u64(off: number): bigint;
  /** Class-sized unsigned (4 bytes for ELF32, 8 for ELF64). */
  word(off: number): bigint;
  need(off: number, len: number, what: string): void;
}

function makeReader(buf: Buffer, little: boolean, is64: boolean): Reader {
  const need = (off: number, len: number, what: string): void => {
    if (off < 0 || len < 0 || off > buf.length || len > buf.length - off) {
      throw new ElfError('malformed', `${what} extends past end of file (off=${off}, len=${len}).`);
    }
  };
  return {
    need,
    u8: (off) => {
      need(off, 1, 'byte field');
      return buf.readUInt8(off);
    },
    u16: (off) => {
      need(off, 2, '16-bit field');
      return little ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
    },
    u32: (off) => {
      need(off, 4, '32-bit field');
      return little ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
    },
    u64: (off) => {
      need(off, 8, '64-bit field');
      return little ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off);
    },
    word: (off) => {
      need(off, is64 ? 8 : 4, 'class-sized field');
      return is64
        ? little
          ? buf.readBigUInt64LE(off)
          : buf.readBigUInt64BE(off)
        : BigInt(little ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
    },
  };
}

/** Bounded NUL-terminated string read; never runs past the buffer or maxLen. */
function cstr(buf: Buffer, off: number, maxLen: number): string {
  if (off < 0 || off >= buf.length) return '';
  const end = Math.min(buf.length, off + maxLen);
  let i = off;
  while (i < end && buf[i] !== 0) i++;
  return buf.toString('utf8', off, i);
}

function fitNumber(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ElfError('malformed', `${what} (${v}) exceeds safe integer range.`);
  }
  return Number(v);
}

/** Parse the full ELF image. Throws ElfError on unsupported/malformed input. */
export function parseElf(buf: Buffer): ElfInfo {
  const r0 = makeReader(buf, true, true); // endian unknown until e_ident
  r0.need(0, 16, 'ELF identification');
  if (!isElf(buf)) throw new ElfError('unsupported', 'Not an ELF image (bad magic).');
  const eiClass = buf.readUInt8(4);
  const eiData = buf.readUInt8(5);
  const eiVersion = buf.readUInt8(6);
  if (eiClass !== 1 && eiClass !== 2) {
    throw new ElfError('unsupported', `Unknown ELF class ${eiClass} (expected 1=32-bit or 2=64-bit).`);
  }
  if (eiData !== 1 && eiData !== 2) {
    throw new ElfError('unsupported', `Unknown ELF data encoding ${eiData}.`);
  }
  if (eiVersion !== 1) throw new ElfError('malformed', `Unsupported e_ident version ${eiVersion}.`);
  const is64 = eiClass === 2;
  const little = eiData === 1;
  const r = makeReader(buf, little, is64);

  const hdrSize = is64 ? 64 : 52;
  r.need(0, hdrSize, 'ELF header');
  const type = r.u16(16);
  const machine = r.u16(18);
  const eVersion = r.u32(20);
  if (eVersion !== 1) throw new ElfError('malformed', `Unsupported ELF version ${eVersion}.`);
  // Layout differs by class: entry/phoff/shoff positions.
  const entry = is64 ? r.u64(24) : BigInt(r.u32(24));
  const phoff = fitNumber(is64 ? r.u64(32) : BigInt(r.u32(28)), 'e_phoff');
  const shoff = fitNumber(is64 ? r.u64(40) : BigInt(r.u32(32)), 'e_shoff');
  const flags = r.u32(is64 ? 48 : 36);
  const ehsize = r.u16(is64 ? 52 : 40);
  const phentsize = r.u16(is64 ? 54 : 42);
  const phnum = r.u16(is64 ? 56 : 44);
  const shentsize = r.u16(is64 ? 58 : 46);
  const shnumRaw = r.u16(is64 ? 60 : 48);
  const shstrndxRaw = r.u16(is64 ? 62 : 50);
  if (ehsize < hdrSize) throw new ElfError('malformed', `e_ehsize ${ehsize} smaller than header.`);
  if (phnum > MAX_ELF_PROGRAM_HEADERS) {
    throw new ElfError('malformed', `Program header count ${phnum} exceeds cap ${MAX_ELF_PROGRAM_HEADERS}.`);
  }
  const expectedPhentsize = is64 ? 56 : 32;
  if (phnum > 0 && phentsize < expectedPhentsize) {
    throw new ElfError('malformed', `e_phentsize ${phentsize} smaller than ${expectedPhentsize}.`);
  }

  // ── Program headers ──────────────────────────────────────────────────────
  const segments: ElfSegmentInfo[] = [];
  let interp: string | null = null;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    r.need(p, expectedPhentsize, `program header ${i}`);
    const pType = r.u32(p);
    let pFlags: number, pOffset: number, pVaddr: bigint, pFilesz: number, pMemsz: number, pAlign: bigint;
    if (is64) {
      pFlags = r.u32(p + 4);
      pOffset = fitNumber(r.u64(p + 8), 'p_offset');
      pVaddr = r.u64(p + 16);
      pFilesz = fitNumber(r.u64(p + 32), 'p_filesz');
      pMemsz = fitNumber(r.u64(p + 40), 'p_memsz');
      pAlign = r.u64(p + 48);
    } else {
      pOffset = r.u32(p + 4);
      pVaddr = BigInt(r.u32(p + 8));
      pFilesz = r.u32(p + 16);
      pMemsz = r.u32(p + 20);
      pFlags = r.u32(p + 24);
      pAlign = BigInt(r.u32(p + 28));
    }
    if (pOffset > buf.length || pFilesz > buf.length - pOffset) {
      throw new ElfError('malformed', `PT segment ${i} file range extends past end of file.`);
    }
    if (pMemsz < pFilesz) {
      throw new ElfError('malformed', `PT segment ${i} memsz < filesz.`);
    }
    const flagsText =
      (pFlags & 4 ? 'R' : '-') + (pFlags & 2 ? 'W' : '-') + (pFlags & 1 ? 'X' : '-');
    segments.push({
      type: pType,
      typeName: PT_NAMES[pType] ?? `PT_0x${pType.toString(16)}`,
      flags: pFlags,
      flagsText,
      offset: pOffset,
      vaddr: pVaddr,
      filesz: pFilesz,
      memsz: pMemsz,
      align: pAlign,
    });
    if (pType === 3 /* PT_INTERP */ && interp === null) {
      interp = cstr(buf, pOffset, Math.min(pFilesz, MAX_ELF_STRING));
    }
  }

  // ── Section headers ──────────────────────────────────────────────────────
  const sections: ElfSectionInfo[] = [];
  let shnum = shnumRaw;
  let shstrndx = shstrndxRaw;
  if (shoff !== 0) {
    const expectedShentsize = is64 ? 64 : 40;
    if (shentsize < expectedShentsize) {
      throw new ElfError('malformed', `e_shentsize ${shentsize} smaller than ${expectedShentsize}.`);
    }
    r.need(shoff, expectedShentsize, 'section header 0');
    // Extended numbering: SHN_XINDEX (0xffff) stores the real count in section 0.
    if (shnum === 0xffff) {
      shnum = r.u32(shoff + (is64 ? 32 : 20));
    }
    if (shstrndx === 0xffff) {
      shstrndx = r.u32(shoff + (is64 ? 40 : 28));
    }
    if (shnum > MAX_ELF_SECTIONS) {
      throw new ElfError('malformed', `Section count ${shnum} exceeds cap ${MAX_ELF_SECTIONS}.`);
    }
    // Read raw section fields first; names resolved after shstrtab is known.
    const raw: Array<{ nameOff: number; s: ElfSectionInfo }> = [];
    for (let i = 0; i < shnum; i++) {
      const p = shoff + i * shentsize;
      r.need(p, expectedShentsize, `section header ${i}`);
      const nameOff = r.u32(p);
      const sType = r.u32(p + 4);
      let sFlags: bigint, sAddr: bigint, sOffset: number, sSize: number, sLink: number, sEntsize: number;
      if (is64) {
        sFlags = r.u64(p + 8);
        sAddr = r.u64(p + 16);
        sOffset = fitNumber(r.u64(p + 24), 'sh_offset');
        sSize = fitNumber(r.u64(p + 32), 'sh_size');
        sLink = r.u32(p + 40);
        sEntsize = fitNumber(r.u64(p + 56), 'sh_entsize');
      } else {
        sFlags = BigInt(r.u32(p + 8));
        sAddr = BigInt(r.u32(p + 12));
        sOffset = r.u32(p + 16);
        sSize = r.u32(p + 20);
        sLink = r.u32(p + 24);
        sEntsize = r.u32(p + 36);
      }
      // SHT_NOBITS (.bss) occupies no file bytes; everything else must fit.
      if (sType !== 8 && (sOffset > buf.length || sSize > buf.length - sOffset)) {
        throw new ElfError('malformed', `Section ${i} file range extends past end of file.`);
      }
      raw.push({
        nameOff,
        s: {
          index: i,
          name: '',
          type: sType,
          typeName: SHT_NAMES[sType] ?? `SHT_0x${sType.toString(16)}`,
          flags: sFlags,
          addr: sAddr,
          offset: sOffset,
          size: sSize,
          link: sLink,
          entsize: sEntsize,
        },
      });
    }
    // Resolve names via the section-header string table.
    let shstr: { offset: number; size: number } | null = null;
    if (shstrndx > 0 && shstrndx < raw.length) {
      const st = raw[shstrndx].s;
      if (st.type === 3) shstr = { offset: st.offset, size: st.size };
    }
    for (const { nameOff, s } of raw) {
      s.name = shstr ? cstr(buf, shstr.offset + nameOff, Math.min(MAX_ELF_STRING, shstr.size)) : '';
      sections.push(s);
    }
  }

  // ── .dynamic ─────────────────────────────────────────────────────────────
  const dynamic: ElfDynamicEntry[] = [];
  const libs: ElfLibEntry[] = [];
  const rpaths: string[] = [];
  const dynSeg = segments.find((s) => s.type === 2 /* PT_DYNAMIC */);
  const dynSec = sections.find((s) => s.type === 6 /* SHT_DYNAMIC */);
  const dynRange = dynSeg
    ? { offset: dynSeg.offset, size: dynSeg.filesz }
    : dynSec
      ? { offset: dynSec.offset, size: dynSec.size }
      : null;
  if (dynRange && dynRange.size > 0) {
    const entSize = is64 ? 16 : 8;
    const count = Math.floor(dynRange.size / entSize);
    if (count > MAX_ELF_DYNAMIC_ENTRIES) {
      throw new ElfError('malformed', `Dynamic table claims ${count} entries (cap ${MAX_ELF_DYNAMIC_ENTRIES}).`);
    }
    // DT_STRTAB is a VA; resolve it to a file offset through the LOAD segments.
    let dynstrOff: number | null = null;
    let dynstrSize = 0;
    const entries: Array<{ tag: number; value: bigint }> = [];
    for (let i = 0; i < count; i++) {
      const p = dynRange.offset + i * entSize;
      r.need(p, entSize, `dynamic entry ${i}`);
      const tag = fitNumber(r.word(p), 'd_tag');
      const value = r.word(p + (is64 ? 8 : 4));
      entries.push({ tag, value });
      if (tag === 0) break; // DT_NULL terminates
      if (tag === 5) {
        // DT_STRTAB
        const m = mapVa(segments, value);
        if (m !== null) dynstrOff = m.offset;
      } else if (tag === 10) {
        dynstrSize = fitNumber(value, 'DT_STRSZ');
      }
    }
    // The dynstr section (if present) is a more direct source than the VA mapping.
    const dynstrSec = sections.find((s) => s.name === '.dynstr' && s.type === 3);
    if (dynstrSec) {
      dynstrOff = dynstrSec.offset;
      dynstrSize = dynstrSec.size;
    }
    for (const { tag, value } of entries) {
      const tagName = DT_NAMES[tag] ?? `DT_0x${tag.toString(16)}`;
      let str: string | null = null;
      if ((tag === 1 || tag === 14 || tag === 15 || tag === 29) && dynstrOff !== null) {
        const off = dynstrOff + fitNumber(value, `${tagName} string offset`);
        str = cstr(buf, off, dynstrSize > 0 ? Math.min(dynstrSize, MAX_ELF_STRING) : MAX_ELF_STRING);
      }
      dynamic.push({ tag, tagName, value, str });
      if (tag === 1 && str) libs.push({ name: str, kind: 'NEEDED' });
      if (tag === 14 && str) libs.push({ name: str, kind: 'SONAME' });
      if ((tag === 15 || tag === 29) && str) rpaths.push(str);
    }
  }

  // ── Symbol tables ────────────────────────────────────────────────────────
  const symtabCount = countSymbols(sections, is64, 2 /* SHT_SYMTAB */);
  const dynsymCount = countSymbols(sections, is64, 11 /* SHT_DYNSYM */);

  // ── Hardening posture ────────────────────────────────────────────────────
  const gnuStack = segments.find((s) => s.type === 0x6474e551);
  const nx = gnuStack ? (gnuStack.flags & 1) === 0 : true; // absent GNU_STACK ⇒ NX on modern loaders
  const hasRelro = segments.some((s) => s.type === 0x6474e552);
  const bindNow = dynamic.some(
    (d) => d.tag === 24 || (d.tag === 30 && (d.value & 8n) !== 0n) || (d.tag === 0x6ffffffb && (d.value & 1n) !== 0n),
  );
  const relro: 'none' | 'partial' | 'full' = !hasRelro ? 'none' : bindNow ? 'full' : 'partial';
  const pie = type === 3 && (interp !== null || dynRange !== null);
  let canary = false;
  for (const secType of [2, 11] as const) {
    if (canary) break;
    const scan = scanElfSymbols(buf, sections, is64, little, secType, 1, (s) => s.name === '__stack_chk_fail');
    canary = scan.totalMatched > 0;
  }

  const archName = EM_NAMES[machine] ?? `em_${machine}`;
  return {
    format: 'elf',
    class: is64 ? 64 : 32,
    endian: little ? 'little' : 'big',
    archName: is64 ? archName : `${archName}32`,
    machine,
    type,
    typeName: ET_NAMES[type] ?? `ET_${type}`,
    entry,
    flags,
    segments,
    sections,
    dynamic,
    libs,
    rpaths,
    interpreter: interp,
    symtabCount,
    dynsymCount,
    stripped: symtabCount === 0,
    hardening: { nx, relro, pie, canary },
  };
}

function symEntSize(is64: boolean): number {
  return is64 ? 24 : 16;
}

function countSymbols(sections: ElfSectionInfo[], is64: boolean, secType: number): number {
  let total = 0;
  for (const s of sections) {
    if (s.type !== secType) continue;
    const ent = s.entsize || symEntSize(is64);
    total += Math.floor(s.size / ent);
  }
  return total;
}

/** Map a virtual address to a file offset via PT_LOAD segments. */
function mapVa(segments: ElfSegmentInfo[], va: bigint): { offset: number; segment: string } | null {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.type !== 1 /* PT_LOAD */) continue;
    if (va >= s.vaddr && va < s.vaddr + BigInt(s.filesz)) {
      return { offset: s.offset + Number(va - s.vaddr), segment: `PT_LOAD[${i}]` };
    }
  }
  return null;
}

/**
 * Scan one symbol-table kind (SHT_SYMTAB or SHT_DYNSYM) across all matching
 * sections. Totals are exact; returned rows capped at `limit`.
 */
export function scanElfSymbols(
  buf: Buffer,
  sections: ElfSectionInfo[],
  is64: boolean,
  little: boolean,
  secType: 2 | 11,
  limit: number,
  predicate?: (s: ElfSymbolEntry) => boolean,
): ElfSymbolScan {
  const r = makeReader(buf, little, is64);
  const ent = symEntSize(is64);
  const symbols: ElfSymbolEntry[] = [];
  let totalNamed = 0;
  let totalMatched = 0;
  const resultLimit = Math.max(0, limit);
  const table = secType === 2 ? 'symtab' : 'dynsym';
  let seen = 0;
  for (const sec of sections) {
    if (sec.type !== secType) continue;
    const strSec = sections[sec.link];
    if (!strSec || strSec.type !== 3) continue; // no usable string table
    const stride = sec.entsize || ent;
    if (stride < ent) continue;
    const count = Math.floor(sec.size / stride);
    if (seen + count > MAX_ELF_SYMBOLS) {
      throw new ElfError('malformed', `Symbol tables exceed cap ${MAX_ELF_SYMBOLS}.`);
    }
    seen += count;
    for (let i = 0; i < count; i++) {
      const p = sec.offset + i * stride;
      r.need(p, ent, `${table} entry ${i}`);
      let nameOff: number, info: number, other: number, shndx: number, value: bigint, size: number;
      if (is64) {
        nameOff = r.u32(p);
        info = r.u8(p + 4);
        other = r.u8(p + 5);
        shndx = r.u16(p + 6);
        value = r.u64(p + 8);
        size = fitNumber(r.u64(p + 16), 'st_size');
      } else {
        nameOff = r.u32(p);
        value = BigInt(r.u32(p + 4));
        size = r.u32(p + 8);
        info = r.u8(p + 12);
        other = r.u8(p + 13);
        shndx = r.u16(p + 14);
      }
      if (nameOff === 0 || nameOff >= strSec.size) continue;
      const name = cstr(buf, strSec.offset + nameOff, Math.min(MAX_ELF_STRING, strSec.size - nameOff));
      if (!name) continue;
      totalNamed++;
      const bind = info >> 4;
      const stt = info & 0xf;
      const sym: ElfSymbolEntry = {
        name,
        valueHex: '0x' + value.toString(16),
        size,
        info,
        other,
        shndx,
        table,
        bindName: STB_NAMES[bind] ?? `STB_${bind}`,
        typeName: STT_NAMES[stt] ?? `STT_${stt}`,
        external: shndx !== 0,
        sectionDefined: shndx !== 0 && shndx < 0xff00,
      };
      if (predicate && !predicate(sym)) continue;
      totalMatched++;
      if (symbols.length < resultLimit) symbols.push(sym);
    }
  }
  return { symbols, totalNamed, totalMatched };
}

/** Scan both symbol tables (symtab first, then dynsym). */
export function scanSymbols(
  buf: Buffer,
  info: ElfInfo,
  limit: number,
  predicate?: (s: ElfSymbolEntry) => boolean,
): ElfSymbolScan {
  const is64 = info.class === 64;
  const little = info.endian === 'little';
  const a = scanElfSymbols(buf, info.sections, is64, little, 2, limit, predicate);
  const remaining = Math.max(0, limit - a.symbols.length);
  const b = scanElfSymbols(buf, info.sections, is64, little, 11, remaining, predicate);
  return {
    symbols: [...a.symbols, ...b.symbols],
    totalNamed: a.totalNamed + b.totalNamed,
    totalMatched: a.totalMatched + b.totalMatched,
  };
}

/** VA → file offset. Prefers a containing section (finer label), falls back to PT_LOAD. */
export function vaToOffset(info: ElfInfo, va: bigint): ElfVaMapping | null {
  for (const s of info.sections) {
    if (s.type === 8 || s.addr === 0n || s.size === 0) continue; // NOBITS / unallocated
    if ((s.flags & 2n) === 0n) continue; // SHF_ALLOC only
    if (va >= s.addr && va < s.addr + BigInt(s.size)) {
      return { offset: s.offset + Number(va - s.addr), segment: s.name || `section[${s.index}]`, section: s.name };
    }
  }
  const m = mapVa(info.segments, va);
  return m ? { offset: m.offset, segment: m.segment } : null;
}

/** File offset → VA. Section first, then PT_LOAD. */
export function offsetToVa(info: ElfInfo, offset: number): { va: bigint; segment: string; section?: string } | null {
  for (const s of info.sections) {
    if (s.type === 8 || s.addr === 0n || s.size === 0) continue;
    if ((s.flags & 2n) === 0n) continue;
    if (offset >= s.offset && offset < s.offset + s.size) {
      return { va: s.addr + BigInt(offset - s.offset), segment: s.name || `section[${s.index}]`, section: s.name };
    }
  }
  for (let i = 0; i < info.segments.length; i++) {
    const s = info.segments[i];
    if (s.type !== 1) continue;
    if (offset >= s.offset && offset < s.offset + s.filesz) {
      return { va: s.vaddr + BigInt(offset - s.offset), segment: `PT_LOAD[${i}]` };
    }
  }
  return null;
}