// patch_bytes — byte-exact patching of Mach-O images with mandatory pre/post proof.
//
// A patch is allowed only when the expected bytes match, the entire range stays inside the
// selected slice (and, for VA addressing, one file-backed segment), and a durable unique receipt
// can be recorded. Writes use a same-directory temporary file and atomic rename. Revert verifies
// both the backup and the current patched image before restoring anything.

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { z } from 'zod';
import { resolveWithin } from '../safety/workspaceJail.js';
import {
  layout,
  parseSlice,
  vaToOffset,
  MachoError,
  type BinaryLayout,
  type FatSlice,
  type MachoSliceInfo,
} from '../security/macho.js';
import { EvidenceStore } from '../security/evidence.js';
import { fail, ok, type Tool, type ToolResult } from './types.js';

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_PATCH_BYTES = 4096;
const MAX_HEX_DIGITS = 2 * MAX_PATCH_BYTES;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

const schema = z
  .object({
    action: z.enum(['patch', 'revert']),
    path: z.string().min(1).max(2000),
    arch: z.string().max(16).optional(),
    va: z.string().max(20).optional(),
    offset: z.number().int().min(0).optional(),
    expected_hex: z.string().min(2).max(MAX_HEX_DIGITS).optional(),
    new_hex: z.string().min(2).max(MAX_HEX_DIGITS).optional(),
    receipt_id: z.string().min(1).max(100).optional(),
    reason: z.string().max(2000).optional(),
  })
  .strict();

export type PatchBytesInput = z.infer<typeof schema>;

interface ReceiptRecord {
  kind: 'patch_bytes' | 'patch_bytes_revert';
  target: string;
  arch?: string;
  va?: string;
  offset?: number;
  bytes?: { expected: string; new: string };
  backupPath?: string;
  originalSha256?: string;
  patchedSha256?: string;
  revertsReceipt?: string;
  reason?: string;
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hexToBytes(hex: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new MachoError('bad_hex', 'Hex strings must have an even number of hex digits.');
  }
  return Buffer.from(hex, 'hex');
}

function selectSlice(parsed: BinaryLayout, arch: string | undefined): FatSlice {
  const candidates = parsed.kind === 'fat' ? parsed.slices : [parsed.slice];
  if (arch) {
    const found = candidates.find((slice) => slice.archName === arch);
    if (!found) {
      throw new MachoError(
        'unknown_arch',
        `No slice for ${arch}. Available: ${candidates.map((slice) => slice.archName).join(', ')}.`,
      );
    }
    return found;
  }
  if (candidates.length === 1) return candidates[0]!;
  throw new MachoError(
    'arch_required',
    `Fat image with ${candidates.length} slices; pass arch. Available: ${candidates.map((slice) => slice.archName).join(', ')}.`,
  );
}

function atomicReplace(
  path: string,
  bytes: Buffer,
  mode: number,
  expectedCurrentSha256: string,
): void {
  const temp = `${path}.patchbytes.tmp.${randomUUID()}`;
  try {
    // Creation permissions are filtered by umask. Set the exact original mode only after
    // writing (writes can also clear setuid/setgid bits on some platforms).
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    chmodSync(temp, mode);
    const currentStat = lstatSync(path);
    if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
      throw new MachoError('target_changed', 'Target is no longer a regular file.');
    }
    if ((currentStat.mode & 0o7777) !== mode || currentStat.size !== bytes.length) {
      throw new MachoError('target_changed', 'Target metadata changed while replacement was being prepared.');
    }
    if (digest(readFileSync(path)) !== expectedCurrentSha256) {
      throw new MachoError('target_changed', 'Target changed while replacement was being prepared.');
    }
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) {
      try {
        unlinkSync(temp);
      } catch {
        /* best effort; the random path is reported by the surrounding operation on failure */
      }
    }
  }
}

/** Persist a unique fact receipt in the workspace SQL ledger; returns its finding id. */
function writeReceipt(
  ctx: { workspaceRoot: string },
  resolved: string,
  record: ReceiptRecord,
): string {
  const store = new EvidenceStore(ctx.workspaceRoot);
  try {
    const nonce = randomUUID();
    const { ids } = store.importFindings([
      {
        title: `patch_bytes ${record.kind} — ${record.target} — ${nonce}`,
        description: JSON.stringify(record),
        rule: `redteam-patch-receipt:${nonce}`,
        source: 'patch_bytes',
        path: resolved,
        severity: 'none',
      },
    ]);
    if (!ids[0]) throw new Error('Evidence ledger did not return a receipt id.');
    return ids[0];
  } finally {
    store.close();
  }
}

