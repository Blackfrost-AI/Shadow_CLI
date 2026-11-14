// Pure PE/COFF parser for `bin_recon`. No execution, no shell-out, no writes.
//
// Covers PE32 (0x10b) and PE32+ (0x20b): DOS stub → NT headers → COFF → optional
// header → section table → import/export directories → COFF symbol table (when
// present). Reports hardening posture from DllCharacteristics (ASLR, NX, CFG,
// high-entropy ASLR) and Authenticode presence from the security data directory.
// Every field is bounds-checked against the actual buffer; hostile headers fail
// closed with a typed PeError. Mirrors the macho.ts/elf.ts output shapes so the
// tool layer renders all three formats with one contract.
//
// Not parsed (honest gaps, reported as such): .NET metadata, resources, exception
// tables, debug directories, relocation contents. Static recon needs identity,
// imports, exports, symbols, and hardening — not a full loader.

export const PE_DOS_MAGIC = 0x5a4d; // 'MZ'

export const MAX_PE_SECTIONS = 4096;
export const MAX_PE_IMPORT_DLLS = 4096;
export const MAX_PE_IMPORT_FUNCS = 65_536;
// Global ceiling on total imported functions across ALL DLLs. The per-DLL cap alone
// lets a crafted image multiply 4096 DLLs × 65536 thunks × an O(sections) RVA scan
// (~10^12 ops) — a CPU DoS on hostile-sample triage. This bounds total work regardless
// of how the import table is shaped; excess is reported as truncated, never hung.
export const MAX_PE_IMPORT_FUNCS_TOTAL = 65_536;
export const MAX_PE_EXPORTS = 1_000_000;
export const MAX_PE_SYMBOLS = 2_000_000;
const MAX_PE_STRING = 4096;

export class PeError extends Error {
  constructor(
    public readonly code: 'unsupported' | 'malformed' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'PeError';
  }
}

export interface PeSectionInfo {
  index: number;
  name: string;
  virtualSize: number;
  virtualAddress: number; // RVA
  rawDataSize: number;
  rawDataPointer: number; // file offset
  characteristics: number;
  flagsText: string; // e.g. "RX" (code/exec/read) or "RW"
}

export interface PeImportEntry {
  dll: string;
  functions: string[]; // names, or "#<ordinal>" for ordinal-only imports
  truncated: boolean; // true when the function list hit its cap
}

export interface PeExportInfo {
  dllName: string | null;
  ordinalBase: number;
  names: string[];
  totalFunctions: number;
  truncated: boolean;
}

export interface PeInfo {
  format: 'pe';
  peClass: 'PE32' | 'PE32+';
  archName: string;
  machine: number;
  characteristics: number;
  isDll: boolean;
  isExecutable: boolean;
  timestamp: number;
  imageBase: bigint;
  entryRva: number;
  entryVa: bigint;
  subsystem: number;
  subsystemName: string;
  sectionAlignment: number;
  fileAlignment: number;
  sections: PeSectionInfo[];
  imports: PeImportEntry[];
  exports: PeExportInfo | null;
  authenticode: { present: boolean; offset: number; size: number } | null;
  clr: boolean; // .NET runtime header directory present
  symbolCount: number;
  stripped: boolean;
  hardening: {
    aslr: boolean; // DYNAMIC_BASE
    highEntropyAslr: boolean;
    nx: boolean; // NX_COMPAT
    cfg: boolean; // GUARD_CF
    forceIntegrity: boolean;
    noSeh: boolean;
  };
}

export interface PeVaMapping {
  /** Absolute file offset the VA/RVA maps to. */
  offset: number;
  segment: string; // section name
  section?: string;
}

export interface PeSymbolEntry {
  name: string;
  valueHex: string;
  sectionNumber: number;
  type: number;
  storageClass: number;
  storageClassName: string;
  external: boolean;
  sectionDefined: boolean;
}

export interface PeSymbolScan {
  symbols: PeSymbolEntry[];
  totalNamed: number;
  totalMatched: number;
}

