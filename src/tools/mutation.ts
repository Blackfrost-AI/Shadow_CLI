import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWrite } from './util.js';

/**
 * Durable, approval-bound file mutation journal.
 *
 * Purpose: bind a preview approval to EXACT file bytes, record every operation
 * durably enough that a crash can never be mistaken for a clean state, and
 * reconcile interrupted operations honestly — never replay them.
 *
 * Honest limitations (by design, documented for reviewers):
 * - Multi-file writes are NOT atomic. The journal guarantees detection, not
 *   atomicity: an `applying`/`rolling-back` marker is fsynced BEFORE the first
 *   target write, so an interrupted operation is always visible to reconcile().
 * - Same-user local attackers racing symlink swaps cannot be fully defeated
 *   with Node's path-based API. Every target is revalidated immediately before
 *   each write; a residual race remains and requires OS-level sandboxing
 *   (which Shadow layers on top).
 * - Locks are advisory files keyed by pid. A pid-reuse race is possible after a
 *   holder crashes; locks held by a provably-dead pid are reclaimed.
 * - Journal writes are fsynced (file + parent directory). Target writes use the
 *   same rename-atomic path as every other Shadow edit; after a crash, their
 *   true on-disk state is reported per file by reconcile().
 */

export type MutationState =
  | 'prepared' | 'approved' | 'applying' | 'applied' | 'rolling-back' | 'rolled-back' | 'unknown';

/** Stored form: exact bytes, base64. `before: null` means the file must not exist. */
export interface StoredMutationFile { path: string; before: string | null; after: string }
export interface MutationRecord {
  version: 2;
  id: string;
  state: MutationState;
  approvalDigest: string;
  createdAt: string;
  files: Array<{ path: string; beforeB64: string | null; afterB64: string }>;
}
export class MutationError extends Error {}

