// target_snapshot — integrity baseline, verification and restore for engagement targets.
//
// Snapshots live under .shadow/security/target-snapshots/. A baseline is assembled in a
// temporary directory, verified from the sealed copy, and renamed into place only when complete.
// Restore stages and verifies a replacement before atomically swapping it with the target.

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { contains, resolveWithin } from '../safety/workspaceJail.js';
import { EvidenceStore } from '../security/evidence.js';
import { fail, ok, type Tool, type ToolResult } from './types.js';

const MAX_TARGET_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB per target
const MAX_TARGET_FILES = 200_000;
const MAX_REPORTED_CHANGES = 2_000;
const MAX_LISTED_SNAPSHOTS = 10_000;
const READ_CHUNK = 4 * 1024 * 1024;
const SNAPSHOT_ID = /^[a-f0-9]{24}\.[a-f0-9]{8}$/;

const schema = z
  .object({
    action: z.enum(['baseline', 'verify', 'restore', 'list']),
    path: z.string().min(1).max(2000),
    snapshot_id: z.string().min(1).max(100).optional(),
    overwrite_drift: z.boolean().optional(),
    reason: z.string().max(2000).optional(),
  })
  .strict();

export type TargetSnapshotInput = z.infer<typeof schema>;

type TargetKind = 'file' | 'symlink' | 'directory';

interface ManifestEntry {
  rel: string;
  size: number;
  sha256: string;
  mode: number;
  kind: TargetKind;
  linkTarget?: string;
}

interface Manifest {
  target: string;
  root: string;
  rootKind: TargetKind;
  rootMode: number;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
  entries: ManifestEntry[];
}

interface VerifyReport {
  drifted: boolean;
  changeCount: number;
  truncated: boolean;
  changes: Change[];
}

interface Change {
  op: 'added' | 'removed' | 'changed' | 'mode';
  rel: string;
  detail?: string;
}

const safeRelative = (value: string): boolean =>
  !isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !value.includes('\0');

const manifestEntrySchema = z.object({
  rel: z.string().max(4000).refine(safeRelative, 'manifest entry path must be relative'),
  size: z.number().int().min(0).max(MAX_TARGET_BYTES),
  sha256: z.string().regex(/^(?:[a-f0-9]{64})?$/),
  mode: z.number().int().min(0).max(0o7777),
  kind: z.enum(['file', 'symlink', 'directory']),
  linkTarget: z.string().max(4000).optional(),
});

const manifestSchema = z.object({
  target: z.string().min(1).max(2000),
  root: z.string().min(1).max(4000),
  rootKind: z.enum(['file', 'symlink', 'directory']),
  rootMode: z.number().int().min(0).max(0o7777),
  createdAt: z.string().datetime(),
  fileCount: z.number().int().min(0).max(MAX_TARGET_FILES),
  totalBytes: z.number().int().min(0).max(MAX_TARGET_BYTES),
  entries: z.array(manifestEntrySchema).max(MAX_TARGET_FILES),
});

const snapshotDir = (workspaceRoot: string): string =>
  resolveWithin(workspaceRoot, '.shadow/security/target-snapshots');

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function treeHash(tree: {
  rootKind: TargetKind;
  rootMode: number;
  entries: ManifestEntry[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        tree.rootKind,
        tree.rootMode,
        tree.entries.map((entry) => [
          entry.rel,
          entry.size,
          entry.sha256,
          entry.mode,
          entry.kind,
          entry.linkTarget ?? null,
        ]),
      ]),
    )
    .digest('hex');
}

function manifestHash(manifest: Manifest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        1,
        manifest.target,
        manifest.root,
        manifest.rootKind,
        manifest.rootMode,
        manifest.createdAt,
        manifest.fileCount,
        manifest.totalBytes,
        manifest.entries.map((entry) => [
          entry.rel,
          entry.size,
          entry.sha256,
          entry.mode,
          entry.kind,
          entry.linkTarget ?? null,
        ]),
      ]),
    )
    .digest('hex');
}

