// Pure Mach-O structure parsing for the redteam binary toolbelt (Phase 1).
//
// Takes Buffers only — no filesystem, no subprocesses, never executes or dlopen()s
// anything inside the target. Every read is bounds-checked against the buffer that was
// actually provided and every count is capped, so a malformed or hostile binary cannot
// force an unbounded loop or an out-of-bounds read. 32-bit Mach-O (0xfeedface) is
// recognized but not mapped: the macOS redteam targets are arm64/x86_64, and keeping
// the 64-bit-only invariant makes the VA math single-shaped.
//
// Offsets inside a fat container are ABSOLUTE (relative to byte 0 of the fat file),
// matching how otool/objdump report slice offsets. VA mapping is only performed
// through the parsed segment table — never by guessing a slide.

export const FAT_MAGIC_32 = 0xcafe_babe; // big-endian on disk: 32-bit slice offsets
export const FAT_MAGIC_64 = 0xcafe_babf; // big-endian on disk: 64-bit slice offsets
export const MH_MAGIC_64 = 0xfeed_facf; // little-endian on disk: 64-bit thin Mach-O
export const MH_MAGIC_32 = 0xfeed_face; // little-endian on disk: 32-bit thin Mach-O (recognized, unsupported)

export const CPU_X86_64 = 0x0100_0007;
export const CPU_ARM64 = 0x0100_000c; // real arm64 (the fat-table value on macOS)
export const CPU_ARM64_32 = 0x0100_000e; // arm64_32 (Apple Watch-era); NOT arm64
export const CPU_ARM64E_SUBTYPE = 2;

export const LC_SEGMENT_64 = 0x19;
export const LC_SYMTAB = 0x02;
export const LC_CODE_SIGNATURE = 0x1d;
export const LC_ID_DYLIB = 0x0d;
export const LC_LOAD_DYLIB = 0x0c;
export const LC_LOAD_WEAK_DYLIB = 0x8000_0018;
export const LC_REEXPORT_DYLIB = 0x8000_001f;

export const CS_MAGIC_EMBEDDED_SIGNATURE = 0xfade_0cc0;
export const CS_MAGIC_EMBEDDED_ENTITLEMENTS = 0xfade_7171;
export const CS_SLOT_ENTITLEMENTS = 5;

export const MAX_LOAD_COMMANDS = 4096;
export const MAX_SECTIONS_PER_SEGMENT = 512;
export const MAX_FAT_SLICES = 16;
export const MAX_SYMBOLS = 2_000_000;

export class MachoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MachoError';
  }
}

export interface FatSlice {
  index: number;
  cpuType: number;
  cpuSubtype: number;
  /** Absolute byte offset of this slice within the buffer the layout was parsed from. */
  offset: number;
  size: number;
  archName: string;
}

export type BinaryLayout = { kind: 'thin'; slice: FatSlice } | { kind: 'fat'; slices: FatSlice[] };

export interface SectionInfo {
  name: string;
  segment: string;
  addr: bigint;
  size: bigint;
  offset: number;
}

export interface SegmentInfo {
  name: string;
  vmaddr: bigint;
  vmsize: bigint;
  fileoff: number;
  filesize: number;
  sections: SectionInfo[];
}

export interface DylibEntry {
  name: string;
  kind: string;
}

export interface SymtabInfo {
  symoff: number;
  nsyms: number;
  stroff: number;
  strsize: number;
}

export interface MachoSliceInfo {
  cpuType: number;
  cpuSubtype: number;
  archName: string;
  filetype: number;
  filetypeName: string;
  ncmds: number;
  segments: SegmentInfo[];
  dylibs: DylibEntry[];
  symtab: SymtabInfo | null;
  codeSignature: { dataoff: number; datasize: number } | null;
  unknownLoadCommands: number;
}

export interface VaMapping {
  /** Absolute file offset (fat-relative) the VA maps to. */
  offset: number;
  segment: string;
  section?: string;
}

const FILETYPE_NAMES: Record<number, string> = {
  1: 'MH_OBJECT',
  2: 'MH_EXECUTE',
  3: 'MH_FVMLIB',
  4: 'MH_CORE',
  5: 'MH_PRELOAD',
  6: 'MH_DYLIB',
  7: 'MH_DYLINKER',
  8: 'MH_BUNDLE',
  9: 'MH_DYLIB_STUB',
  10: 'MH_DSYM',
  11: 'MH_KEXT_BUNDLE',
  12: 'MH_FILESET',
  13: 'MH_GPU_EXECUTE',
  14: 'MH_GPU_DYLIB',
};

