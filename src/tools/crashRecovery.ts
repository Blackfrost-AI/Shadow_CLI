/**
 * m-8 crash restore: per-operation reconciliation of interrupted mutations WITHOUT replaying
 * side effects. Reads only the frozen mutation journal's own surfaces (`reconcile`, `get`,
 * `rollBack`, `prepare`/`approve`/`apply`) — mutation.ts semantics are untouched.
 *
 * Posture (fail closed everywhere):
 * - Listing and reporting are READ-ONLY: no target byte is ever written by any listing or
 *   report. Resolution happens ONLY through an explicit operator decision.
 * - `resolveRollback` runs the journal's own `rollBack` under the RECORDED digest, and only
 *   after the operator's presented digest is verified equal to it — an approval minted for
 *   another operation fails closed (`approval does not match request`), and the journal's
 *   state machine refuses any replay of a spent approval.
 * - `resolveKeep` records the operator's decision durably and changes NOTHING else: the
 *   journal record's state is untouched, and the operation stays visible — flagged — in the
 *   reconnect report.
 * - `resolveRetry` NEVER accepts the old approval digest. A retry requires a fresh approval
 *   whose handle binds (operation id, content digest) — `sha256("shadow-crash-retry:<id>:<d>")`.
 *   Since the old and new content digests coincide for identical content, the handle layer is
 *   what makes "the old digest is never accepted" mechanically absolute: the old digest string
 *   is refused before any journal call, and the journal's own `prepare` revalidation refuses
 *   any drifted precondition.
 * - Resolution markers (`<id>.resolved`) are written durably (fsync file + parent dir, the
 *   same posture as the journal's own record writes) and are invisible to `reconcile()`
 *   (which reads `.json` only).
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createMutationJournal,
  type MutationRecord,
  type MutationState,
  type ReconciledOperation,
} from './mutation.js';

export class CrashRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrashRecoveryError';
  }
}

/** The per-file truth vocabulary, mirrored from the journal's reconcile(). */
export type FileTruthStatus = 'matches-before' | 'matches-after' | 'drifted' | 'missing';

export interface FileTruth {
  path: string;
  status: FileTruthStatus;
}

export interface InterruptedOperation {
  operationId: string;
  kind: 'mutation';
  state: MutationState;
  files: FileTruth[];
  /** Absolute path of the journal record — the evidence backing every claim above. */
  evidence: string;
  /** Present when the record itself could not be decoded (its per-file truth is unknown). */
  problem?: string;
}

export type ResolutionMarker =
  | { type: 'keep'; at: string }
  | { type: 'superseded'; at: string; retryOperationId: string };

export type ResolutionStatus =
  | { type: 'none' }
  | ResolutionMarker
  | { type: 'unreadable'; problem: string };

export interface ReconnectReportOperation extends InterruptedOperation {
  resolution: ResolutionStatus;
  recommendedAction: string;
}

export interface ReconnectReport {
  workspaceRoot: string;
  generatedAt: string;
  /** The report never replays effects: producing it writes no target byte. */
  replayed: false;
  operations: ReconnectReportOperation[];
  counts: { total: number; unresolved: number; kept: number; superseded: number };
}

export interface RollbackResolution {
  operationId: string;
  state: MutationState;
}

export interface KeepResolution {
  operationId: string;
  resolution: 'keep';
}

export interface RetryResolution {
  operationId: string;
  state: MutationState;
  supersededOperationId: string;
}

const INTERRUPTED_STATES: readonly MutationState[] = ['applying', 'rolling-back', 'unknown'];
const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function journalDirectory(workspaceRoot: string): string {
  const root = realpathSync(resolve(workspaceRoot));
  return join(root, '.shadow', 'mutations');
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The fresh-approval handle a retry requires: binds the operator's decision to THIS operation
 * and its EXACT recorded content. Never equal to the old (content) approval digest, so the
 * old digest can never satisfy it — including for identical retry content.
 */
export function retryApprovalHandle(operationId: string, contentDigest: string): string {
  return sha256Hex(`shadow-crash-retry:${operationId}:${contentDigest}`);
}

function validateOperationId(operationId: string): void {
  if (!SAFE_ID.test(operationId)) throw new CrashRecoveryError('invalid operation id');
}

/** Durable marker write (temp + fsync + rename + parent-dir fsync — the journal's own posture). */
function durableWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dirFd = openSync(join(path, '..'), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* best effort on platforms without directory fsync */ }
}