/** Look up an authentic patch receipt and return its parsed record (or null). */
function readReceipt(
  ctx: { workspaceRoot: string },
  receiptId: string,
): { record: ReceiptRecord; finding: { path: string } } | null {
  const store = new EvidenceStore(ctx.workspaceRoot);
  try {
    const finding = store.get(receiptId);
    if (finding.source !== 'patch_bytes' || !finding.rule.startsWith('redteam-patch-receipt:'))
      return null;
    let record: ReceiptRecord;
    try {
      record = JSON.parse(finding.description) as ReceiptRecord;
    } catch {
      return null;
    }
    if (
      record.kind !== 'patch_bytes' ||
      typeof record.backupPath !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.originalSha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(record.patchedSha256 ?? '')
    ) {
      return null;
    }
    return { record, finding };
  } catch {
    return null;
  } finally {
    store.close();
  }
}

export const patchBytes: Tool<PatchBytesInput> = {
  name: 'patch_bytes',
  risk: 'write',
  deferred: true,
  searchAliases: [
    'patch', 'patching', 'binary', 'malware', 'sample', 'modify', 'edit', 'hex',
    'byte', 'bytes', 'write', 'revert', 'rollback', 'backup', 'offset', 'macho',
    'instrument', 'tamper', 'disable', 'nop', 'hijack', 'implant', 'payload',
  ],
  inputSchema: schema,
  description:
    'Byte-exact Mach-O patching with a mandatory pre/post proof. Requires expected_hex to ' +
    'match the bytes actually on disk before writing (fails closed on mismatch), patches ' +
    'inside the selected fat slice only, writes atomically, keeps a full pre-patch backup, ' +
    'and records a unique receipt in the SQL evidence ledger. `revert` restores the original ' +
    'only when the backup and current patched image still match that receipt.',
  async run(input, ctx): Promise<ToolResult<unknown>> {
    const start = Date.now();
    let resolved: string;
    try {
      resolved = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path);
    } catch (error) {
      return fail(
        'patch_bytes',
        'write',
        Date.now() - start,
        'outside_workspace',
        (error as Error).message,
      );
    }

    try {
      ctx.signal?.throwIfAborted();
      const st = statSync(resolved);
      if (!st.isFile()) {
        return fail(
          'patch_bytes',
          'write',
          Date.now() - start,
          'not_a_file',
          'Target is not a regular file.',
        );
      }
      if (st.size > MAX_FILE_BYTES) {
        return fail(
          'patch_bytes',
          'write',
          Date.now() - start,
          'too_large',
          `Image is above the ${MAX_FILE_BYTES / 1024 / 1024} MiB cap.`,
        );
      }
      const buf = readFileSync(resolved);
      const mode = st.mode & 0o7777;
      const currentSha256 = digest(buf);

      if (input.action === 'revert') {
        if (!input.receipt_id) {
          return fail(
            'patch_bytes',
            'write',
            Date.now() - start,
            'receipt_required',
            'revert requires receipt_id.',
          );
        }
        const receipt = readReceipt(ctx, input.receipt_id);
        if (
          !receipt ||
          !receipt.record.backupPath ||
          !receipt.record.originalSha256 ||
          !receipt.record.patchedSha256
        ) {
          return fail(
            'patch_bytes',
            'write',
            Date.now() - start,
            'receipt_not_found',
            `No authentic patch receipt ${input.receipt_id} with a restorable backup exists in this workspace ledger.`,
          );
        }
        if (receipt.finding.path !== resolved) {
          return fail(
            'patch_bytes',
            'write',
            Date.now() - start,
            'receipt_target_mismatch',
            'Receipt belongs to a different target path.',
          );
        }
        const backupPath = receipt.record.backupPath;
        const prefix = `${resolved}.patchbytes.bak.`;
        const suffix = backupPath.startsWith(prefix) ? backupPath.slice(prefix.length) : '';
        if (!UUID.test(suffix)) {
          return fail(
            'patch_bytes',
            'write',
            Date.now() - start,
            'backup_mismatch',
            'Receipt backup path is not a generated sibling of this target.',
          );
        }
        let backupBuf: Buffer;
        try {
          const backupStat = lstatSync(backupPath);
          if (!backupStat.isFile() || backupStat.isSymbolicLink())
            throw new Error('backup is not a regular file');
          backupBuf = readFileSync(backupPath);
        } catch (error) {
          return fail(
            'patch_bytes',
            'write',
            Date.now() - start,
            'backup_missing',
            `Pre-patch backup is unavailable: ${(error as Error).message}`,
          );
        }
        if (
          backupBuf.length !== buf.length ||
          digest(backupBuf) !== receipt.record.originalSha256
        ) {
          return fail(
            'patch_bytes',
            'write',
            Date.now() - start,
            'backup_mismatch',
            'Backup bytes do not match the receipt; refusing restore.',
          );
        }
        if (currentSha256 !== receipt.record.patchedSha256) {
          return fail(
            'patch_bytes',
            'write',
            Date.now() - start,
            'target_drift',
            'Target changed after this patch; refusing to overwrite later changes with an old backup.',
          );
        }
        if (ctx.dryRun) {
          return ok(
            'patch_bytes',
            'write',
            Date.now() - start,
            `Dry run: would revert receipt ${input.receipt_id}.`,
            { dryRun: true },
          );
        }
        atomicReplace(resolved, backupBuf, mode, currentSha256);
        let revertReceipt: string;
        try {
          revertReceipt = writeReceipt(ctx, resolved, {
            kind: 'patch_bytes_revert',
            target: input.path,
            revertsReceipt: input.receipt_id,
            originalSha256: receipt.record.patchedSha256,
            patchedSha256: receipt.record.originalSha256,
            reason: input.reason ?? '',
          });
        } catch (error) {
          try {
            atomicReplace(resolved, buf, mode, receipt.record.originalSha256);
          } catch (rollbackError) {
            throw new Error(
              `Revert receipt failed and rollback also failed. Original backup remains at ${backupPath}. Receipt error: ${(error as Error).message}. Rollback error: ${(rollbackError as Error).message}`,
            );
          }
          throw new Error(
            `Could not record revert receipt; target returned to its patched state: ${(error as Error).message}`,
          );
        }
        try {
          unlinkSync(backupPath);
        } catch {
          return ok(
            'patch_bytes',
            'write',
            Date.now() - start,
            `Reverted patch ${input.receipt_id}; original bytes restored. Backup cleanup is still needed at ${backupPath}.`,
            { receipt: revertReceipt, backupPath },
          );
        }
        return ok(
          'patch_bytes',
          'write',
          Date.now() - start,
          `Reverted patch ${input.receipt_id}; original bytes restored.`,
          { receipt: revertReceipt },
        );
      }

      if ((input.va ? 1 : 0) + (typeof input.offset === 'number' ? 1 : 0) !== 1) {
        return fail(
          'patch_bytes',
          'write',
          Date.now() - start,
          'location_required',
          'patch requires exactly one of va or offset.',
        );
      }
      if (!input.expected_hex || !input.new_hex) {
        return fail(
          'patch_bytes',
          'write',
          Date.now() - start,
          'bytes_required',
          'patch requires expected_hex and new_hex.',
        );
      }
      const expected = hexToBytes(input.expected_hex);
      const next = hexToBytes(input.new_hex);
      if (expected.length !== next.length) {
        return fail(
          'patch_bytes',
          'write',
          Date.now() - start,
          'length_mismatch',
          'expected_hex and new_hex must be the same length (in-place patch).',
        );
      }
      if (next.length > MAX_PATCH_BYTES) {
        return fail(
          'patch_bytes',
          'write',
          Date.now() - start,
          'too_many_bytes',
          `Patch exceeds the ${MAX_PATCH_BYTES}-byte cap.`,
        );
      }

      const parsed: BinaryLayout = layout(buf);
      const slice = selectSlice(parsed, input.arch);
      const info: MachoSliceInfo = parseSlice(buf, slice);
      let fileOffset: number;
      let vaHex: string | undefined;
      if (input.va) {
        if (!/^0x[0-9a-fA-F]{1,16}$/.test(input.va)) {
          return fail(
            'patch_bytes',
            'write',
            Date.now() - start,
            'bad_va',
            'va must be 0x-prefixed hex.',
          );
        }
        const va = BigInt(input.va);
        const mapping = vaToOffset(info, va, slice);
        if (!mapping) {
          return fail(
            'patch_bytes',
            'write',
            Date.now() - start,
            'va_unmapped',
            `VA ${input.va} does not map to file bytes in slice ${slice.archName}.`,
          );
        }
        const endMapping = vaToOffset(info, va + BigInt(expected.length - 1), slice);
        if (
          !endMapping ||
          endMapping.segment !== mapping.segment ||
          endMapping.offset !== mapping.offset + expected.length - 1
        ) {
          return fail(
            'patch_bytes',
            'write',
            Date.now() - start,
            'range_unmapped',
            'Patch range leaves the mapped file-backed segment.',
          );
        }
        fileOffset = mapping.offset;
        vaHex = input.va;
      } else {
        fileOffset = input.offset!;
      }
      const sliceEnd = slice.offset + slice.size;
      if (fileOffset < slice.offset || expected.length > sliceEnd - fileOffset) {
        return fail(
          'patch_bytes',
          'write',
          Date.now() - start,
          'offset_out_of_slice',
          `Patch range is outside the ${slice.archName} slice.`,
        );
      }
      const actual = buf.subarray(fileOffset, fileOffset + expected.length);
      if (!actual.equals(expected)) {
        return fail(
          'patch_bytes',
          'write',
          Date.now() - start,
          'expected_mismatch',
          `Expected bytes not found at ${vaHex ?? 'offset ' + fileOffset}: found ${actual.toString('hex')}, expected ${expected.toString('hex')}.`,
        );
      }
      if (ctx.dryRun) {
        return ok(
          'patch_bytes',
          'write',
          Date.now() - start,
          `Dry run: would patch ${expected.length} byte(s) at ${vaHex ?? 'offset ' + fileOffset} in slice ${slice.archName}.`,
          { dryRun: true },
        );
      }

      const backupPath = `${resolved}.patchbytes.bak.${randomUUID()}`;
      writeFileSync(backupPath, buf, { flag: 'wx', mode: 0o600 });
      const patched = Buffer.from(buf);
      patched.set(next, fileOffset);
      const patchedSha256 = digest(patched);
      try {
        chmodSync(backupPath, mode);
        atomicReplace(resolved, patched, mode, currentSha256);
      } catch (error) {
        try {
          unlinkSync(backupPath);
        } catch {
          /* best effort; the error below remains the actionable failure */
        }
        throw error;
      }
      let receipt: string;
      try {
        receipt = writeReceipt(ctx, resolved, {
          kind: 'patch_bytes',
          target: input.path,
          arch: slice.archName,
          va: vaHex,
          offset: fileOffset,
          bytes: { expected: expected.toString('hex'), new: next.toString('hex') },
          backupPath,
          originalSha256: currentSha256,
          patchedSha256,
          reason: input.reason ?? '',
        });
      } catch (error) {
        try {
          atomicReplace(resolved, buf, mode, patchedSha256);
          unlinkSync(backupPath);
        } catch (rollbackError) {
          throw new Error(
            `Patch receipt failed and rollback also failed. Backup remains at ${backupPath}. Receipt error: ${(error as Error).message}. Rollback error: ${(rollbackError as Error).message}`,
          );
        }
        throw new Error(
          `Could not record patch receipt; target rolled back: ${(error as Error).message}`,
        );
      }
      return ok(
        'patch_bytes',
        'write',
        Date.now() - start,
        `Patched ${next.length} byte(s) at ${vaHex ?? 'offset ' + fileOffset} in slice ${slice.archName} of ${input.path}. Backup retained; receipt ${receipt}.`,
        { receipt, backupPath },
      );
    } catch (error) {
      const code = error instanceof MachoError ? error.code : 'patch_error';
      return fail('patch_bytes', 'write', Date.now() - start, code, (error as Error).message);
    }
  },
};