const MACHINE_NAMES: Record<number, string> = {
  0x0: 'unknown',
  0x14c: 'i386',
  0x162: 'mipsr3000',
  0x166: 'mipsr4000',
  0x1a2: 'sh3',
  0x1c0: 'arm',
  0x1c2: 'thumb',
  0x1c4: 'armnt',
  0x200: 'ia64',
  0x266: 'mips16',
  0x366: 'mipsfpu',
  0x466: 'mipsfpu16',
  0x520: 'tricore',
  0x8664: 'x86_64',
  0xaa64: 'arm64',
  0x5032: 'riscv32',
  0x5064: 'riscv64',
  0x6264: 'loongarch64',
  0xc166: 'r4000',
};

const SUBSYSTEM_NAMES: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'NATIVE',
  2: 'WINDOWS_GUI',
  3: 'WINDOWS_CUI',
  5: 'OS2_CUI',
  7: 'POSIX_CUI',
  9: 'WINDOWS_CE_GUI',
  10: 'EFI_APPLICATION',
  11: 'EFI_BOOT_SERVICE_DRIVER',
  12: 'EFI_RUNTIME_DRIVER',
  13: 'EFI_ROM',
  14: 'XBOX',
  16: 'WINDOWS_BOOT_APPLICATION',
};

const STORAGE_CLASS_NAMES: Record<number, string> = {
  0: 'END_OF_FUNCTION',
  1: 'AUTOMATIC',
  2: 'EXTERNAL',
  3: 'STATIC',
  4: 'REGISTER',
  5: 'EXTERNAL_DEF',
  6: 'LABEL',
  7: 'UNDEFINED_LABEL',
  8: 'MEMBER_OF_STRUCT',
  9: 'ARGUMENT',
  10: 'STRUCT_TAG',
  11: 'MEMBER_OF_UNION',
  12: 'UNION_TAG',
  13: 'TYPE_DEFINITION',
  14: 'UNDEFINED_STATIC',
  15: 'ENUM_TAG',
  16: 'MEMBER_OF_ENUM',
  17: 'REGISTER_PARAM',
  18: 'BIT_FIELD',
  102: 'FUNCTION',
  103: 'FILE',
  104: 'SECTION',
  105: 'WEAK_EXTERNAL',
  107: 'CLR_TOKEN',
};

/** True when the buffer starts with the DOS 'MZ' magic (cheap dispatch pre-check). */
export function isPe(buf: Buffer): boolean {
  return buf.length >= 2 && buf.readUInt16LE(0) === PE_DOS_MAGIC;
}

function need(buf: Buffer, off: number, len: number, what: string): void {
  if (off < 0 || len < 0 || off > buf.length || len > buf.length - off) {
    throw new PeError('malformed', `${what} extends past end of file (off=${off}, len=${len}).`);
  }
}

function cstr(buf: Buffer, off: number, maxLen: number): string {
  if (off < 0 || off >= buf.length) return '';
  const end = Math.min(buf.length, off + maxLen);
  let i = off;
  while (i < end && buf[i] !== 0) i++;
  return buf.toString('utf8', off, i);
}

interface PeCtx {
  buf: Buffer;
  is64: boolean; // PE32+
  sections: PeSectionInfo[];
}

/** RVA → file offset via the section table. Returns null when unmapped/unbacked. */
function rvaToOffset(ctx: PeCtx, rva: number): number | null {
  for (const s of ctx.sections) {
    const span = Math.max(s.virtualSize, s.rawDataSize);
    if (span === 0) continue;
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      const delta = rva - s.virtualAddress;
      if (delta >= s.rawDataSize) return null; // virtual-only tail (no file bytes)
      return s.rawDataPointer + delta;
    }
  }
  return null;
}

function rvaString(ctx: PeCtx, rva: number): string {
  const off = rvaToOffset(ctx, rva);
  if (off === null) return '';
  return cstr(ctx.buf, off, MAX_PE_STRING);
}