function cstr(buf: Buffer, abs: number, max: number): string {
  const end = Math.min(abs + max, buf.length);
  const start = Math.max(0, abs);
  const slice = buf.subarray(start, end);
  const nul = slice.indexOf(0);
  const body = nul === -1 ? slice : slice.subarray(0, nul);
  // Printable extraction only — names are ASCII paths; a hostile binary cannot smuggle
  // control characters into a report through here.
  let out = '';
  for (const byte of body) {
    if (byte < 0x20 || byte > 0x7e) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

export function cpuName(cpuType: number, cpuSubtype: number): string {
  switch (cpuType) {
    case CPU_X86_64:
      return 'x86_64';
    case CPU_ARM64:
      return (cpuSubtype & 0xff) === CPU_ARM64E_SUBTYPE ? 'arm64e' : 'arm64';
    case CPU_ARM64_32:
      return 'arm64_32';
    default:
      return `cpu_${cpuType.toString(16)}`;
  }
}

function fileTypeName(filetype: number): string {
  return FILETYPE_NAMES[filetype] ?? `filetype_${filetype}`;
}

/**
 * Classify the container: fat (universal) with its slice table, or a thin 64-bit image.
 * Throws MachoError('not_macho' | 'unsupported_32bit' | 'malformed') otherwise.
 */
export function layout(buf: Buffer): BinaryLayout {
  if (buf.length < 32) throw new MachoError('not_macho', 'File is too small to be a Mach-O image.');
  const beMagic = buf.readUInt32BE(0);
  if (beMagic === FAT_MAGIC_32 || beMagic === FAT_MAGIC_64) {
    const arch64 = beMagic === FAT_MAGIC_64;
    const entrySize = arch64 ? 32 : 20;
    const count = buf.readUInt32BE(4);
    if (count < 1 || count > MAX_FAT_SLICES) {
      throw new MachoError(
        'malformed',
        `Fat header claims ${count} architectures (cap ${MAX_FAT_SLICES}).`,
      );
    }
    const tableEnd = 8 + count * entrySize;
    if (tableEnd > buf.length)
      throw new MachoError('malformed', 'Fat architecture table extends past end of file.');
    const slices: FatSlice[] = [];
    for (let i = 0; i < count; i++) {
      const p = 8 + i * entrySize;
      const cpuType = buf.readInt32BE(p) >>> 0;
      const cpuSubtype = buf.readInt32BE(p + 4) >>> 0;
      // fat_arch: {cputype, cpusubtype, offset, size, align} — size is at p+12.
      // fat_arch_64: {cputype, cpusubtype, offset(u64), size(u64), align, reserved}.
      const offset = arch64 ? Number(buf.readBigUInt64BE(p + 8)) : buf.readUInt32BE(p + 8);
      const size = arch64 ? Number(buf.readBigUInt64BE(p + 16)) : buf.readUInt32BE(p + 12);
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(size) ||
        offset < 0 ||
        size < 0 ||
        offset > buf.length ||
        size > buf.length - offset
      ) {
        throw new MachoError('malformed', `Fat slice ${i} has an out-of-range offset/size.`);
      }
      slices.push({
        index: i,
        cpuType,
        cpuSubtype,
        offset,
        size,
        archName: cpuName(cpuType, cpuSubtype),
      });
    }
    const byOffset = [...slices].sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < byOffset.length; i++) {
      const current = byOffset[i]!;
      if (current.size < 4 || current.offset < tableEnd) {
        throw new MachoError(
          'malformed',
          `Fat slice ${current.index} overlaps the fat header or is too small for a Mach-O magic.`,
        );
      }
      const previous = byOffset[i - 1];
      if (previous && previous.offset + previous.size > current.offset) {
        throw new MachoError(
          'malformed',
          `Fat slices ${previous.index} and ${current.index} overlap.`,
        );
      }
    }
    return { kind: 'fat', slices };
  }
  const leMagic = buf.readUInt32LE(0);
  if (leMagic === MH_MAGIC_32) {
    throw new MachoError(
      'unsupported_32bit',
      '32-bit Mach-O images are recognized but not mapped.',
    );
  }
  if (leMagic !== MH_MAGIC_64) {
    throw new MachoError('not_macho', 'Buffer does not start with a Mach-O 64-bit or fat magic.');
  }
  const cpuType = buf.readInt32LE(4) >>> 0;
  const cpuSubtype = buf.readInt32LE(8) >>> 0;
  return {
    kind: 'thin',
    slice: {
      index: 0,
      cpuType,
      cpuSubtype,
      offset: 0,
      size: buf.length,
      archName: cpuName(cpuType, cpuSubtype),
    },
  };
}