export interface MutationJournalOptions {
  /** Test hook: replaces the target writer. */
  targetWrite?: (path: string, bytes: Buffer) => void;
  /** Test hook: replaces the journal-record writer. */
  journalWrite?: (path: string, content: string) => void;
  /** Test hook: called instead of unlink when rollback removes a created file. */
  targetUnlink?: (path: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATES: readonly MutationState[] = [
  'prepared', 'approved', 'applying', 'applied', 'rolling-back', 'rolled-back', 'unknown',
];
const MAX_BYTES = 1024 * 1024;

export function mutationDigest(
  files: Array<{ path: string; beforeB64: string | null; afterB64: string }>,
): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

/** Per-file truth about an interrupted operation. */
export interface ReconciledFile {
  path: string;
  /** What the file on disk actually contains, relative to the record. */
  status: 'matches-before' | 'matches-after' | 'drifted' | 'missing';
}
export interface ReconciledOperation {
  id: string;
  state: MutationState;
  /** Populated when the record itself could not be trusted. */
  recordProblem?: string;
  files: ReconciledFile[];
}

export function createMutationJournal(workspaceRoot: string, options: MutationJournalOptions = {}) {
  const root = realpathSync(resolve(workspaceRoot));
  const journalDir = join(root, '.shadow', 'mutations');
  const reservedPrefix = `${journalDir}${sep}`;
  const operationPath = (id: string) => join(journalDir, `${id}.json`);
  const lockPath = (id: string) => join(journalDir, `${id}.lock`);

  const targetWrite = options.targetWrite ?? ((path: string, bytes: Buffer): void => {
    atomicWrite(path, bytes.toString('utf8'));
  });
  const journalWrite = options.journalWrite ?? durableWrite;
  const targetUnlink = options.targetUnlink ?? unlinkSync;

  function durableWrite(path: string, content: string): void {
    const tmp = join(dirname(path), `.${path.split(sep).pop()}.${process.pid}.${Date.now()}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    // Make the rename itself durable. Directory fsync is unsupported on
    // Windows; there the file-level fsync above is the best available.
    try {
      const dirFd = openSync(dirname(path), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* best effort on platforms without directory fsync */ }
  }

  /** The journal directory tree must be real directories we created — never symlinks. */
  function ensureJournalDirectory(): void {
    let current = root;
    for (const part of ['.shadow', 'mutations']) {
      current = resolve(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new MutationError(`Journal path must be a real directory: ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(current, { mode: 0o700 });
        chmodSync(current, 0o700);
      }
    }
  }

  /**
   * Validate a workspace-relative target. Resolves every existing ancestor,
   * rejects symlinks anywhere on the path, and rejects escapes from the root.
   */
  function target(input: string): string {
    if (!input || input.includes('\0')) throw new MutationError('Mutation target must be a nonempty path');
    if (isAbsolute(input)) throw new MutationError(`Mutation target must be workspace-relative: ${input}`);
    const absolute = resolve(root, input);
    const normalized = relative(root, absolute);
    if (!normalized || normalized === '..' || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
      throw new MutationError(`Mutation target must stay inside the workspace: ${input}`);
    }
    const parts = normalized.split(sep);
    let current = root;
    let exists = true;
    for (let index = 0; index < parts.length; index++) {
      current = resolve(current, parts[index]!);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) throw new MutationError(`Symbolic-link targets are unsupported: ${input}`);
        if (index === parts.length - 1) {
          if (!stat.isFile()) throw new MutationError(`Mutation target must be a regular file: ${input}`);
        } else if (!stat.isDirectory()) {
          throw new MutationError(`Mutation parent must be a directory: ${input}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (index < parts.length - 1) throw new MutationError(`Mutation parent must already exist: ${input}`);
        exists = false;
      }
    }
    const canonical = exists ? realpathSync(absolute) : realpathSync(dirname(absolute));
    const expected = exists ? absolute : dirname(absolute);
    if (canonical !== expected) throw new MutationError(`Workspace path changed: ${input}`);
    if (absolute === journalDir || absolute.startsWith(reservedPrefix)) {
      throw new MutationError('Journal files cannot be mutation targets');
    }
    return absolute;
  }

  function readBytes(path: string): Buffer | null {
    try {
      return readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  function decode(raw: unknown): MutationRecord {
    let parsed: unknown;
    try { parsed = JSON.parse(String(raw)); } catch { throw new MutationError('Invalid mutation journal record'); }
    if (!parsed || typeof parsed !== 'object') throw new MutationError('Invalid mutation journal record');
    const record = parsed as Partial<MutationRecord>;
    if (record.version !== 2) throw new MutationError('Unsupported mutation journal version');
    if (typeof record.id !== 'string' || !UUID.test(record.id)) throw new MutationError('Invalid mutation journal metadata');
    if (typeof record.state !== 'string' || !STATES.includes(record.state as MutationState)) {
      throw new MutationError('Invalid mutation journal metadata');
    }
    if (typeof record.approvalDigest !== 'string' || !DIGEST.test(record.approvalDigest)) {
      throw new MutationError('Invalid mutation journal metadata');
    }
    if (typeof record.createdAt !== 'string' || !ISO.test(record.createdAt)) {
      throw new MutationError('Invalid mutation journal metadata');
    }
    if (!Array.isArray(record.files) || record.files.length === 0) {
      throw new MutationError('Invalid mutation journal record');
    }
    for (const file of record.files) {
      if (!file || typeof file.path !== 'string') throw new MutationError('Invalid mutation journal record');
      if (typeof file.afterB64 !== 'string' || !B64.test(file.afterB64)) throw new MutationError('Invalid mutation journal record');
      if (file.beforeB64 !== null && (typeof file.beforeB64 !== 'string' || !B64.test(file.beforeB64))) {
        throw new MutationError('Invalid mutation journal record');
      }
    }
    if (new Set(record.files.map((file) => file.path)).size !== record.files.length) {
      throw new MutationError('Duplicate targets in journal record');
    }
    if (record.approvalDigest !== mutationDigest(record.files)) {
      throw new MutationError('Approval digest does not match journal contents');
    }
    return record as MutationRecord;
  }

  function read(id: string): MutationRecord {
    if (!UUID.test(id)) throw new MutationError('Invalid mutation id');
    ensureJournalDirectory();
    const path = operationPath(id);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new MutationError('Journal record must be a real file');
    return decode(readFileSync(path));
  }

  function persist(record: MutationRecord): void {
    ensureJournalDirectory();
    journalWrite(operationPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  function assertDigest(actual: string, expected: string): void {
    if (!DIGEST.test(expected)) throw new MutationError('Approval digest must be a lowercase SHA256 hex digest');
    const left = Buffer.from(actual, 'hex');
    const right = Buffer.from(expected, 'hex');
    if (!timingSafeEqual(left, right)) throw new MutationError('Approval does not bind to this exact content');
  }

  function assertLiveTargets(record: MutationRecord): void {
    for (const file of record.files) {
      const path = target(file.path); // revalidate immediately; throws on drift/symlink/escape
      const actual = readBytes(path);
      const before = file.beforeB64 === null ? null : Buffer.from(file.beforeB64, 'base64');
      if (before === null) {
        if (actual !== null) {
          throw new MutationError(`File differs from its recorded precondition: ${file.path}`);
        }
      } else if (actual === null || !actual.equals(before)) {
        throw new MutationError(`File differs from its recorded precondition: ${file.path}`);
      }
    }
  }

  /**
   * Advisory cross-process lock. Fails closed when any live process holds it;
   * reclaims a lock only when its holder is provably dead.
   */
  function acquireLock(id: string): void {
    const path = lockPath(id);
    const payload = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, payload); fsyncSync(fd); } finally { closeSync(fd); }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder: number | undefined;
    try {
      holder = JSON.parse(readFileSync(path, 'utf8')).pid;
    } catch { throw new MutationError('A mutation operation is locked by an unreadable holder'); }
    if (typeof holder !== 'number') throw new MutationError('A mutation operation is locked by an unreadable holder');
    if (holder === process.pid) throw new MutationError('This mutation operation is already in progress');
    try {
      process.kill(holder, 0);
      throw new MutationError(`A mutation operation is in progress (pid ${holder})`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      // Holder is provably dead: reclaim exactly once.
      unlinkSync(path);
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, payload); fsyncSync(fd); } finally { closeSync(fd); }
    }
  }

  function releaseLock(id: string): void {
    try { unlinkSync(lockPath(id)); } catch { /* already gone */ }
  }

  /** Fail closed on targets whose decoded view cannot round-trip the caller's preview. */
  function bindPreview(file: StoredMutationFile): { path: string; beforeB64: string | null; afterB64: string } {
    const absolute = target(file.path);
    const actualBytes = readBytes(absolute);
    const actualText = actualBytes === null ? null : actualBytes.toString('utf8');
    if (actualText !== file.before) {
      throw new MutationError(`Recorded precondition does not match the file: ${file.path}`);
    }
    const afterBytes = Buffer.from(file.after, 'utf8');
    if (afterBytes.length > MAX_BYTES) throw new MutationError(`Mutation exceeds 1 MiB: ${file.path}`);
    if (actualBytes !== null && actualBytes.length > MAX_BYTES) {
      throw new MutationError(`Mutation exceeds 1 MiB: ${file.path}`);
    }
    // Bind the exact bytes, not the lossy text view: rollback restores reality.
    return {
      path: relative(root, absolute),
      beforeB64: actualBytes === null ? null : actualBytes.toString('base64'),
      afterB64: afterBytes.toString('base64'),
    };
  }

  function prepare(files: StoredMutationFile[]): MutationRecord {
    if (!Array.isArray(files) || files.length === 0) throw new MutationError('Prepare requires a nonempty file array');
    for (const file of files) {
      if (typeof file.path !== 'string' || typeof file.after !== 'string'
        || (file.before !== null && typeof file.before !== 'string')) {
        throw new MutationError('Files require path, before string|null, and after');
      }
    }
    const bound = files.map(bindPreview);
    if (new Set(bound.map((file) => file.path)).size !== bound.length) {
      throw new MutationError('Mutation targets must be unique');
    }
    const record: MutationRecord = {
      version: 2, id: randomUUID(), state: 'prepared',
      approvalDigest: mutationDigest(bound), createdAt: new Date().toISOString(), files: bound,
    };
    persist(record);
    return record;
  }

  function approve(id: string, approvalDigest: string): MutationRecord {
    acquireLock(id);
    try {
      const record = read(id);
      if (record.state !== 'prepared') throw new MutationError('Only a prepared mutation can be approved');
      assertDigest(record.approvalDigest, approvalDigest);
      record.state = 'approved';
      persist(record);
      return record;
    } finally { releaseLock(id); }
  }

  function apply(id: string, approvalDigest: string): MutationRecord {
    acquireLock(id);
    try {
      const record = read(id);
      if (record.state !== 'approved') throw new MutationError('Only an approved mutation can be applied');
      assertDigest(record.approvalDigest, approvalDigest);
      assertLiveTargets(record);
      // Durable in-progress marker BEFORE the first target write: a crash here
      // is always visible to reconcile(), never mistaken for a clean state.
      record.state = 'applying';
      persist(record);
      try {
        for (const file of record.files) {
          const path = target(file.path); // revalidate immediately before each write
          targetWrite(path, Buffer.from(file.afterB64, 'base64'));
        }
      } catch (error) {
        record.state = 'unknown';
        persist(record);
        throw error;
      }
      record.state = 'applied';
      persist(record);
      return record;
    } finally { releaseLock(id); }
  }

  function rollBack(id: string, approvalDigest: string): MutationRecord {
    acquireLock(id);
    try {
      const record = read(id);
      if (record.state !== 'applied') throw new MutationError('Only an applied mutation can be rolled back');
      assertDigest(record.approvalDigest, approvalDigest);
      // The applied state must already be the exact bytes we wrote.
      for (const file of record.files) {
        const path = target(file.path);
        const actual = readBytes(path);
        const after = Buffer.from(file.afterB64, 'base64');
        if (actual === null || !actual.equals(after)) {
          throw new MutationError(`File differs from its applied content: ${file.path}`);
        }
      }
      record.state = 'rolling-back';
      persist(record);
      try {
        for (const file of record.files) {
          const path = target(file.path); // revalidate immediately before each write
          if (file.beforeB64 === null) targetUnlink(path);
          else targetWrite(path, Buffer.from(file.beforeB64, 'base64'));
        }
      } catch (error) {
        record.state = 'unknown';
        persist(record);
        throw error;
      }
      record.state = 'rolled-back';
      persist(record);
      return record;
    } finally { releaseLock(id); }
  }

  function classifyFile(file: { path: string; beforeB64: string | null; afterB64: string }): ReconciledFile {
    const before = file.beforeB64 === null ? null : Buffer.from(file.beforeB64, 'base64');
    const after = Buffer.from(file.afterB64, 'base64');
    let actual: Buffer | null;
    try {
      actual = readBytes(target(file.path));
    } catch {
      return { path: file.path, status: 'drifted' };
    }
    if (actual === null) return { path: file.path, status: 'missing' };
    if (before !== null && actual.equals(before)) return { path: file.path, status: 'matches-before' };
    if (actual.equals(after)) return { path: file.path, status: 'matches-after' };
    return { path: file.path, status: 'drifted' };
  }

  /**
   * Report every interrupted operation with per-file truth. Never replays,
   * never throws on a single bad record: one corrupted entry must not hide the
   * others. `unknown` is surfaced the same way — it means "effect unclear".
   */
  function reconcile(): ReconciledOperation[] {
    ensureJournalDirectory();
    const results: ReconciledOperation[] = [];
    for (const name of readdirSync(journalDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const path = join(journalDir, name);
      let record: MutationRecord;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new MutationError('Journal record must be a real file');
        record = decode(readFileSync(path));
        if (record.id !== id) throw new MutationError('Journal record id mismatch');
      } catch (error) {
        results.push({ id, state: 'unknown', recordProblem: (error as Error).message, files: [] });
        continue;
      }
      if (record.state !== 'applying' && record.state !== 'rolling-back' && record.state !== 'unknown') continue;
      results.push({
        id, state: record.state,
        files: record.files.map((file) => {
          try { return classifyFile(file); }
          catch (error) { return { path: file.path, status: 'drifted' as const }; }
        }),
      });
    }
    return results;
  }

  return { prepare, approve, apply, rollBack, reconcile, get: read };
}