/** Parse the full PE image. Throws PeError on unsupported/malformed input. */
export function parsePe(buf: Buffer): PeInfo {
  need(buf, 0, 64, 'DOS header');
  if (!isPe(buf)) throw new PeError('unsupported', 'Not a PE image (missing MZ magic).');
  const eLfanew = buf.readUInt32LE(0x3c);
  need(buf, eLfanew, 4 + 20, 'NT headers');
  if (buf.toString('latin1', eLfanew, eLfanew + 4) !== 'PE\0\0') {
    throw new PeError('unsupported', 'Missing PE\\0\\0 signature at e_lfanew (not a PE image).');
  }
  const coff = eLfanew + 4;
  const machine = buf.readUInt16LE(coff);
  const numberOfSections = buf.readUInt16LE(coff + 2);
  const timestamp = buf.readUInt32LE(coff + 4);
  const numberOfSymbols = buf.readUInt32LE(coff + 12);
  const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16);
  const characteristics = buf.readUInt16LE(coff + 18);
  if (numberOfSections > MAX_PE_SECTIONS) {
    throw new PeError('malformed', `Section count ${numberOfSections} exceeds cap ${MAX_PE_SECTIONS}.`);
  }
  if (numberOfSymbols > MAX_PE_SYMBOLS) {
    throw new PeError('malformed', `Symbol count ${numberOfSymbols} exceeds cap ${MAX_PE_SYMBOLS}.`);
  }

  const opt = coff + 20;
  let is64 = false;
  let imageBase = 0n;
  let entryRva = 0;
  let subsystem = 0;
  let sectionAlignment = 0;
  let fileAlignment = 0;
  let dllCharacteristics = 0;
  let numberOfRvaAndSizes = 0;
  let dataDirOff = 0;
  if (sizeOfOptionalHeader > 0) {
    need(buf, opt, 2, 'optional header magic');
    const magic = buf.readUInt16LE(opt);
    if (magic === 0x10b) is64 = false;
    else if (magic === 0x20b) is64 = true;
    else if (magic === 0x107) throw new PeError('unsupported', 'ROM optional header (0x107) is not supported.');
    else throw new PeError('unsupported', `Unknown optional header magic 0x${magic.toString(16)}.`);
    const minOpt = is64 ? 112 : 96;
    if (sizeOfOptionalHeader < minOpt) {
      throw new PeError('malformed', `Optional header size ${sizeOfOptionalHeader} smaller than ${minOpt}.`);
    }
    need(buf, opt, sizeOfOptionalHeader, 'optional header');
    entryRva = buf.readUInt32LE(opt + 16);
    if (is64) {
      imageBase = buf.readBigUInt64LE(opt + 24);
      sectionAlignment = buf.readUInt32LE(opt + 32);
      fileAlignment = buf.readUInt32LE(opt + 36);
      subsystem = buf.readUInt16LE(opt + 68);
      dllCharacteristics = buf.readUInt16LE(opt + 70);
      numberOfRvaAndSizes = buf.readUInt32LE(opt + 108);
      dataDirOff = opt + 112;
    } else {
      imageBase = BigInt(buf.readUInt32LE(opt + 28));
      sectionAlignment = buf.readUInt32LE(opt + 32);
      fileAlignment = buf.readUInt32LE(opt + 36);
      subsystem = buf.readUInt16LE(opt + 68);
      dllCharacteristics = buf.readUInt16LE(opt + 70);
      numberOfRvaAndSizes = buf.readUInt32LE(opt + 92);
      dataDirOff = opt + 96;
    }
    if (numberOfRvaAndSizes > 16) {
      throw new PeError('malformed', `Data directory count ${numberOfRvaAndSizes} exceeds 16.`);
    }
    need(buf, dataDirOff, numberOfRvaAndSizes * 8, 'data directories');
  }

  // ── Section table ────────────────────────────────────────────────────────
  const secOff = opt + sizeOfOptionalHeader;
  const sections: PeSectionInfo[] = [];
  for (let i = 0; i < numberOfSections; i++) {
    const p = secOff + i * 40;
    need(buf, p, 40, `section header ${i}`);
    const rawName = buf.toString('latin1', p, p + 8);
    const name = rawName.replace(/\0.*$/, '');
    const virtualSize = buf.readUInt32LE(p + 8);
    const virtualAddress = buf.readUInt32LE(p + 12);
    const rawDataSize = buf.readUInt32LE(p + 16);
    const rawDataPointer = buf.readUInt32LE(p + 20);
    const secChars = buf.readUInt32LE(p + 36);
    if (rawDataSize > 0 && (rawDataPointer > buf.length || rawDataSize > buf.length - rawDataPointer)) {
      throw new PeError('malformed', `Section ${name || i} raw data extends past end of file.`);
    }
    const flagsText =
      (secChars & 0x40000000 ? 'R' : '-') +
      (secChars & 0x80000000 ? 'W' : '-') +
      (secChars & 0x20000000 ? 'X' : '-');
    sections.push({
      index: i,
      name,
      virtualSize,
      virtualAddress,
      rawDataSize,
      rawDataPointer,
      characteristics: secChars,
      flagsText,
    });
  }

  const ctx: PeCtx = { buf, is64, sections };

  // ── Data directories ─────────────────────────────────────────────────────
  const dir = (index: number): { rva: number; size: number } | null => {
    if (index >= numberOfRvaAndSizes) return null;
    const p = dataDirOff + index * 8;
    const rva = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (rva === 0 && size === 0) return null;
    return { rva, size };
  };

  // Security directory (index 4) is a FILE OFFSET, not an RVA.
  const secDir = dir(4);
  const authenticode = secDir
    ? { present: secDir.size > 0, offset: secDir.rva, size: secDir.size }
    : null;
  const clr = dir(14) !== null;

  // ── Imports ──────────────────────────────────────────────────────────────
  const imports: PeImportEntry[] = [];
  const importDir = dir(1);
  if (importDir) {
    const base = rvaToOffset(ctx, importDir.rva);
    if (base === null) {
      throw new PeError('malformed', 'Import directory RVA does not map to file bytes.');
    }
    const thunkSize = is64 ? 8 : 4;
    const ordinalFlag = is64 ? 0x8000000000000000n : 0x80000000n;
    let dllCount = 0;
    let totalFuncs = 0;
    let importBudgetExhausted = false;
    for (;;) {
      if (importBudgetExhausted) break;
      const p = base + dllCount * 20;
      need(buf, p, 20, `import descriptor ${dllCount}`);
      const originalFirstThunk = buf.readUInt32LE(p);
      const nameRva = buf.readUInt32LE(p + 12);
      const firstThunk = buf.readUInt32LE(p + 16);
      if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break; // terminator
      dllCount++;
      if (dllCount > MAX_PE_IMPORT_DLLS) {
        throw new PeError('malformed', `Import DLL count exceeds cap ${MAX_PE_IMPORT_DLLS}.`);
      }
      const dll = rvaString(ctx, nameRva) || `<unmapped-rva-0x${nameRva.toString(16)}>`;
      const thunkRva = originalFirstThunk !== 0 ? originalFirstThunk : firstThunk;
      const functions: string[] = [];
      let truncated = false;
      if (thunkRva !== 0) {
        const thunkOff = rvaToOffset(ctx, thunkRva);
        if (thunkOff !== null) {
          let n = 0;
          for (;;) {
            const tp = thunkOff + n * thunkSize;
            if (tp + thunkSize > buf.length) break;
            const thunk = is64 ? buf.readBigUInt64LE(tp) : BigInt(buf.readUInt32LE(tp));
            if (thunk === 0n) break;
            n++;
            totalFuncs++;
            if (n > MAX_PE_IMPORT_FUNCS || totalFuncs > MAX_PE_IMPORT_FUNCS_TOTAL) {
              truncated = true;
              if (totalFuncs > MAX_PE_IMPORT_FUNCS_TOTAL) importBudgetExhausted = true;
              break;
            }
            if ((thunk & ordinalFlag) !== 0n) {
              functions.push(`#${thunk & 0xffffn}`);
            } else {
              const hintNameRva = Number(thunk & 0x7fffffffn);
              const hnOff = rvaToOffset(ctx, hintNameRva);
              const fname = hnOff !== null ? cstr(buf, hnOff + 2, MAX_PE_STRING) : '';
              functions.push(fname || `<unmapped-rva-0x${hintNameRva.toString(16)}>`);
            }
          }
        }
      }
      imports.push({ dll, functions, truncated });
    }
  }

  // ── Exports ──────────────────────────────────────────────────────────────
  let exports: PeExportInfo | null = null;
  const exportDir = dir(0);
  if (exportDir) {
    const base = rvaToOffset(ctx, exportDir.rva);
    if (base === null) {
      throw new PeError('malformed', 'Export directory RVA does not map to file bytes.');
    }
    need(buf, base, 40, 'export directory');
    const nameRva = buf.readUInt32LE(base + 12);
    const ordinalBase = buf.readUInt32LE(base + 16);
    const numberOfFunctions = buf.readUInt32LE(base + 20);
    const numberOfNames = buf.readUInt32LE(base + 24);
    const addressOfNames = buf.readUInt32LE(base + 32);
    if (numberOfFunctions > MAX_PE_EXPORTS || numberOfNames > MAX_PE_EXPORTS) {
      throw new PeError('malformed', `Export counts exceed cap ${MAX_PE_EXPORTS}.`);
    }
    const names: string[] = [];
    let truncated = false;
    if (numberOfNames > 0 && addressOfNames !== 0) {
      const namesOff = rvaToOffset(ctx, addressOfNames);
      if (namesOff !== null) {
        for (let i = 0; i < numberOfNames; i++) {
          const np = namesOff + i * 4;
          if (np + 4 > buf.length) {
            truncated = true;
            break;
          }
          const strRva = buf.readUInt32LE(np);
          const s = rvaString(ctx, strRva);
          if (s) names.push(s);
          if (names.length >= 10_000) {
            truncated = true;
            break;
          }
        }
      }
    }
    exports = {
      dllName: nameRva !== 0 ? rvaString(ctx, nameRva) || null : null,
      ordinalBase,
      names,
      totalFunctions: numberOfFunctions,
      truncated,
    };
  }

  const archName = MACHINE_NAMES[machine] ?? `machine_0x${machine.toString(16)}`;
  return {
    format: 'pe',
    peClass: is64 ? 'PE32+' : 'PE32',
    archName,
    machine,
    characteristics,
    isDll: (characteristics & 0x2000) !== 0,
    isExecutable: (characteristics & 0x0002) !== 0,
    timestamp,
    imageBase,
    entryRva,
    entryVa: imageBase + BigInt(entryRva),
    subsystem,
    subsystemName: SUBSYSTEM_NAMES[subsystem] ?? `SUBSYSTEM_${subsystem}`,
    sectionAlignment,
    fileAlignment,
    sections,
    imports,
    exports,
    authenticode,
    clr,
    symbolCount: numberOfSymbols,
    stripped: numberOfSymbols === 0,
    hardening: {
      aslr: (dllCharacteristics & 0x0040) !== 0,
      highEntropyAslr: (dllCharacteristics & 0x0020) !== 0,
      nx: (dllCharacteristics & 0x0100) !== 0,
      cfg: (dllCharacteristics & 0x4000) !== 0,
      forceIntegrity: (dllCharacteristics & 0x0080) !== 0,
      noSeh: (dllCharacteristics & 0x0400) !== 0,
    },
  };
}