/**
 * Parse one slice's header and load-command table. All offsets in the returned
 * structures are ABSOLUTE (fat-relative), so callers never re-add slice bases.
 */
export function parseSlice(buf: Buffer, slice: FatSlice): MachoSliceInfo {
  const b = slice.offset;
  const end = b + slice.size;
  const ensure = (abs: number, len: number, what: string): void => {
    if (abs < b || abs + len > end)
      throw new MachoError('malformed', `Malformed ${what} extends past the slice.`);
  };
  ensure(b, 32, 'mach header');
  if (buf.readUInt32LE(b) !== MH_MAGIC_64) {
    throw new MachoError('malformed', 'Slice does not begin with a 64-bit Mach-O header.');
  }
  const cpuType = buf.readInt32LE(b + 4) >>> 0;
  const cpuSubtype = buf.readInt32LE(b + 8) >>> 0;
  if (cpuType !== slice.cpuType) {
    throw new MachoError('malformed', 'Slice CPU type does not match its fat-architecture entry.');
  }
  const filetype = buf.readUInt32LE(b + 12);
  const ncmds = buf.readUInt32LE(b + 16);
  const sizeofcmds = buf.readUInt32LE(b + 20);
  if (ncmds > MAX_LOAD_COMMANDS) {
    throw new MachoError(
      'malformed',
      `Header claims ${ncmds} load commands (cap ${MAX_LOAD_COMMANDS}).`,
    );
  }
  if (b + 32 + sizeofcmds > end) {
    throw new MachoError('malformed', 'Load-command region extends past the slice.');
  }
  const info: MachoSliceInfo = {
    cpuType,
    cpuSubtype,
    archName: cpuName(cpuType, cpuSubtype),
    filetype,
    filetypeName: fileTypeName(filetype),
    ncmds,
    segments: [],
    dylibs: [],
    symtab: null,
    codeSignature: null,
    unknownLoadCommands: 0,
  };
  let p = b + 32;
  const cmdEnd = b + 32 + sizeofcmds;
  for (let i = 0; i < ncmds; i++) {
    ensure(p, 8, `load command ${i}`);
    const cmd = buf.readUInt32LE(p) >>> 0;
    const cmdsize = buf.readUInt32LE(p + 4) >>> 0;
    if (cmdsize < 8 || p + cmdsize > cmdEnd || p + cmdsize > end) {
      throw new MachoError('malformed', `Load command ${i} has an invalid size.`);
    }
    switch (cmd) {
      case LC_SEGMENT_64: {
        if (cmdsize < 72) {
          throw new MachoError(
            'malformed',
            `Segment command ${i} is smaller than segment_command_64.`,
          );
        }
        ensure(p, 72, `segment command ${i}`);
        const segname = cstr(buf, p + 8, 16);
        const vmaddr = buf.readBigUInt64LE(p + 24);
        const vmsize = buf.readBigUInt64LE(p + 32);
        const fileoff = Number(buf.readBigUInt64LE(p + 40));
        const filesize = Number(buf.readBigUInt64LE(p + 48));
        const nsects = buf.readUInt32LE(p + 64) >>> 0;
        if (
          !Number.isSafeInteger(fileoff) ||
          !Number.isSafeInteger(filesize) ||
          fileoff < 0 ||
          filesize < 0
        ) {
          throw new MachoError('malformed', `Segment ${segname} has invalid file offsets.`);
        }
        if (fileoff > slice.size || filesize > slice.size - fileoff) {
          throw new MachoError('malformed', `Segment ${segname} extends past the slice.`);
        }
        const sections: SectionInfo[] = [];
        if (nsects > MAX_SECTIONS_PER_SEGMENT) {
          throw new MachoError(
            'malformed',
            `Segment ${segname} claims ${nsects} sections (cap ${MAX_SECTIONS_PER_SEGMENT}).`,
          );
        }
        const sectionBytes = nsects * 80;
        if (cmdsize < 72 + sectionBytes) {
          throw new MachoError(
            'malformed',
            `Segment ${segname} section table extends past its load command.`,
          );
        }
        for (let s = 0; s < nsects; s++) {
          const sp = p + 72 + s * 80;
          ensure(sp, 80, `section ${s}`);
          sections.push({
            name: cstr(buf, sp, 16),
            segment: cstr(buf, sp + 16, 16),
            addr: buf.readBigUInt64LE(sp + 32),
            size: buf.readBigUInt64LE(sp + 40),
            offset: buf.readUInt32LE(sp + 48) >>> 0,
          });
        }
        info.segments.push({ name: segname, vmaddr, vmsize, fileoff, filesize, sections });
        break;
      }
      case LC_SYMTAB: {
        if (cmdsize < 24) throw new MachoError('malformed', 'Symbol-table command is too small.');
        ensure(p, 24, 'symbol-table command');
        info.symtab = {
          symoff: buf.readUInt32LE(p + 8) >>> 0,
          nsyms: buf.readUInt32LE(p + 12) >>> 0,
          stroff: buf.readUInt32LE(p + 16) >>> 0,
          strsize: buf.readUInt32LE(p + 20) >>> 0,
        };
        break;
      }
      case LC_CODE_SIGNATURE: {
        if (cmdsize < 16) throw new MachoError('malformed', 'Code-signature command is too small.');
        ensure(p, 16, 'code-signature command');
        info.codeSignature = {
          dataoff: buf.readUInt32LE(p + 8) >>> 0,
          datasize: buf.readUInt32LE(p + 12) >>> 0,
        };
        break;
      }
      case LC_LOAD_DYLIB:
      case LC_LOAD_WEAK_DYLIB:
      case LC_REEXPORT_DYLIB:
      case LC_ID_DYLIB: {
        if (cmdsize < 24) throw new MachoError('malformed', 'Dylib command is too small.');
        ensure(p, 24, 'dylib command');
        const nameOff = buf.readUInt32LE(p + 8) >>> 0;
        if (nameOff < 24 || nameOff >= cmdsize) {
          throw new MachoError('malformed', 'Dylib name offset is outside its load command.');
        }
        const nameAbs = p + nameOff;
        const name = cstr(buf, nameAbs, Math.min(4096, p + cmdsize - nameAbs));
        const kinds: Record<number, string> = {
          [LC_LOAD_DYLIB]: 'load',
          [LC_LOAD_WEAK_DYLIB]: 'weak',
          [LC_REEXPORT_DYLIB]: 'reexport',
          [LC_ID_DYLIB]: 'install-id',
        };
        info.dylibs.push({ name, kind: kinds[cmd] ?? 'unknown' });
        break;
      }
      default:
        info.unknownLoadCommands++;
        break;
    }
    p += cmdsize;
  }
  return info;
}

