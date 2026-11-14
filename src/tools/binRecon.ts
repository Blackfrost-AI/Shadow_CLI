// bin_recon — read-only structured binary reconnaissance for Mach-O, ELF, and PE images.
//
// The Phase 1 redteam context-cost fix: every query returns capped, structured JSON
// instead of a raw `otool` dump, and the fat-slice VA<->offset math that was previously
// hand-computed per crack is built in. Structure, symbols and entitlements come from the
// pure parsers in ../security/{macho,elf,pe}.ts (never executing anything inside the
// target). Format is detected from magic bytes: Mach-O keeps its original path
// unchanged; ELF (32/64, both endians) and PE (PE32/PE32+) route to a parallel handler
// with the same action contract. Disassembly windows shell out to the host objdump
// when present and fall back to a raw byte window otherwise — the byte window is the
// fail-soft core, the mnemonics are an optional enhancement. All file access runs
// through the workspace jail.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RE2JS } from 're2js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { scrubbedEnv } from '../util/safeEnv.js';
import {
  layout,
  parseSlice,
  scanSymbols,
  parseEntitlements,
  vaToOffset,
  offsetToVa,
  MachoError,
  type BinaryLayout,
  type FatSlice,
  type MachoSliceInfo,
} from '../security/macho.js';
import {
  isElf,
  parseElf,
  scanSymbols as scanElfSymbols,
  vaToOffset as elfVaToOffset,
  offsetToVa as elfOffsetToVa,
  ElfError,
  type ElfInfo,
} from '../security/elf.js';
import {
  isPe,
  parsePe,
  scanSymbols as scanPeSymbols,
  vaToOffset as peVaToOffset,
  offsetToVa as peOffsetToVa,
  PeError,
  type PeInfo,
} from '../security/pe.js';
import { clamp } from './util.js';
import { fail, ok, type Tool, type ToolResult, type ToolContext } from './types.js';

const MAX_FILE_BYTES = 512 * 1024 * 1024; // refuse images above 512 MiB
const MAX_SYMBOL_RESULTS = 500;
const MAX_BYTE_WINDOW = 512;
const MAX_DISASM_INSTRUCTIONS = 256;
const MAX_OUTPUT_CHARS = 24000;

const schema = z
  .object({
    action: z.enum([
      'layout',
      'info',
      'entitlements',
      'symbols',
      'disasm',
      'bytes',
      'va_to_offset',
      'offset_to_va',
    ]),
    path: z.string().min(1).max(2000),
    arch: z.string().max(16).optional(),
    va: z.string().max(20).optional(),
    offset: z.number().int().min(0).optional(),
    count: z.number().int().min(1).optional(),
    filter: z.string().max(500).describe('RE2 regular expression for symbol names; backreferences and lookaround are not supported.').optional(),
  })
  .strict();

export type BinReconInput = z.infer<typeof schema>;

interface WindowData {
  arch: string;
  va: string;
  fileOffset: number;
  segment: string;
  section?: string;
  bytesHex: string;
  disasm?: string;
  disassembler?: string;
}

/** Probe for a real llvm-objdump binary (cached), mirroring the grep.ts ripgrep probe. */
let objdumpAvailable: string | null | undefined;
function objdumpPath(): string | null {
  if (objdumpAvailable !== undefined) return objdumpAvailable;
  try {
    const probe = spawnSync('objdump', ['--version'], {
      timeout: 3000, windowsHide: true, env: scrubbedEnv(),
    });
    objdumpAvailable = !probe.error && probe.status === 0 ? 'objdump' : null;
  } catch {
    objdumpAvailable = null;
  }
  return objdumpAvailable;
}

function hexOf(buf: Buffer, offset: number, count: number): string {
  return buf.subarray(offset, offset + count).toString('hex');
}

function parseVa(value: string): bigint {
  if (!/^0x[0-9a-fA-F]{1,16}$/.test(value)) {
    throw new MachoError('bad_va', 'va must be a 0x-prefixed hex virtual address (≤ 64 bits).');
  }
  return BigInt(value);
}