/** Scan the COFF symbol table (when present). Totals exact; rows capped at limit. */
export function scanSymbols(
  buf: Buffer,
  info: PeInfo,
  limit: number,
  predicate?: (s: PeSymbolEntry) => boolean,
): PeSymbolScan {
  const symbols: PeSymbolEntry[] = [];
  let totalNamed = 0;
  let totalMatched = 0;
  if (info.symbolCount === 0) return { symbols, totalNamed, totalMatched };
  // Re-derive the table location from the headers (parsePe validated bounds).
  const eLfanew = buf.readUInt32LE(0x3c);
  const coff = eLfanew + 4;
  const pointerToSymbolTable = buf.readUInt32LE(coff + 8);
  const numberOfSymbols = info.symbolCount;
  if (pointerToSymbolTable === 0) return { symbols, totalNamed, totalMatched };
  need(buf, pointerToSymbolTable, numberOfSymbols * 18, 'COFF symbol table');
  const strTabOff = pointerToSymbolTable + numberOfSymbols * 18;
  let strTabSize = 0;
  if (strTabOff + 4 <= buf.length) {
    strTabSize = buf.readUInt32LE(strTabOff);
    if (strTabSize < 4 || strTabOff + strTabSize > buf.length) strTabSize = 0;
  }
  const resultLimit = Math.max(0, limit);
  let i = 0;
  while (i < numberOfSymbols) {
    const p = pointerToSymbolTable + i * 18;
    const value = buf.readUInt32LE(p + 8);
    const sectionNumber = buf.readInt16LE(p + 12);
    const type = buf.readUInt16LE(p + 14);
    const storageClass = buf.readUInt8(p + 16);
    const auxCount = buf.readUInt8(p + 17);
    // Name: 8 inline bytes, or zeroes + 4-byte string-table offset.
    let name = '';
    if (buf.readUInt32LE(p) === 0) {
      const strOff = buf.readUInt32LE(p + 4);
      if (strTabSize > 0 && strOff < strTabSize) {
        name = cstr(buf, strTabOff + strOff, Math.min(MAX_PE_STRING, strTabSize - strOff));
      }
    } else {
      name = buf.toString('latin1', p, p + 8).replace(/\0.*$/, '');
    }
    i += 1 + auxCount; // skip auxiliary records
    if (!name) continue;
    totalNamed++;
    const sym: PeSymbolEntry = {
      name,
      valueHex: '0x' + value.toString(16),
      sectionNumber,
      type,
      storageClass,
      storageClassName: STORAGE_CLASS_NAMES[storageClass] ?? `C_${storageClass}`,
      external: storageClass === 2 || storageClass === 5 || storageClass === 105,
      sectionDefined: sectionNumber > 0,
    };
    if (predicate && !predicate(sym)) continue;
    totalMatched++;
    if (symbols.length < resultLimit) symbols.push(sym);
  }
  return { symbols, totalNamed, totalMatched };
}