/** Map a virtual address to its absolute file offset through the segment table. */
export function vaToOffset(info: MachoSliceInfo, va: bigint, slice: FatSlice): VaMapping | null {
  for (const seg of info.segments) {
    if (seg.vmaddr <= va && va < seg.vmaddr + seg.vmsize) {
      const delta = va - seg.vmaddr;
      if (delta >= BigInt(seg.filesize)) return null; // maps into zero-fill — no bytes on disk
      const offset = slice.offset + seg.fileoff + Number(delta);
      let section: string | undefined;
      for (const sec of seg.sections) {
        if (sec.addr <= va && va < sec.addr + sec.size) {
          section = sec.name;
          break;
        }
      }
      return { offset, segment: seg.name, section };
    }
  }
  return null;
}

/** Map an absolute file offset back to its virtual address, if it lies in a mapped segment. */
export function offsetToVa(
  info: MachoSliceInfo,
  offset: number,
  slice: FatSlice,
): { va: bigint; segment: string } | null {
  const rel = offset - slice.offset;
  for (const seg of info.segments) {
    if (seg.fileoff <= rel && rel < seg.fileoff + seg.filesize) {
      return { va: seg.vmaddr + BigInt(rel - seg.fileoff), segment: seg.name };
    }
  }
  return null;
}

export interface SymbolEntry {
  name: string;
  valueHex: string;
  nType: number;
  nSect: number;
  nDesc: number;
  external: boolean;
  sectionDefined: boolean;
}

export interface SymbolScan {
  symbols: SymbolEntry[];
  totalNamed: number;
  totalMatched: number;
}

/**
 * Scan the complete classic nlist table while retaining at most `limit` matches.
 * Totals remain exact even when the returned rows are capped.
 */
