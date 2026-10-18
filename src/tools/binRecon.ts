// bin_recon — read-only structured binary reconnaissance for Mach-O images.
//
// The Phase 1 redteam context-cost fix: every query returns capped, structured JSON
// instead of a raw `otool` dump, and the fat-slice VA<->offset math that was previously
// hand-computed per crack is built in. Structure, symbols and entitlements come from the
// pure parser in ../security/macho.ts (never executing anything inside the target).
// Disassembly windows shell out to the host llvm-objdump when present and fall back to
// a raw byte window otherwise — the byte window is the fail-soft core, the mnemonics
// are an optional enhancement. All file access runs through the workspace jail.

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
import { clamp } from './util.js';
import { fail, ok, type Tool, type ToolResult } from './types.js';

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

export const binRecon: Tool<BinReconInput> = {
  name: 'bin_recon',
  risk: 'read',
  deferred: true,
  searchAliases: [
    'binary', 'malware', 'sample', 'reverse', 'reversing', 'disassemble', 'disassembly',
    'objdump', 'macho', 'elf', 'executable', 'strings', 'symbols', 'imports',
    'entropy', 'packed', 'unpack', 'triage', 'analysis', 'analyse', 'analyze', 'dropper',
    'implant', 'payload', 'beacon', 'stager', 'loader', 'ransomware', 'rat', 'backdoor',
    'rootkit', 'shellcode', 'c2', 'cobalt', 'threat', 'ioc', 'indicator',
  ],
  inputSchema: schema,
  description:
    'Read-only structured reconnaissance of a Mach-O binary (thin or fat/universal): slice table, segments, ' +
    'linked dylibs, entitlements, symbol search, VA<->offset mapping, capped disassembly windows and raw byte ' +
    'windows. Never executes or loads the target. Every query returns capped structured JSON. Disassembly uses ' +
    'the host objdump when available and otherwise falls back to a raw byte window.',
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