/** Stream a file through SHA-256 without loading it into memory. */
function sha256File(abs: string): { hash: string; size: number } {
  const fd = openSync(abs, 'r');
  try {
    const h = createHash('sha256');
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    let size = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, READ_CHUNK, null);
      if (n === 0) break;
      h.update(chunk.subarray(0, n));
      size += n;
    }
    return { hash: h.digest('hex'), size };
  } finally {
    closeSync(fd);
  }
}

function scanTarget(root: string): {
  rootKind: TargetKind;
  rootMode: number;
  entries: ManifestEntry[];
  totalBytes: number;
} {
  const entries: ManifestEntry[] = [];
  let totalBytes = 0;

  const add = (abs: string, rel: string): void => {
    if (entries.length >= MAX_TARGET_FILES) {
      throw new Error(`Target exceeds the ${MAX_TARGET_FILES}-entry cap.`);
    }
    const st = lstatSync(abs);
    const mode = st.mode & 0o7777;
    if (st.isDirectory()) {
      entries.push({ rel, size: 0, sha256: '', mode, kind: 'directory' });
      for (const name of readdirSync(abs).sort())
        add(join(abs, name), rel ? join(rel, name) : name);
      return;
    }
    if (st.isSymbolicLink()) {
      entries.push({
        rel,
        size: 0,
        sha256: '',
        mode,
        kind: 'symlink',
        linkTarget: readlinkSync(abs),
      });
      return;
    }
    if (!st.isFile()) {
      throw new Error(`Unsupported special file in target: ${rel || '<target>'}.`);
    }
    if (totalBytes + st.size > MAX_TARGET_BYTES) {
      throw new Error(`Target exceeds the ${MAX_TARGET_BYTES / 1024 / 1024 / 1024} GiB cap.`);
    }
    const { hash, size } = sha256File(abs);
    if (totalBytes + size > MAX_TARGET_BYTES) {
      throw new Error(`Target exceeds the ${MAX_TARGET_BYTES / 1024 / 1024 / 1024} GiB cap.`);
    }
    totalBytes += size;
    entries.push({ rel, size, sha256: hash, mode, kind: 'file' });
  };

  const rootStat = lstatSync(root);
  const rootMode = rootStat.mode & 0o7777;
  if (rootStat.isDirectory()) {
    for (const name of readdirSync(root).sort()) add(join(root, name), name);
    return { rootKind: 'directory', rootMode, entries, totalBytes };
  }
  if (rootStat.isFile()) {
    add(root, '');
    return { rootKind: 'file', rootMode, entries, totalBytes };
  }
  if (rootStat.isSymbolicLink()) {
    add(root, '');
    return { rootKind: 'symlink', rootMode, entries, totalBytes };
  }
  throw new Error('Target must be a regular file, directory, or symbolic link.');
}

/** cpSync may drop special bits on both directories and nested files. Restore exact modes. */
function copyTarget(source: string, destination: string, tree: Pick<Manifest, 'rootKind' | 'rootMode' | 'entries'>): void {
  cpSync(source, destination, { dereference: false, recursive: true, verbatimSymlinks: true });
  // Never chmod a symlink: that would mutate its referent, possibly outside the copied tree.
  const nodes = tree.entries.filter((entry) => entry.kind !== 'symlink' && entry.rel !== '');
  if (tree.rootKind !== 'symlink') nodes.unshift({
    rel: '', size: 0, sha256: '', mode: tree.rootMode, kind: tree.rootKind,
  });
  // Children first: applying restrictive parent permissions must not block the rest of the copy.
  for (const entry of nodes.reverse()) {
    const from = lstatSync(join(source, entry.rel));
    const to = join(destination, entry.rel);
    const toStat = lstatSync(to);
    const kindsMatch = entry.kind === 'directory'
      ? from.isDirectory() && toStat.isDirectory()
      : from.isFile() && toStat.isFile();
    if (!kindsMatch || (from.mode & 0o7777) !== entry.mode) {
      throw new Error('Target changed while the snapshot copy was being prepared.');
    }
    chmodSync(to, entry.mode);
  }
}