/**
 * ELF/PE reconnaissance handler. Same action set and output contract as the
 * Mach-O path; format-specific detail lives under the same field names where
 * the concepts match (segments/sections/symbols/imports). `entitlements` is a
 * Mach-only concept and returns null with an honest note. Single-image formats:
 * no fat container, so `layout` reports one slice describing the whole file.
 */
function reconElfPe(
  input: BinReconInput,
  ctx: ToolContext,
  buf: Buffer,
  resolved: string,
  start: number,
): ToolResult<unknown> {
  const failNow = (code: string, message: string) =>
    fail('bin_recon', 'read', Date.now() - start, code, message);
  const okNow = (data: unknown) =>
    ok(
      'bin_recon',
      'read',
      Date.now() - start,
      clamp(JSON.stringify({ action: input.action, ...((data ?? {}) as object) }), MAX_OUTPUT_CHARS),
      data,
    );

  let elf: ElfInfo | null = null;
  let pe: PeInfo | null = null;
  try {
    if (isElf(buf)) elf = parseElf(buf);
    else pe = parsePe(buf);
  } catch (e) {
    const code =
      e instanceof ElfError || e instanceof PeError
        ? e.code === 'unsupported'
          ? 'unsupported'
          : 'parse_error'
        : 'parse_error';
    return failNow(code, (e as Error).message);
  }
  const archName = elf ? elf.archName : pe!.archName;
  const format = elf ? 'elf' : 'pe';

  try {
    ctx.signal?.throwIfAborted();
    if (input.arch && input.arch !== archName) {
      return failNow('unknown_arch', `Image is ${format} ${archName}; no slice for ${input.arch}.`);
    }
    let data: unknown;
    switch (input.action) {
      case 'layout': {
        const slice = elf
          ? {
              archName,
              offset: 0,
              size: buf.length,
              format,
              class: elf.class,
              endian: elf.endian,
              filetype: elf.typeName,
            }
          : {
              archName,
              offset: 0,
              size: buf.length,
              format,
              peClass: pe!.peClass,
              isDll: pe!.isDll,
            };
        data = { kind: format, path: input.path, size: buf.length, slices: [slice] };
        break;
      }
      case 'info': {
        if (elf) {
          data = {
            path: input.path,
            format,
            arch: archName,
            filetype: elf.typeName,
            class: elf.class,
            endian: elf.endian,
            entry: '0x' + elf.entry.toString(16),
            size: buf.length,
            segments: elf.segments.map((s) => ({
              name: s.typeName,
              flags: s.flagsText,
              vmaddr: '0x' + s.vaddr.toString(16),
              vmsize: s.memsz.toString(),
              fileoff: s.offset,
              filesize: s.filesz,
            })),
            sections: elf.sections.map((s) => ({
              name: s.name,
              type: s.typeName,
              addr: '0x' + s.addr.toString(16),
              offset: s.offset,
              size: s.size.toString(),
            })),
            libs: elf.libs,
            rpaths: elf.rpaths,
            interpreter: elf.interpreter,
            dynamic: elf.dynamic.map((d) => ({
              tag: d.tagName,
              value: '0x' + d.value.toString(16),
              ...(d.str !== null ? { str: d.str } : {}),
            })),
            symtabCount: elf.symtabCount,
            dynsymCount: elf.dynsymCount,
            stripped: elf.stripped,
            hardening: elf.hardening,
          };
        } else {
          data = {
            path: input.path,
            format,
            arch: archName,
            peClass: pe!.peClass,
            isDll: pe!.isDll,
            isExecutable: pe!.isExecutable,
            timestamp: pe!.timestamp,
            imageBase: '0x' + pe!.imageBase.toString(16),
            entry: '0x' + pe!.entryVa.toString(16),
            subsystem: pe!.subsystemName,
            size: buf.length,
            sections: pe!.sections.map((s) => ({
              name: s.name,
              flags: s.flagsText,
              vmaddr: '0x' + (pe!.imageBase + BigInt(s.virtualAddress)).toString(16),
              vmsize: s.virtualSize.toString(),
              fileoff: s.rawDataPointer,
              filesize: s.rawDataSize,
            })),
            imports: pe!.imports,
            exports: pe!.exports,
            authenticode: pe!.authenticode,
            clr: pe!.clr,
            symbolCount: pe!.symbolCount,
            stripped: pe!.stripped,
            hardening: pe!.hardening,
          };
        }
        break;
      }
      case 'entitlements': {
        data = {
          path: input.path,
          arch: archName,
          entitlements: null,
          note: `Entitlements are a Mach-O concept; this is an ${format.toUpperCase()} image. ` +
            (elf
              ? 'See info.hardening for NX/RELRO/PIE/canary posture.'
              : 'See info.authenticode for signature presence and info.hardening for ASLR/NX/CFG.'),
        };
        break;
      }
      case 'symbols': {
        const limit = Math.min(input.count ?? 100, MAX_SYMBOL_RESULTS);
        let re: RE2JS | undefined;
        if (input.filter) {
          try {
            re = RE2JS.compile(input.filter);
          } catch (e) {
            return failNow('bad_filter', `Invalid or unsupported RE2 filter: ${(e as Error).message}`);
          }
        }
        const pred = re ? (s: { name: string }) => re!.test(s.name) : undefined;
        const scan = elf
          ? scanElfSymbols(buf, elf, limit, pred)
          : scanPeSymbols(buf, pe!, limit, pred);
        data = {
          path: input.path,
          arch: archName,
          totalNamed: scan.totalNamed,
          totalMatched: scan.totalMatched,
          returned: scan.symbols.length,
          truncated: scan.totalMatched > scan.symbols.length,
          symbols: scan.symbols,
          ...(scan.totalNamed === 0
            ? {
                note: elf
                  ? 'No named symbols in .symtab/.dynsym (stripped or no symbol tables).'
                  : pe!.symbolCount === 0
                    ? 'No COFF symbol table (stripped). Use info.imports/exports for named API surface.'
                    : 'COFF symbol table present but no named entries matched.',
              }
            : {}),
        };
        break;
      }
      case 'disasm':
      case 'bytes': {
        if (!input.va) return failNow('va_required', `${input.action} requires va.`);
        let va: bigint;
        try {
          va = parseVa(input.va);
        } catch (e) {
          return failNow('bad_va', (e as Error).message);
        }
        const mapping = elf ? elfVaToOffset(elf, va) : peVaToOffset(pe!, va);
        if (!mapping) {
          return failNow('va_unmapped', `VA ${input.va} does not map to file bytes in this ${format.toUpperCase()} image.`);
        }
        const count =
          input.action === 'bytes'
            ? Math.min(input.count ?? 64, MAX_BYTE_WINDOW)
            : Math.min(input.count ?? 16, MAX_DISASM_INSTRUCTIONS);
        const span = input.action === 'bytes' ? count : count * 16;
        if (mapping.offset + span > buf.length) {
          return failNow('window_out_of_range', 'Requested window extends past the end of the file.');
        }
        const endMapping = elf
          ? elfVaToOffset(elf, va + BigInt(span - 1))
          : peVaToOffset(pe!, va + BigInt(span - 1));
        if (
          !endMapping ||
          endMapping.segment !== mapping.segment ||
          endMapping.offset !== mapping.offset + span - 1
        ) {
          return failNow('window_out_of_segment', 'Requested window extends past the mapped file-backed region.');
        }
        const window: WindowData = {
          arch: archName,
          va: input.va,
          fileOffset: mapping.offset,
          segment: mapping.segment,
          section: mapping.section,
          bytesHex: hexOf(buf, mapping.offset, input.action === 'bytes' ? count : span).slice(
            0,
            MAX_BYTE_WINDOW * 2,
          ),
        };
        if (input.action === 'disasm') {
          const tool = objdumpPath();
          if (tool) {
            // Whole file is the image — no slice extraction needed (unlike fat Mach-O).
            const stop = '0x' + (va + BigInt(span)).toString(16);
            const res = spawnSync(
              tool,
              ['--disassemble', `--start-address=${input.va}`, `--stop-address=${stop}`, resolved],
              { timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: scrubbedEnv() },
            );
            if (!res.error && res.status === 0) {
              const lines: string[] = [];
              let instructions = 0;
              for (const line of res.stdout.toString('utf8').split('\n')) {
                if (instructions >= count) break;
                if (/^\s*[0-9a-fA-F]+:\s+\S/.test(line)) {
                  lines.push(line);
                  instructions++;
                } else if (/^\s*[0-9a-fA-F]+\s+<[^>]+>:\s*$/.test(line)) {
                  lines.push(line);
                }
              }
              if (instructions > 0) {
                window.disasm = clamp(lines.join('\n'), 12000);
                window.disassembler = tool;
              }
            }
          }
          if (!window.disasm) {
            window.disassembler =
              'unavailable — raw byte window returned (install objdump/LLVM for mnemonics)';
          }
        }
        data = window;
        break;
      }
      case 'va_to_offset': {
        if (!input.va) return failNow('va_required', 'va_to_offset requires va.');
        let va: bigint;
        try {
          va = parseVa(input.va);
        } catch (e) {
          return failNow('bad_va', (e as Error).message);
        }
        const mapping = elf ? elfVaToOffset(elf, va) : peVaToOffset(pe!, va);
        if (!mapping) {
          return failNow('va_unmapped', `VA ${input.va} does not map to file bytes in this ${format.toUpperCase()} image.`);
        }
        data = { path: input.path, arch: archName, va: input.va, ...mapping };
        break;
      }
      case 'offset_to_va': {
        if (typeof input.offset !== 'number') {
          return failNow('offset_required', 'offset_to_va requires offset.');
        }
        if (input.offset < 0 || input.offset >= buf.length) {
          return failNow('offset_out_of_range', `Offset is outside the file (0-${buf.length}).`);
        }
        const back = elf ? elfOffsetToVa(elf, input.offset) : peOffsetToVa(pe!, input.offset);
        if (!back) {
          return failNow('offset_unmapped', 'Offset is not covered by a mapped section/segment.');
        }
        data = {
          path: input.path,
          arch: archName,
          offset: input.offset,
          va: '0x' + back.va.toString(16),
          segment: back.segment,
        };
        break;
      }
    }
    ctx.signal?.throwIfAborted();
    return okNow(data);
  } catch (e) {
    const code =
      e instanceof ElfError || e instanceof PeError
        ? e.code === 'unsupported'
          ? 'unsupported'
          : 'parse_error'
        : 'recon_error';
    return failNow(code, (e as Error).message);
  }
}