export function scanSymbols(
  buf: Buffer,
  slice: FatSlice,
  info: MachoSliceInfo,
  limit: number,
  predicate?: (symbol: SymbolEntry) => boolean,
): SymbolScan {
  if (!info.symtab) return { symbols: [], totalNamed: 0, totalMatched: 0 };
  const b = slice.offset;
  const end = b + slice.size;
  const { symoff, nsyms, stroff, strsize } = info.symtab;
  if (nsyms > MAX_SYMBOLS)
    throw new MachoError('malformed', `Symbol table claims ${nsyms} entries (cap ${MAX_SYMBOLS}).`);
  const symAbs = b + symoff;
  if (symAbs + nsyms * 16 > end)
    throw new MachoError('malformed', 'Symbol table extends past the slice.');
  const strAbs = b + stroff;
  if (strAbs > end || strsize > end - strAbs) {
    throw new MachoError('malformed', 'String table extends past the slice.');
  }

  const symbols: SymbolEntry[] = [];
  let totalNamed = 0;
  let totalMatched = 0;
  const resultLimit = Math.max(0, limit);
  for (let i = 0; i < nsyms; i++) {
    const p = symAbs + i * 16;
    const nStrx = buf.readUInt32LE(p) >>> 0;
    const nType = buf.readUInt8(p + 4);
    const nSect = buf.readUInt8(p + 5);
    const nDesc = buf.readUInt16LE(p + 6);
    const value = buf.readBigUInt64LE(p + 8);
    if (nStrx >= strsize) continue;
    const nameAbs = strAbs + nStrx;
    const name = cstr(buf, nameAbs, Math.min(4096, strsize - nStrx));
    if (!name) continue;
    totalNamed++;
    const symbol = {
      name,
      valueHex: '0x' + value.toString(16),
      nType,
      nSect,
      nDesc,
      external: (nType & 0x01) !== 0,
      sectionDefined: (nType & 0x0e) === 0x0e,
    };
    if (predicate && !predicate(symbol)) continue;
    totalMatched++;
    if (symbols.length < resultLimit) symbols.push(symbol);
  }
  return { symbols, totalNamed, totalMatched };
}

/**
 * Read the classic nlist symbol table (LC_SYMTAB). Returns named entries only, capped at
 * `limit`. The dyld exports trie is deliberately not parsed: nlist coverage is what
 * static recon needs (VA lookup by symbol name), and trie parsing adds surface without
 * adding a capability the toolbelt lacks elsewhere.
 */
export function parseSymbols(
  buf: Buffer,
  slice: FatSlice,
  info: MachoSliceInfo,
  limit: number,
): SymbolEntry[] {
  return scanSymbols(buf, slice, info, limit).symbols;
}

/**
 * Extract the embedded entitlements XML from the code-signature superblob. Pure parse —
 * no codesign(1) subprocess. Returns null when the image carries no entitlements blob
 * (unsigned or stripped images) — that is a fact, not an error.
 */
export function parseEntitlements(
  buf: Buffer,
  slice: FatSlice,
  info: MachoSliceInfo,
): string | null {
  if (!info.codeSignature) return null;
  const b = slice.offset;
  const end = b + slice.size;
  const superAbs = b + info.codeSignature.dataoff;
  const declaredSize = info.codeSignature.datasize;
  if (superAbs > end || declaredSize < 12 || declaredSize > end - superAbs) return null;
  const commandEnd = superAbs + declaredSize;
  if (buf.readUInt32BE(superAbs) !== CS_MAGIC_EMBEDDED_SIGNATURE) return null;
  const superLength = buf.readUInt32BE(superAbs + 4);
  if (superLength < 12 || superLength > declaredSize) return null;
  const superEnd = superAbs + superLength;
  const count = buf.readUInt32BE(superAbs + 8);
  if (count > 64) return null;
  const indexEnd = superAbs + 12 + count * 8;
  if (indexEnd > superEnd || superEnd > commandEnd) return null;
  for (let i = 0; i < count; i++) {
    const p = superAbs + 12 + i * 8;
    const type = buf.readUInt32BE(p);
    const off = buf.readUInt32BE(p + 4);
    if (type !== CS_SLOT_ENTITLEMENTS) continue;
    const blobAbs = superAbs + off;
    if (blobAbs < indexEnd || blobAbs + 8 > superEnd) continue;
    if (buf.readUInt32BE(blobAbs) !== CS_MAGIC_EMBEDDED_ENTITLEMENTS) continue;
    const len = buf.readUInt32BE(blobAbs + 4);
    if (len < 8 || len > superEnd - blobAbs) return null;
    const body = Math.min(len - 8, 16 * 1024);
    if (body <= 0) return null;
    return buf.toString('utf8', blobAbs + 8, blobAbs + 8 + body);
  }
  return null;
}