function loadManifest(
  snapshotId: string,
  workspaceRoot: string,
): { manifest: Manifest; dir: string } {
  if (!SNAPSHOT_ID.test(snapshotId)) throw new Error('Snapshot id has an invalid format.');
  const dir = resolveWithin(workspaceRoot, `.shadow/security/target-snapshots/${snapshotId}`);
  const manifestPath = resolveWithin(
    workspaceRoot,
    `.shadow/security/target-snapshots/${snapshotId}/manifest.json`,
  );
  if (!existsSync(manifestPath)) {
    throw new Error(`No snapshot ${snapshotId} under .shadow/security/target-snapshots/.`);
  }
  try {
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
    ) as Manifest;
    const seen = new Set<string>();
    for (const entry of manifest.entries) {
      if (seen.has(entry.rel))
        throw new Error(`Duplicate manifest entry: ${entry.rel || '<target>'}`);
      seen.add(entry.rel);
    }
    if (manifest.fileCount !== manifest.entries.filter((entry) => entry.kind === 'file').length) {
      throw new Error('Manifest file count does not match its entries.');
    }
    const countedBytes = manifest.entries.reduce(
      (sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0),
      0,
    );
    if (manifest.totalBytes !== countedBytes) {
      throw new Error('Manifest byte count does not match its entries.');
    }
    if (manifestHash(manifest).slice(0, 24) !== snapshotId.slice(0, 24)) {
      throw new Error('Manifest no longer matches the content-addressed snapshot id.');
    }
    return { manifest, dir };
  } catch (error) {
    throw new Error(`Snapshot ${snapshotId} manifest is unreadable: ${(error as Error).message}`);
  }
}