export const binRecon: Tool<BinReconInput> = {
  name: 'bin_recon',
  risk: 'read',
  deferred: true,
  searchAliases: [
    'binary', 'malware', 'sample', 'reverse', 'reversing', 'disassemble', 'disassembly',
    'objdump', 'macho', 'elf', 'pe', 'exe', 'dll', 'coff', 'windows', 'linux',
    'executable', 'strings', 'symbols', 'imports', 'exports', 'hardening', 'aslr',
    'entropy', 'packed', 'unpack', 'triage', 'analysis', 'analyse', 'analyze', 'dropper',
    'implant', 'payload', 'beacon', 'stager', 'loader', 'ransomware', 'rat', 'backdoor',
    'rootkit', 'shellcode', 'c2', 'cobalt', 'threat', 'ioc', 'indicator',
  ],
  inputSchema: schema,
  description:
    'Read-only structured reconnaissance of a Mach-O (thin or fat/universal), ELF (32/64, little/big endian), ' +
    'or PE (PE32/PE32+) binary: layout, segments/sections, linked libraries/imports, exports (PE), entitlements ' +
    '(Mach-O), hardening posture (ELF NX/RELRO/PIE/canary; PE ASLR/NX/CFG), symbol search, VA<->offset mapping, ' +
    'capped disassembly windows and raw byte windows. Format is auto-detected from magic bytes. Never executes ' +
    'or loads the target. Every query returns capped structured JSON. Disassembly uses the host objdump when ' +
    'available and otherwise falls back to a raw byte window.',
  async run(input, ctx): Promise<ToolResult<unknown>> {
    const start = Date.now();
    let resolved: string;
    try {
      resolved = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path);
    } catch (e) {
      return fail(
        'bin_recon',
        'read',
        Date.now() - start,
        'outside_workspace',
        (e as Error).message,
      );
    }
    if (ctx.dryRun && input.action !== 'layout') {
      return ok(
        'bin_recon',
        'read',
        Date.now() - start,
        `Dry run: would run ${input.action} on ${input.path}.`,
      );
    }
    let buf: Buffer;
    let parsed: BinaryLayout;
    let slice: FatSlice;
    let info: MachoSliceInfo;
    let tempSlice: string | undefined;
    try {
      ctx.signal?.throwIfAborted();
      const st = statSync(resolved);
      if (!st.isFile())
        return fail(
          'bin_recon',
          'read',
          Date.now() - start,
          'not_a_file',
          'Target is not a regular file.',
        );
      if (st.size > MAX_FILE_BYTES) {
        return fail(
          'bin_recon',
          'read',
          Date.now() - start,
          'too_large',
          `Image is above the ${MAX_FILE_BYTES / 1024 / 1024} MiB cap.`,
        );
      }
      buf = readFileSync(resolved);
      // Non-Mach-O formats take a parallel handler with the same action contract.
      // The Mach-O path below is unchanged.
      if (isElf(buf) || isPe(buf)) {
        return reconElfPe(input, ctx, buf, resolved, start);
      }
      parsed = layout(buf);
      // `layout` is the discovery operation for a universal binary: it must work before the
      // caller knows which architecture to select, and it does not need to parse a slice.
      if (input.action === 'layout') {
        const slices =
          parsed.kind === 'fat' ? parsed.slices.map((s) => ({ ...s })) : [{ ...parsed.slice }];
        const data = { kind: parsed.kind, path: input.path, size: buf.length, slices };
        return ok(
          'bin_recon',
          'read',
          Date.now() - start,
          clamp(JSON.stringify({ action: input.action, ...data }), MAX_OUTPUT_CHARS),
          data,
        );
      }
      if (parsed.kind === 'fat') {
        slice = undefined!;
        info = undefined!;
        const candidates = parsed.slices;
        if (input.arch) {
          const found = candidates.find((s) => s.archName === input.arch);
          if (!found) {
            throw new MachoError(
              'unknown_arch',
              `No slice for ${input.arch}. Available: ${candidates.map((s) => s.archName).join(', ')}.`,
            );
          }
          slice = found;
        } else if (candidates.length === 1) {
          slice = candidates[0]!;
        } else {
          throw new MachoError(
            'arch_required',
            `Fat image with ${candidates.length} slices; pass arch. Available: ${candidates.map((s) => s.archName).join(', ')}.`,
          );
        }
      } else {
        if (input.arch && parsed.slice.archName !== input.arch) {
          throw new MachoError(
            'unknown_arch',
            `Image is thin ${parsed.slice.archName}; no slice for ${input.arch}.`,
          );
        }
        slice = parsed.slice;
      }
      // Do not cache by slice offset/size: two different files commonly share both values, and a
      // same-sized file may change between calls. Parsing a bounded load-command table per query
      // keeps every answer tied to the bytes that were actually read for this invocation.
      info = parseSlice(buf, slice);
    } catch (e) {
      const code = e instanceof MachoError ? e.code : 'parse_error';
      return fail('bin_recon', 'read', Date.now() - start, code, (e as Error).message);
    }
    try {
      let data: unknown;
      switch (input.action) {
        case 'info': {
          data = {
            path: input.path,
            arch: slice.archName,
            filetype: info.filetypeName,
            size: slice.size,
            segments: info.segments.map((seg) => ({
              name: seg.name,
              vmaddr: '0x' + seg.vmaddr.toString(16),
              vmsize: seg.vmsize.toString(),
              fileoff: seg.fileoff,
              filesize: seg.filesize,
              sections: seg.sections.map((sec) => ({
                name: sec.name,
                addr: '0x' + sec.addr.toString(16),
                size: sec.size.toString(),
              })),
            })),
            dylibs: info.dylibs,
            codeSignature: info.codeSignature,
            entitlementsPresent: parseEntitlements(buf, slice, info) !== null,
            unknownLoadCommands: info.unknownLoadCommands,
          };
          break;
        }
        case 'entitlements': {
          const xml = parseEntitlements(buf, slice, info);
          data = { path: input.path, arch: slice.archName, entitlements: xml };
          break;
        }
        case 'symbols': {
          if (!info.symtab) {
            data = {
              path: input.path,
              arch: slice.archName,
              symbols: [],
              note: 'No LC_SYMTAB load command in this slice.',
            };
            break;
          }
          const limit = Math.min(input.count ?? 100, MAX_SYMBOL_RESULTS);
          let re: RE2JS | undefined;
          if (input.filter) {
            try {
              // Linear-time matching: a heuristic over native backtracking regexes misses
              // ambiguous alternatives such as (a|aa)+$ and cannot bound a synchronous scan.
              re = RE2JS.compile(input.filter);
            } catch (e) {
              return fail(
                'bin_recon',
                'read',
                Date.now() - start,
                'bad_filter',
                `Invalid or unsupported RE2 filter: ${(e as Error).message}`,
              );
            }
          }
          const scan = scanSymbols(buf, slice, info, limit, re ? (s) => re.test(s.name) : undefined);
          data = {
            path: input.path,
            arch: slice.archName,
            totalNamed: scan.totalNamed,
            totalMatched: scan.totalMatched,
            returned: scan.symbols.length,
            truncated: scan.totalMatched > scan.symbols.length,
            symbols: scan.symbols,
          };
          break;
        }
        case 'disasm':
        case 'bytes': {
          if (!input.va)
            return fail(
              'bin_recon',
              'read',
              Date.now() - start,
              'va_required',
              `${input.action} requires va.`,
            );
          let va: bigint;
          try {
            va = parseVa(input.va);
          } catch (e) {
            return fail('bin_recon', 'read', Date.now() - start, 'bad_va', (e as Error).message);
          }
          const mapping = vaToOffset(info, va, slice);
          if (!mapping) {
            return fail(
              'bin_recon',
              'read',
              Date.now() - start,
              'va_unmapped',
              `VA ${input.va} does not map to file bytes in slice ${slice.archName} (segments: ${info.segments.map((s) => s.name).join(', ')}).`,
            );
          }
          const count =
            input.action === 'bytes'
              ? Math.min(input.count ?? 64, MAX_BYTE_WINDOW)
              : Math.min(input.count ?? 16, MAX_DISASM_INSTRUCTIONS);
          const span = input.action === 'bytes' ? count : count * 16; // worst-case x86_64 insn length
          if (mapping.offset + span > slice.offset + slice.size) {
            return fail(
              'bin_recon',
              'read',
              Date.now() - start,
              'window_out_of_slice',
              'Requested window extends past the slice.',
            );
          }
          const endMapping = vaToOffset(info, va + BigInt(span - 1), slice);
          if (
            !endMapping ||
            endMapping.segment !== mapping.segment ||
            endMapping.offset !== mapping.offset + span - 1
          ) {
            return fail(
              'bin_recon',
              'read',
              Date.now() - start,
              'window_out_of_segment',
              'Requested window extends past the mapped file-backed segment.',
            );
          }
          const window: WindowData = {
            arch: slice.archName,
            va: input.va,
            fileOffset: mapping.offset,
            segment: mapping.segment,
            section: mapping.section,
            bytesHex: hexOf(buf, mapping.offset, input.action === 'bytes' ? count : span).slice(
              0,
              MAX_BYTE_WINDOW * 2,
            ),
          };
          if (input.action === 'disasm') {
            const tool = objdumpPath();
            if (tool) {
              if (parsed.kind === 'fat') {
                const dir = resolveWithin(ctx.workspaceRoot, '.shadow/binrecon');
                mkdirSync(dir, { recursive: true, mode: 0o700 });
                tempSlice = resolveWithin(
                  ctx.workspaceRoot,
                  `.shadow/binrecon/.${process.pid}.${randomUUID()}.slice`,
                );
                writeFileSync(tempSlice, buf.subarray(slice.offset, slice.offset + slice.size), {
                  flag: 'wx',
                  mode: 0o600,
                });
              }
              const target = tempSlice ?? resolved;
              const stop = '0x' + (va + BigInt(span)).toString(16);
              const res = spawnSync(
                tool,
                ['--disassemble', `--start-address=${input.va}`, `--stop-address=${stop}`, target],
                { timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: scrubbedEnv() },
              );
              if (!res.error && res.status === 0) {
                // LLVM starts addresses at column zero; GNU normally indents them.
                // Count instructions, not labels/headers, to honor the requested window.
                const lines: string[] = [];
                let instructions = 0;
                for (const line of res.stdout.toString('utf8').split('\n')) {
                  if (instructions >= count) break;
                  if (/^\s*[0-9a-fA-F]+:\s+\S/.test(line)) {
                    lines.push(line);
                    instructions++;
                  } else if (/^\s*[0-9a-fA-F]+\s+<[^>]+>:\s*$/.test(line)) {
                    lines.push(line);
                  }
                }
                if (instructions > 0) {
                  window.disasm = clamp(lines.join('\n'), 12000);
                  window.disassembler = tool;
                }
              }
            }
            if (!window.disasm) {
              window.disassembler =
                'unavailable — raw byte window returned (install Xcode Command Line Tools for mnemonics)';
            }
          }
          data = window;
          break;
        }
        case 'va_to_offset': {
          if (!input.va)
            return fail(
              'bin_recon',
              'read',
              Date.now() - start,
              'va_required',
              'va_to_offset requires va.',
            );
          let va: bigint;
          try {
            va = parseVa(input.va);
          } catch (e) {
            return fail('bin_recon', 'read', Date.now() - start, 'bad_va', (e as Error).message);
          }
          const mapping = vaToOffset(info, va, slice);
          if (!mapping) {
            return fail(
              'bin_recon',
              'read',
              Date.now() - start,
              'va_unmapped',
              `VA ${input.va} does not map to file bytes in slice ${slice.archName}.`,
            );
          }
          data = { path: input.path, arch: slice.archName, va: input.va, ...mapping };
          break;
        }
        case 'offset_to_va': {
          if (typeof input.offset !== 'number') {
            return fail(
              'bin_recon',
              'read',
              Date.now() - start,
              'offset_required',
              'offset_to_va requires offset.',
            );
          }
          if (input.offset < slice.offset || input.offset >= slice.offset + slice.size) {
            return fail(
              'bin_recon',
              'read',
              Date.now() - start,
              'offset_out_of_slice',
              `Offset is outside the ${slice.archName} slice (${slice.offset}-${slice.offset + slice.size}).`,
            );
          }
          const back = offsetToVa(info, input.offset, slice);
          if (!back) {
            return fail(
              'bin_recon',
              'read',
              Date.now() - start,
              'offset_unmapped',
              `Offset is not covered by a mapped segment in slice ${slice.archName}.`,
            );
          }
          data = {
            path: input.path,
            arch: slice.archName,
            offset: input.offset,
            va: '0x' + back.va.toString(16),
            segment: back.segment,
          };
          break;
        }
      }
      ctx.signal?.throwIfAborted();
      return ok(
        'bin_recon',
        'read',
        Date.now() - start,
        clamp(
          JSON.stringify({ action: input.action, ...((data ?? {}) as object) }),
          MAX_OUTPUT_CHARS,
        ),
        data,
      );
    } catch (e) {
      const code = e instanceof MachoError ? e.code : 'recon_error';
      return fail('bin_recon', 'read', Date.now() - start, code, (e as Error).message);
    } finally {
      if (tempSlice) {
        try {
          unlinkSync(tempSlice);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  },
};

/** Test seam: clear the cached objdump probe state between runs. */
export function __resetBinReconCaches(): void {
  objdumpAvailable = undefined;
}

/** Convenience wrapper so hosts/tests can register under a custom name. */
export function makeBinRecon(): Tool<BinReconInput> {
  return binRecon;
}