/** VA (image-relative) → file offset. Accepts absolute VA or bare RVA. */
export function vaToOffset(info: PeInfo, va: bigint): PeVaMapping | null {
  let rva: number;
  if (va >= info.imageBase && va < info.imageBase + 0x100000000n) {
    rva = Number(va - info.imageBase);
  } else if (va < 0x100000000n) {
    rva = Number(va); // treat as bare RVA
  } else {
    return null;
  }
  for (const s of info.sections) {
    const span = Math.max(s.virtualSize, s.rawDataSize);
    if (span === 0) continue;
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      const delta = rva - s.virtualAddress;
      if (delta >= s.rawDataSize) return null;
      return { offset: s.rawDataPointer + delta, segment: s.name, section: s.name };
    }
  }
  return null;
}

/** File offset → VA (image base + RVA). */
export function offsetToVa(info: PeInfo, offset: number): { va: bigint; segment: string; section?: string } | null {
  for (const s of info.sections) {
    if (s.rawDataSize === 0) continue;
    if (offset >= s.rawDataPointer && offset < s.rawDataPointer + s.rawDataSize) {
      const rva = s.virtualAddress + (offset - s.rawDataPointer);
      return { va: info.imageBase + BigInt(rva), segment: s.name, section: s.name };
    }
  }
  return null;
}