function markResolved(workspaceRoot: string, operationId: string, marker: ResolutionMarker): void {
  const dir = journalDirectory(workspaceRoot);
  if (!existsSync(dir)) throw new CrashRecoveryError('no mutation journal in this workspace');
  durableWrite(join(dir, `${operationId}.resolved`), `${JSON.stringify({ version: 1, operationId, ...marker })}\n`);
}

/** Read a resolution marker; corrupt markers fail VISIBLE, never silent. */
function markerOf(workspaceRoot: string, operationId: string): ResolutionStatus {
  const path = join(journalDirectory(workspaceRoot), `${operationId}.resolved`);
  if (!existsSync(path)) return { type: 'none' };
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return { type: 'unreadable', problem: 'resolution marker must be a real file' };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ResolutionMarker & { version?: number; operationId?: string }>;
    if (parsed.version !== 1 || parsed.operationId !== operationId) {
      return { type: 'unreadable', problem: 'resolution marker has wrong version or id' };
    }
    if (parsed.type === 'keep' && typeof parsed.at === 'string') return { type: 'keep', at: parsed.at };
    if (parsed.type === 'superseded' && typeof parsed.at === 'string' && typeof parsed.retryOperationId === 'string') {
      return { type: 'superseded', at: parsed.at, retryOperationId: parsed.retryOperationId };
    }
    return { type: 'unreadable', problem: 'resolution marker has an unknown shape' };
  } catch (error) {
    return { type: 'unreadable', problem: `resolution marker is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The journal's reconcile() rows — the shared read-only basis for every listing and report. */
function reconcileRows(workspaceRoot: string): ReconciledOperation[] {
  return createMutationJournal(workspaceRoot).reconcile();
}

function toOperation(workspaceRoot: string, row: ReconciledOperation): InterruptedOperation {
  return {
    operationId: row.id,
    kind: 'mutation',
    state: row.state,
    files: row.files.map((file) => ({ path: file.path, status: file.status })),
    evidence: join(journalDirectory(workspaceRoot), `${row.id}.json`),
    ...(row.recordProblem ? { problem: row.recordProblem } : {}),
  };
}

/**
 * Interrupted operations that remain UNRESOLVED. Read-only; NO automatic resolution — the
 * operator decides. Operations with a keep/superseded marker are excluded (their decision is
 * recorded); an UNREADABLE marker fails closed back into this list.
 */
export function listInterrupted(workspaceRoot: string): InterruptedOperation[] {
  const out: InterruptedOperation[] = [];
  for (const row of reconcileRows(workspaceRoot)) {
    const marker = markerOf(workspaceRoot, row.id);
    if (marker.type === 'keep' || marker.type === 'superseded') continue;
    out.push(toOperation(workspaceRoot, row));
  }
  return out;
}

function recommendedAction(op: ReconnectReportOperation): string {
  if (op.resolution.type === 'keep') {
    return 'kept by operator decision — the on-disk state is unchanged; the per-file truth above is what remains on disk';
  }
  if (op.resolution.type === 'superseded') {
    return `superseded by retried operation ${op.resolution.retryOperationId}`;
  }
  if (op.files.length === 0) {
    return 'the journal record could not be decoded — manual inspection of the evidence file is required';
  }
  const statuses = new Set(op.files.map((file) => file.status));
  if (statuses.has('matches-after')) {
    return 'partial effect landed — the journal cannot roll back an interrupted operation; restore the affected files manually from the recorded before-bytes in the evidence record';
  }
  if (statuses.has('drifted') || statuses.has('missing')) {
    return 'on-disk state diverged from the record — manual inspection is required before any resolution';
  }
  return 'no effect landed — keep the decision on record (resolveKeep), or retry under a FRESH approval (resolveRetry); the old approval digest is never accepted';
}

/**
 * The per-operation incomplete-effects report a reconnecting peer receives INSTEAD of a
 * replay: every interrupted operation with its per-file truth and resolution status, and no
 * effect replayed — producing this report writes nothing.
 */
export function reconnectReport(workspaceRoot: string): ReconnectReport {
  const operations: ReconnectReportOperation[] = [];
  const counts = { total: 0, unresolved: 0, kept: 0, superseded: 0 };
  for (const row of reconcileRows(workspaceRoot)) {
    const resolution = markerOf(workspaceRoot, row.id);
    const op: ReconnectReportOperation = { ...toOperation(workspaceRoot, row), resolution, recommendedAction: '' };
    op.recommendedAction = recommendedAction(op);
    counts.total++;
    if (resolution.type === 'keep') counts.kept++;
    else if (resolution.type === 'superseded') counts.superseded++;
    else counts.unresolved++;
    operations.push(op);
  }
  return {
    workspaceRoot: realpathSync(resolve(workspaceRoot)),
    generatedAt: new Date().toISOString(),
    replayed: false,
    operations,
    counts,
  };
}

/**
 * Roll an operation back under its RECORDED digest. The operator's presented digest must be
 * exactly the recorded one — an approval minted for a different operation fails closed — and
 * the journal's own state machine refuses any replay of a spent approval (verbatim).
 */
export function resolveRollback(journal: { get: (id: string) => MutationRecord; rollBack: (id: string, digest: string) => MutationRecord }, operationId: string, approvalDigest: string): RollbackResolution {
  const record = journal.get(operationId); // MutationError verbatim when the id is unknown
  if (approvalDigest !== record.approvalDigest) {
    throw new CrashRecoveryError('approval does not match request');
  }
  const rolled = journal.rollBack(operationId, record.approvalDigest);
  return { operationId, state: rolled.state };
}

/**
 * Record the operator's keep decision. The journal record is NOT touched — its state is
 * unchanged — and the operation remains visible, flagged, in the reconnect report.
 */
export function resolveKeep(workspaceRoot: string, operationId: string): KeepResolution {
  validateOperationId(operationId);
  markResolved(workspaceRoot, operationId, { type: 'keep', at: new Date().toISOString() });
  return { operationId, resolution: 'keep' };
}

/**
 * Retry an interrupted operation under a FRESH approval. The OLD approval digest is never
 * accepted: the only admissible approval is `retryApprovalHandle(operationId, contentDigest)`
 * — a handle that binds the operator's decision to this exact operation. The retry is a NEW
 * journal operation (new prepare — which revalidates every precondition — plus approve and
 * apply under the new record), and the old operation is marked superseded only after the new
 * one lands.
 */
export function resolveRetry(workspaceRoot: string, operationId: string, approvalDigest: string): RetryResolution {
  validateOperationId(operationId);
  const journal = createMutationJournal(workspaceRoot);
  const record = journal.get(operationId); // MutationError verbatim when the id is unknown
  if (!INTERRUPTED_STATES.includes(record.state)) {
    throw new CrashRecoveryError(`only an interrupted operation can be retried (state: ${record.state})`);
  }
  if (approvalDigest === record.approvalDigest) {
    throw new CrashRecoveryError('the old approval digest is spent and is never accepted for a retry');
  }
  if (approvalDigest !== retryApprovalHandle(operationId, record.approvalDigest)) {
    throw new CrashRecoveryError('approval does not match request');
  }
  const files = record.files.map((file) => ({
    path: file.path,
    before: file.beforeB64 === null ? null : Buffer.from(file.beforeB64, 'base64').toString('utf8'),
    after: Buffer.from(file.afterB64, 'base64').toString('utf8'),
  }));
  const fresh = journal.prepare(files); // revalidates every precondition; refuses any drift verbatim
  journal.approve(fresh.id, fresh.approvalDigest);
  const applied = journal.apply(fresh.id, fresh.approvalDigest);
  markResolved(workspaceRoot, operationId, { type: 'superseded', at: new Date().toISOString(), retryOperationId: fresh.id });
  return { operationId: fresh.id, state: applied.state, supersededOperationId: operationId };
}

/** Directory entries the journal itself would never touch (defensive read-side check). */
export function resolutionMarkerPath(workspaceRoot: string, operationId: string): string {
  validateOperationId(operationId);
  return join(journalDirectory(workspaceRoot), `${operationId}.resolved`);
}