/** Persist a unique fact receipt in the workspace SQL ledger; returns the store id. */
function writeReceipt(
  workspaceRoot: string,
  resolved: string,
  record: Record<string, unknown>,
): string {
  const store = new EvidenceStore(workspaceRoot);
  try {
    const nonce = randomUUID();
    const { ids } = store.importFindings([
      {
        title: `target_snapshot ${String(record.action)} — ${String(record.target)} — ${nonce}`,
        description: JSON.stringify(record),
        rule: `redteam-snapshot-receipt:${nonce}`,
        source: 'target_snapshot',
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

function verifyAgainst(resolved: string, manifest: Manifest): VerifyReport {
  const changes: Change[] = [];
  let changeCount = 0;
  const note = (change: Change): void => {
    changeCount++;
    if (changes.length < MAX_REPORTED_CHANGES) changes.push(change);
  };
  if (!lstatExists(resolved)) {
    note({ op: 'removed', rel: '<entire target>' });
    return { drifted: true, changeCount, truncated: false, changes };
  }

  const currentScan = scanTarget(resolved);
  if (currentScan.rootKind !== manifest.rootKind) {
    note({
      op: 'changed',
      rel: '<target>',
      detail: `kind ${manifest.rootKind} -> ${currentScan.rootKind}`,
    });
  }
  if (currentScan.rootMode !== manifest.rootMode) {
    note({
      op: 'mode',
      rel: '<target>',
      detail: `mode ${manifest.rootMode} -> ${currentScan.rootMode}`,
    });
  }
  const manifestMap = new Map<string, ManifestEntry>();
  for (const entry of manifest.entries) manifestMap.set(entry.rel, entry);
  const currentMap = new Map<string, ManifestEntry>();
  for (const entry of currentScan.entries) currentMap.set(entry.rel, entry);
  for (const entry of currentScan.entries) {
    const base = manifestMap.get(entry.rel);
    if (!base) {
      note({ op: 'added', rel: entry.rel });
      continue;
    }
    if (entry.kind !== base.kind) {
      note({ op: 'changed', rel: entry.rel, detail: `kind ${base.kind} -> ${entry.kind}` });
      continue;
    }
    if (entry.mode !== base.mode) {
      note({ op: 'mode', rel: entry.rel, detail: `mode ${base.mode} -> ${entry.mode}` });
    }
    if (entry.kind === 'file' && (entry.sha256 !== base.sha256 || entry.size !== base.size)) {
      note({
        op: 'changed',
        rel: entry.rel,
        detail: `sha ${base.sha256.slice(0, 8)} -> ${entry.sha256.slice(0, 8)}`,
      });
    }
    if (entry.kind === 'symlink' && entry.linkTarget !== base.linkTarget) {
      note({
        op: 'changed',
        rel: entry.rel,
        detail: `symlink ${base.linkTarget ?? ''} -> ${entry.linkTarget ?? ''}`,
      });
    }
  }
  for (const entry of manifest.entries) {
    if (!currentMap.has(entry.rel)) note({ op: 'removed', rel: entry.rel });
  }
  return {
    drifted: changeCount > 0,
    changeCount,
    truncated: changeCount > changes.length,
    changes,
  };
}

export const targetSnapshot: Tool<TargetSnapshotInput> = {
  name: 'target_snapshot',
  risk: 'write',
  deferred: true,
  searchAliases: [
    'target', 'snapshot', 'baseline', 'integrity', 'hash', 'checksum', 'sha256', 'manifest',
    'drift', 'tamper', 'tampering', 'restore', 'revert', 'file', 'files', 'app bundle',
    'config tree', 'directory', 'seal', 'compare', 'diff', 'unchanged', 'modified',
  ],
  inputSchema: schema,
  description:
    'Integrity baseline and restore for engagement targets (files, app bundles, config trees). ' +
    'baseline seals a copy + per-file SHA-256 manifest under .shadow/security/target-snapshots/; ' +
    'verify reports drift as a fact; restore refuses drift unless overwrite_drift is set explicitly. ' +
    'Restoring is the operator’s decision; this tool records facts.',
  async run(input, ctx): Promise<ToolResult<unknown>> {
    const start = Date.now();
    const roots = [ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])];
    let resolved: string;
    try {
      resolved = resolveWithin(roots, input.path);
    } catch (error) {
      return fail(
        'target_snapshot',
        'write',
        Date.now() - start,
        'outside_workspace',
        (error as Error).message,
      );
    }

    try {
      ctx.signal?.throwIfAborted();
      switch (input.action) {
        case 'list': {
          const base = snapshotDir(ctx.workspaceRoot);
          const out: { id: string; target: string; createdAt: string; files: number }[] = [];
          if (existsSync(base)) {
            const ids = readdirSync(base).filter((name) => SNAPSHOT_ID.test(name));
            for (const name of ids.slice(0, MAX_LISTED_SNAPSHOTS)) {
              try {
                const { manifest } = loadManifest(name, ctx.workspaceRoot);
                out.push({
                  id: name,
                  target: manifest.target,
                  createdAt: manifest.createdAt,
                  files: manifest.fileCount,
                });
              } catch {
                /* skip incomplete/corrupt snapshot dirs */
              }
            }
          }
          return ok(
            'target_snapshot',
            'write',
            Date.now() - start,
            `Known snapshots: ${out.length}.`,
            out,
          );
        }
        case 'baseline': {
          if (!lstatExists(resolved)) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'target_missing',
              'Target path does not exist.',
            );
          }
          const base = resolveWithin(ctx.workspaceRoot, '.shadow/security/target-snapshots');
          if (contains(resolved, base) || contains(base, resolved)) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'snapshot_store_overlap',
              'Target overlaps Shadow’s snapshot store; refusing a recursive/self-referential baseline.',
            );
          }
          // Preflight the live target before copying so file/byte caps are enforced up front.
          const preflight = scanTarget(resolved);
          if (ctx.dryRun) {
            return ok(
              'target_snapshot',
              'write',
              Date.now() - start,
              `Dry run: would baseline ${input.path}.`,
              { dryRun: true },
            );
          }
          mkdirSync(base, { recursive: true, mode: 0o700 });
          const tempDir = join(base, `.tmp.${randomUUID()}`);
          try {
            mkdirSync(tempDir, { mode: 0o700 });
            const sealed = join(tempDir, 'sealed');
            copyTarget(resolved, sealed, preflight);
            const scan = scanTarget(sealed);
            if (treeHash(preflight) !== treeHash(scan)) {
              throw new Error(
                'Target changed while the baseline copy was being prepared; no snapshot was published.',
              );
            }
            const manifest: Manifest = {
              target: input.path,
              root: resolved,
              rootKind: scan.rootKind,
              rootMode: scan.rootMode,
              createdAt: new Date().toISOString(),
              fileCount: scan.entries.filter((entry) => entry.kind === 'file').length,
              totalBytes: scan.totalBytes,
              entries: scan.entries,
            };
            const contentHash = manifestHash(manifest);
            const id = `${contentHash.slice(0, 24)}.${randomUUID().slice(0, 8)}`;
            writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 1), {
              flag: 'wx',
              mode: 0o600,
            });
            const finalDir = join(base, id);
            renameSync(tempDir, finalDir);
            let receiptId: string;
            try {
              receiptId = writeReceipt(ctx.workspaceRoot, resolved, {
                action: 'baseline',
                target: input.path,
                snapshotId: id,
                fileCount: manifest.fileCount,
                totalBytes: manifest.totalBytes,
              });
            } catch (error) {
              rmSync(finalDir, { recursive: true, force: true });
              throw new Error(
                `Could not record baseline receipt; snapshot rolled back: ${(error as Error).message}`,
              );
            }
            return ok(
              'target_snapshot',
              'write',
              Date.now() - start,
              `Sealed snapshot of ${input.path}: ${manifest.fileCount} files, ${(manifest.totalBytes / 1024 / 1024).toFixed(1)} MiB. Snapshot id ${id}.`,
              { snapshotId: id, receipt: receiptId },
            );
          } finally {
            if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
          }
        }
        case 'verify': {
          if (!input.snapshot_id) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'snapshot_required',
              'verify requires snapshot_id.',
            );
          }
          let manifest: Manifest;
          try {
            ({ manifest } = loadManifest(input.snapshot_id, ctx.workspaceRoot));
          } catch (error) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'snapshot_not_found',
              (error as Error).message,
            );
          }
          if (manifest.root !== resolved) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'target_mismatch',
              'Snapshot baseline was taken against a different target path.',
            );
          }
          const report = verifyAgainst(resolved, manifest);
          const headline = report.drifted
            ? `DRIFT: ${report.changeCount} change(s) since baseline${report.truncated ? ` (first ${report.changes.length} returned)` : ''}.`
            : `CLEAN: target matches baseline (${manifest.fileCount} files).`;
          if (ctx.dryRun) {
            return ok('target_snapshot', 'write', Date.now() - start, `Dry run: ${headline}`, {
              ...report,
              dryRun: true,
            });
          }
          const receiptId = writeReceipt(ctx.workspaceRoot, resolved, {
            action: 'verify',
            target: input.path,
            snapshotId: input.snapshot_id,
            verdict: report.drifted ? 'DRIFT' : 'CLEAN',
            changes: report.changeCount,
          });
          return ok('target_snapshot', 'write', Date.now() - start, headline, {
            ...report,
            receipt: receiptId,
          });
        }
        case 'restore': {
          if (!input.snapshot_id) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'snapshot_required',
              'restore requires snapshot_id.',
            );
          }
          let manifest: Manifest;
          let dir: string;
          try {
            ({ manifest, dir } = loadManifest(input.snapshot_id, ctx.workspaceRoot));
          } catch (error) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'snapshot_not_found',
              (error as Error).message,
            );
          }
          if (manifest.root !== resolved) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'target_mismatch',
              'Snapshot baseline was taken against a different target path.',
            );
          }
          const sealed = join(dir, 'sealed');
          if (!existsSync(sealed)) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'sealed_missing',
              'Sealed copy is missing from the snapshot store.',
            );
          }
          const sealedCheck = verifyAgainst(sealed, manifest);
          if (sealedCheck.drifted) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'sealed_mismatch',
              `Sealed copy no longer matches its manifest (${sealedCheck.changeCount} change(s)); refusing restore.`,
            );
          }
          const drift = verifyAgainst(resolved, manifest);
          if (drift.drifted && !input.overwrite_drift) {
            return fail(
              'target_snapshot',
              'write',
              Date.now() - start,
              'drift_refused',
              `Target has ${drift.changeCount} change(s) since baseline. Restore refused — pass overwrite_drift: true to accept explicitly (operator decision).`,
            );
          }
          if (ctx.dryRun) {
            return ok(
              'target_snapshot',
              'write',
              Date.now() - start,
              `Dry run: would restore snapshot ${input.snapshot_id} over ${input.path}${drift.drifted ? ' (drift accepted)' : ''}.`,
              { dryRun: true },
            );
          }

          const parent = dirname(resolved);
          const stage = resolveWithin(roots, join(parent, `.shadow-restore-stage.${randomUUID()}`));
          const previous = resolveWithin(
            roots,
            join(parent, `.shadow-restore-previous.${randomUUID()}`),
          );
          let movedPrevious = false;
          let acceptedDrift = drift.drifted;
          try {
            copyTarget(sealed, stage, manifest);
            const stageCheck = verifyAgainst(stage, manifest);
            if (stageCheck.drifted) {
              throw new Error(
                `Staged restore failed manifest verification (${stageCheck.changeCount} change(s)).`,
              );
            }
            const latestDrift = verifyAgainst(resolved, manifest);
            acceptedDrift ||= latestDrift.drifted;
            if (latestDrift.drifted && !input.overwrite_drift) {
              return fail(
                'target_snapshot',
                'write',
                Date.now() - start,
                'drift_refused',
                'Target changed while restore was being prepared; refusing to overwrite it.',
              );
            }
            try {
              renameSync(resolved, previous);
              movedPrevious = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !input.overwrite_drift) {
                throw error;
              }
            }
            if (movedPrevious) {
              const movedDrift = verifyAgainst(previous, manifest);
              acceptedDrift ||= movedDrift.drifted;
              if (movedDrift.drifted && !input.overwrite_drift) {
                renameSync(previous, resolved);
                movedPrevious = false;
                return fail(
                  'target_snapshot',
                  'write',
                  Date.now() - start,
                  'drift_refused',
                  'Target changed while restore was being prepared; refusing to overwrite it.',
                );
              }
            }
            renameSync(stage, resolved);
            let receiptId: string;
            try {
              receiptId = writeReceipt(ctx.workspaceRoot, resolved, {
                action: 'restore',
                target: input.path,
                snapshotId: input.snapshot_id,
                overwriteDrift: acceptedDrift,
                reason: input.reason ?? '',
              });
            } catch (error) {
              const restoredCheck = verifyAgainst(resolved, manifest);
              if (restoredCheck.drifted) {
                throw new Error(
                  `Could not record restore receipt, and the restored target changed before rollback.${movedPrevious ? ` Prior target retained at ${previous}.` : ''} Receipt error: ${(error as Error).message}`,
                );
              }
              rmSync(resolved, { recursive: true, force: true });
              if (movedPrevious) renameSync(previous, resolved);
              movedPrevious = false;
              throw new Error(
                `Could not record restore receipt; target rolled back: ${(error as Error).message}`,
              );
            }
            let cleanupWarning = '';
            if (movedPrevious) {
              try {
                rmSync(previous, { recursive: true, force: true });
                movedPrevious = false;
              } catch (error) {
                cleanupWarning = ` Prior target retained at ${previous}: ${(error as Error).message}`;
              }
            }
            return ok(
              'target_snapshot',
              'write',
              Date.now() - start,
              `Restored snapshot ${input.snapshot_id} over ${input.path}.${cleanupWarning}`,
              { receipt: receiptId, previousPath: cleanupWarning ? previous : undefined },
            );
          } catch (error) {
            if (movedPrevious && !existsSync(resolved) && existsSync(previous)) {
              renameSync(previous, resolved);
              movedPrevious = false;
            }
            throw error;
          } finally {
            if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
            // If cleanup of a successfully replaced prior tree failed, keep it as a recoverable
            // sibling instead of recursively deleting an uncertain path here.
          }
        }
      }
    } catch (error) {
      return fail(
        'target_snapshot',
        'write',
        Date.now() - start,
        'snapshot_error',
        (error as Error).message,
      );
    }
  },
};
