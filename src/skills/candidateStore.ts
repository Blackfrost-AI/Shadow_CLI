import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWrite } from '../tools/util.js';
import {
  SKILL_CANDIDATE_SCHEMA_VERSION,
  type ActiveSkill,
  type ActiveSkillRecord,
  type CandidateDecisionInput,
  type DraftSkillCandidateInput,
  type SkillActivationApproval,
  type SkillCandidateSnapshot,
  type SkillCandidateSource,
  type SkillCandidateStatus,
  type SkillCandidateSummary,
  type SkillEvidenceReference,
  type SkillRollbackApproval,
  type SkillValidationReport,
  type SkillVerificationResult,
  type UpdateSkillCandidateInput,
} from './candidateTypes.js';
import {
  MAX_CANDIDATE_METADATA_BYTES,
  MAX_SKILL_CANDIDATE_BYTES,
  assertCandidateActivationReady,
  assertValidCandidate,
  isSafeSkillName,
  sha256Text,
  validateSkillCandidate,
} from './candidateValidator.js';

type CandidateMetadata = Omit<SkillCandidateSnapshot, 'skillMarkdown'>;

interface CurrentPointer {
  schemaVersion: 1;
  version: number;
}

interface ActivationTransactionRecord {
  schemaVersion: 1;
  name: string;
  previousCandidateVersion: number;
  activatedCandidateVersion: number;
  previousActiveGeneration: number;
  activeGeneration: number;
  activeContentDigest: string;
}

interface RollbackTransactionRecord {
  schemaVersion: 1;
  kind: 'rollback';
  name: string;
  previousActiveGeneration: number;
  previousActiveSnapshotDigest: string;
  targetGeneration: number;
  restoredGeneration: number;
  restoredActiveSnapshotDigest: string;
}

export interface SkillCandidateStoreOptions {
  /** Defaults to `~/.shadow/skills`. Primarily injectable for isolated tests. */
  skillsRoot?: string;
  now?: () => Date;
  /** Test-only fault hook used to prove activation recovery at filesystem boundaries. */
  activationFailpoint?: (point: SkillActivationFailpoint) => void;
  /** Test-only fault hook used to prove rollback recovery at filesystem boundaries. */
  rollbackFailpoint?: (point: SkillRollbackFailpoint) => void;
}

export type SkillActivationFailpoint =
  | 'before-candidate-commit'
  | 'before-active-publish';

export type SkillRollbackFailpoint =
  | 'before-transaction-publish'
  | 'before-current-archive'
  | 'before-current-move'
  | 'before-active-publish'
  | 'after-active-publish'
  | 'before-transaction-retire'
  | 'after-transaction-retire'
  | 'after-abort-marker'
  | 'after-restored-discard'
  | 'after-previous-restore';

export interface ListSkillCandidateOptions {
  statuses?: SkillCandidateStatus[];
}

const RECORD_FILE = 'candidate.json';
const SKILL_FILE = 'SKILL.md';
const CURRENT_FILE = 'current.json';
const ACTIVE_RECORD_FILE = '.shadow-skill.json';
const CANDIDATES_DIR = '.candidates';
const REVISIONS_DIR = '.revisions';
const LOCKS_DIR = '.locks';
const TRANSACTIONS_DIR = '.transactions';
const TRANSACTION_RECORD_FILE = 'transaction.json';

function versionDirName(version: number): string {
  return String(version).padStart(6, '0');
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function activeSnapshotDigest(active: ActiveSkill): string {
  // Match the durable representation rather than relying on the in-memory location of the
  // `skillMarkdown` property, which can differ after a record is read back from disk.
  const { skillMarkdown, ...record } = active;
  return sha256Text(`${stringify(record)}\0${skillMarkdown}`);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is malformed.`);
}

function readCapped(path: string, maxBytes: number, label: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink — refused.`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file.`);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds its ${maxBytes}-byte limit.`);
  return readFileSync(path, 'utf8');
}

function readJson(path: string, maxBytes: number, label: string): Record<string, unknown> {
  const raw = readCapped(path, maxBytes, label);
  try {
    const parsed = JSON.parse(raw) as unknown;
    assertPlainObject(parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`);
    throw error;
  }
}

function assertDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink — refused.`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory.`);
}

function ensureDirectory(path: string, label: string): void {
  if (existsSync(path)) {
    assertDirectory(path, label);
    return;
  }
  const parent = dirname(path);
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
    throw new Error(`${label}'s parent is a symlink — refused.`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertDirectory(path, label);
  try {
    chmodSync(path, 0o700);
  } catch {
    /* Best effort on filesystems without POSIX permission bits. */
  }
}

/** Reject lexical escapes and every symlink below the pinned store root. */
function assertContainedPath(root: string, target: string, label: string): void {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${label} escapes the skill store.`);
  assertDirectory(rootAbs, 'skill store root');
  let cursor = rootAbs;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} crosses a symlink — refused.`);
  }
}

function normalizeSource(source: SkillCandidateSource | undefined): SkillCandidateSource | undefined {
  if (!source) return undefined;
  const out: SkillCandidateSource = {};
  if (source.sessionId !== undefined) out.sessionId = source.sessionId;
  if (source.turnIds !== undefined) out.turnIds = [...source.turnIds];
  if (source.workflow !== undefined) out.workflow = source.workflow;
  return out;
}

function normalizeEvidence(
  evidence: DraftSkillCandidateInput['evidence'] | UpdateSkillCandidateInput['evidence'] | undefined,
  now: string,
): SkillEvidenceReference[] {
  return (evidence ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    reference: item.reference,
    summary: item.summary,
    capturedAt: item.capturedAt ?? now,
    ...(item.digest === undefined ? {} : { digest: item.digest }),
  }));
}

function normalizeVerification(
  results: DraftSkillCandidateInput['verificationResults'] | UpdateSkillCandidateInput['verificationResults'] | undefined,
  now: string,
): SkillVerificationResult[] {
  return (results ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    passed: item.passed,
    summary: item.summary,
    validator: item.validator,
    completedAt: item.completedAt ?? now,
    evidenceRefs: [...item.evidenceRefs],
    resultDigest: item.resultDigest,
  }));
}

function metadataOf(candidate: SkillCandidateSnapshot): CandidateMetadata {
  const { skillMarkdown: _skillMarkdown, ...metadata } = candidate;
  return metadata;
}

/**
 * Evidence-gated learned-skill storage. This class performs no provider calls, transcript
 * mining, network access, or automatic activation.
 */
export class SkillCandidateStore {
  readonly skillsRoot: string;
  readonly candidatesRoot: string;
  readonly revisionsRoot: string;
  private readonly now: () => Date;
  private readonly activationFailpoint?: (point: SkillActivationFailpoint) => void;
  private readonly rollbackFailpoint?: (point: SkillRollbackFailpoint) => void;
  private recoveringTransactions = false;

  constructor(options: SkillCandidateStoreOptions = {}) {
    this.skillsRoot = resolve(options.skillsRoot ?? join(homedir(), '.shadow', 'skills'));
    this.candidatesRoot = join(this.skillsRoot, CANDIDATES_DIR);
    this.revisionsRoot = join(this.skillsRoot, REVISIONS_DIR);
    this.now = options.now ?? (() => new Date());
    this.activationFailpoint = options.activationFailpoint;
    this.rollbackFailpoint = options.rollbackFailpoint;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private ensureBase(): void {
    ensureDirectory(this.skillsRoot, 'skill store root');
    assertContainedPath(this.skillsRoot, this.candidatesRoot, 'candidate store');
    ensureDirectory(this.candidatesRoot, 'candidate store');
    this.recoverPendingActivations();
  }

  private requireName(name: string): void {
    if (!isSafeSkillName(name)) {
      throw new Error(`Invalid skill name "${String(name)}". Use lowercase letters, digits, . _ -, max 64 characters.`);
    }
  }

  private candidateDir(name: string): string {
    this.requireName(name);
    return join(this.candidatesRoot, name);
  }

  private withLock<T>(scopeRoot: string, name: string, action: () => T): T {
    this.requireName(name);
    ensureDirectory(scopeRoot, 'lock scope');
    const locks = join(scopeRoot, LOCKS_DIR);
    assertContainedPath(this.skillsRoot, locks, 'lock directory');
    ensureDirectory(locks, 'lock directory');
    const lock = join(locks, `${name}.lock`);
    let fd: number | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fd = openSync(lock, 'wx', 0o600);
        writeFileSync(fd, `${process.pid}\n`, 'utf8');
        break;
      } catch (error) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* ignore close failure while acquiring */ }
          fd = undefined;
          try { unlinkSync(lock); } catch { /* preserve the acquisition error */ }
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' && attempt === 0 && this.removeStaleLock(lock)) continue;
        if (code === 'EEXIST') throw new Error(`Skill "${name}" is already being changed by another process.`);
        throw error;
      }
    }
    if (fd === undefined) throw new Error(`Could not acquire the lock for skill "${name}".`);
    closeSync(fd);
    try {
      return action();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        /* A missing lock cannot make the completed mutation less safe. */
      }
    }
  }

  private removeStaleLock(lock: string): boolean {
    try {
      const stat = lstatSync(lock);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64) return false;
      const owner = Number(readFileSync(lock, 'utf8').trim());
      if (!Number.isSafeInteger(owner) || owner < 1 || owner === process.pid) return false;
      try {
        process.kill(owner, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      }
      unlinkSync(lock);
      return true;
    } catch {
      return false;
    }
  }

  private readActivationTransaction(transactionDir: string): ActivationTransactionRecord {
    const raw = readJson(join(transactionDir, TRANSACTION_RECORD_FILE), 16 * 1024, 'activation transaction');
    const record = raw as unknown as ActivationTransactionRecord;
    if (
      record.schemaVersion !== 1 || !isSafeSkillName(record.name) ||
      !Number.isSafeInteger(record.previousCandidateVersion) || record.previousCandidateVersion < 1 ||
      !Number.isSafeInteger(record.activatedCandidateVersion) ||
        record.activatedCandidateVersion !== record.previousCandidateVersion + 1 ||
      !Number.isSafeInteger(record.previousActiveGeneration) || record.previousActiveGeneration < 0 ||
      !Number.isSafeInteger(record.activeGeneration) ||
        record.activeGeneration !== record.previousActiveGeneration + 1 ||
      !/^[a-f0-9]{64}$/.test(record.activeContentDigest)
    ) {
      throw new Error('Activation transaction is malformed.');
    }
    return record;
  }

  private readRollbackTransaction(transactionDir: string): RollbackTransactionRecord {
    const raw = readJson(join(transactionDir, TRANSACTION_RECORD_FILE), 16 * 1024, 'rollback transaction');
    const record = raw as unknown as RollbackTransactionRecord;
    if (
      record.schemaVersion !== 1 || record.kind !== 'rollback' || !isSafeSkillName(record.name) ||
      !Number.isSafeInteger(record.previousActiveGeneration) || record.previousActiveGeneration < 1 ||
      !/^[a-f0-9]{64}$/.test(record.previousActiveSnapshotDigest) ||
      !Number.isSafeInteger(record.targetGeneration) || record.targetGeneration < 1 ||
      !Number.isSafeInteger(record.restoredGeneration) ||
        record.restoredGeneration !== record.previousActiveGeneration + 1 ||
      !/^[a-f0-9]{64}$/.test(record.restoredActiveSnapshotDigest)
    ) {
      throw new Error('Rollback transaction is malformed.');
    }
    return record;
  }

  private activeMatchesTransaction(active: ActiveSkill, record: ActivationTransactionRecord): boolean {
    return active.name === record.name &&
      active.generation === record.activeGeneration &&
      active.contentDigest === record.activeContentDigest &&
      active.candidateVersion === record.previousCandidateVersion;
  }

  private recoverActivationTransaction(transactionDir: string, record: ActivationTransactionRecord): void {
    const candidateDir = this.candidateDir(record.name);
    const activeDir = this.activeDir(record.name);
    const stagedActiveDir = join(transactionDir, 'active');
    const previousActiveDir = join(transactionDir, 'previous-active');
    const currentVersion = this.readCurrentVersion(candidateDir);

    if (currentVersion === record.previousCandidateVersion) {
      // The activation decision never committed. Restore any moved prior directory and discard
      // staging; the still-current candidate remains an ordinary draft.
      if (existsSync(previousActiveDir) && !existsSync(activeDir)) renameSync(previousActiveDir, activeDir);
      this.removeActivationVersion(candidateDir, record.activatedCandidateVersion);
      rmSync(transactionDir, { recursive: true, force: true });
      return;
    }
    if (currentVersion !== record.activatedCandidateVersion) {
      throw new Error(
        `Activation transaction for "${record.name}" expected candidate version ` +
          `${record.previousCandidateVersion} or ${record.activatedCandidateVersion}, found ${currentVersion}.`,
      );
    }

    const activated = this.readSnapshot(record.name, record.activatedCandidateVersion);
    if (
      activated.status !== 'activated' || activated.contentDigest !== record.activeContentDigest ||
      activated.decision?.kind !== 'activated' ||
      activated.decision.activeGeneration !== record.activeGeneration
    ) {
      throw new Error(`Activation transaction for "${record.name}" does not match its candidate decision receipt.`);
    }

    let published: ActiveSkill | null = null;
    if (existsSync(activeDir)) published = this.readActiveFromDir(record.name, activeDir);
    if (published && this.activeMatchesTransaction(published, record)) {
      if (existsSync(previousActiveDir)) this.archiveActive(this.readActiveFromDir(record.name, previousActiveDir));
      rmSync(transactionDir, { recursive: true, force: true });
      return;
    }

    if (!existsSync(stagedActiveDir)) {
      throw new Error(`Activation transaction for "${record.name}" is missing its staged active skill.`);
    }
    const stagedActive = this.readActiveFromDir(record.name, stagedActiveDir);
    if (!this.activeMatchesTransaction(stagedActive, record)) {
      throw new Error(`Activation transaction for "${record.name}" has mismatched staged active content.`);
    }

    if (published) {
      if (
        record.previousActiveGeneration === 0 ||
        published.generation !== record.previousActiveGeneration
      ) {
        throw new Error(`Activation transaction for "${record.name}" found an unexpected active generation.`);
      }
      this.archiveActive(published);
      if (existsSync(previousActiveDir)) {
        const previous = this.readActiveFromDir(record.name, previousActiveDir);
        if (!this.activeSkillsMatch(previous, published)) {
          throw new Error(`Activation transaction for "${record.name}" has conflicting prior active content.`);
        }
      } else {
        renameSync(activeDir, previousActiveDir);
      }
    } else if (existsSync(previousActiveDir)) {
      const previous = this.readActiveFromDir(record.name, previousActiveDir);
      if (previous.generation !== record.previousActiveGeneration) {
        throw new Error(`Activation transaction for "${record.name}" has a mismatched prior generation.`);
      }
      this.archiveActive(previous);
    }

    renameSync(stagedActiveDir, activeDir);
    try {
      rmSync(transactionDir, { recursive: true, force: true });
    } catch {
      /* The committed active skill and receipt are authoritative; stale hidden staging is inert. */
    }
  }

  private activeMatchesSnapshotDigest(active: ActiveSkill, generation: number, digest: string): boolean {
    return active.generation === generation && activeSnapshotDigest(active) === digest;
  }

  /** Hide a completed journal with one rename before recursive cleanup. A crash during removal can
   * therefore leave only an inert dot-directory, never a half-deleted journal that blocks reads. */
  private retireRollbackTransaction(transactionDir: string): void {
    this.rollbackFailpoint?.('before-transaction-retire');
    const retiredDir = join(dirname(transactionDir), `.completed-${basename(transactionDir).replace(/^\./, '')}`);
    renameSync(transactionDir, retiredDir);
    this.rollbackFailpoint?.('after-transaction-retire');
    try {
      rmSync(retiredDir, { recursive: true, force: true });
    } catch {
      /* Completed dot-directories are inert and removed by the next recovery scan. */
    }
  }

  private bestEffortRetireRollbackTransaction(transactionDir: string): void {
    try {
      this.retireRollbackTransaction(transactionDir);
    } catch {
      // The transaction direction and live directory are already authoritative. Leaving the
      // journal in place makes a later recovery retry safe and idempotent.
    }
  }

  /**
   * A published rollback journal is a durable operator intent. Recovery therefore finishes it
   * forward. The live directory is always moved and published as a whole, so SKILL.md and its
   * metadata can never be observed as different generations by normal discovery.
   */
  private recoverRollbackTransaction(transactionDir: string, record: RollbackTransactionRecord): void {
    const activeDir = this.activeDir(record.name);
    const stagedActiveDir = join(transactionDir, 'active');
    const previousActiveDir = join(transactionDir, 'previous-active');

    let live: ActiveSkill | null = null;
    if (existsSync(activeDir)) live = this.readActiveFromDir(record.name, activeDir);
    let staged: ActiveSkill | null = null;
    if (existsSync(stagedActiveDir)) staged = this.readActiveFromDir(record.name, stagedActiveDir);
    let previous: ActiveSkill | null = null;
    if (existsSync(previousActiveDir)) previous = this.readActiveFromDir(record.name, previousActiveDir);

    if (staged && !this.activeMatchesSnapshotDigest(
      staged,
      record.restoredGeneration,
      record.restoredActiveSnapshotDigest,
    )) {
      throw new Error(`Rollback transaction for "${record.name}" has mismatched staged active content.`);
    }
    if (previous && !this.activeMatchesSnapshotDigest(
      previous,
      record.previousActiveGeneration,
      record.previousActiveSnapshotDigest,
    )) {
      throw new Error(`Rollback transaction for "${record.name}" has mismatched prior active content.`);
    }

    const liveIsPrevious = !!live && this.activeMatchesSnapshotDigest(
      live,
      record.previousActiveGeneration,
      record.previousActiveSnapshotDigest,
    );
    const liveIsRestored = !!live && this.activeMatchesSnapshotDigest(
      live,
      record.restoredGeneration,
      record.restoredActiveSnapshotDigest,
    );
    if (live && !liveIsPrevious && !liveIsRestored) {
      throw new Error(`Rollback transaction for "${record.name}" found an unexpected active generation.`);
    }

    // The target is immutable revision history. Verify the staged rollback still identifies the
    // requested source before allowing it to become discoverable.
    const restored = staged ?? (liveIsRestored ? live : null);
    if (!restored || restored.restoredFromGeneration !== record.targetGeneration) {
      throw new Error(`Rollback transaction for "${record.name}" is missing its staged active skill.`);
    }

    if (liveIsRestored) {
      // A crash can happen after publication or during best-effort transaction cleanup. Ensure
      // the displaced generation remains in revision history before discarding the journal.
      if (previous) this.archiveActive(previous);
      else {
        const archivedPrevious = this.readArchivedGeneration(record.name, record.previousActiveGeneration);
        if (!this.activeMatchesSnapshotDigest(
          archivedPrevious,
          record.previousActiveGeneration,
          record.previousActiveSnapshotDigest,
        )) {
          throw new Error(`Rollback transaction for "${record.name}" has conflicting prior revision history.`);
        }
      }
      this.bestEffortRetireRollbackTransaction(transactionDir);
      return;
    }

    if (liveIsPrevious) {
      this.archiveActive(live!);
      if (previous) {
        if (!this.activeSkillsMatch(previous, live!)) {
          throw new Error(`Rollback transaction for "${record.name}" has conflicting prior active content.`);
        }
      } else {
        renameSync(activeDir, previousActiveDir);
        previous = live;
      }
    } else if (previous) {
      this.archiveActive(previous);
    } else {
      // A prior archive is sufficient if cleanup was interrupted after deleting the transaction's
      // copy. This state is only valid when the complete restored generation is already live, which
      // was handled above.
      throw new Error(`Rollback transaction for "${record.name}" is missing its prior active skill.`);
    }

    renameSync(stagedActiveDir, activeDir);
    this.bestEffortRetireRollbackTransaction(transactionDir);
  }

  private discardUnpublishedRollback(
    transactionDir: string,
    record: RollbackTransactionRecord,
    onlyName?: string,
  ): void {
    if (onlyName && record.name !== onlyName) return;
    try {
      this.withLock(this.skillsRoot, record.name, () => {
        // A dot-prefixed transaction was never durably published, so the unchanged live skill is
        // authoritative. It is safe to discard once no process owns the per-skill lock.
        rmSync(transactionDir, { recursive: true, force: true });
      });
    } catch (error) {
      if (!(error as Error).message.includes('already being changed by another process')) throw error;
    }
  }

  /** Complete a rollback abort after its direction marker was durably renamed. */
  private recoverRollbackAbort(transactionDir: string, record: RollbackTransactionRecord): void {
    const activeDir = this.activeDir(record.name);
    const stagedActiveDir = join(transactionDir, 'active');
    const previousActiveDir = join(transactionDir, 'previous-active');
    const discardedRestoredDir = join(transactionDir, 'discarded-restored');

    let live: ActiveSkill | null = null;
    if (existsSync(activeDir)) live = this.readActiveFromDir(record.name, activeDir);
    let previous: ActiveSkill | null = null;
    if (existsSync(previousActiveDir)) previous = this.readActiveFromDir(record.name, previousActiveDir);
    if (previous && !this.activeMatchesSnapshotDigest(
      previous,
      record.previousActiveGeneration,
      record.previousActiveSnapshotDigest,
    )) {
      throw new Error(`Rollback abort for "${record.name}" has mismatched prior active content.`);
    }
    for (const path of [stagedActiveDir, discardedRestoredDir]) {
      if (!existsSync(path)) continue;
      const discarded = this.readActiveFromDir(record.name, path);
      if (!this.activeMatchesSnapshotDigest(
        discarded,
        record.restoredGeneration,
        record.restoredActiveSnapshotDigest,
      )) {
        throw new Error(`Rollback abort for "${record.name}" has mismatched restored content.`);
      }
    }

    const liveIsPrevious = !!live && this.activeMatchesSnapshotDigest(
      live,
      record.previousActiveGeneration,
      record.previousActiveSnapshotDigest,
    );
    const liveIsRestored = !!live && this.activeMatchesSnapshotDigest(
      live,
      record.restoredGeneration,
      record.restoredActiveSnapshotDigest,
    );
    if (live && !liveIsPrevious && !liveIsRestored) {
      throw new Error(`Rollback abort for "${record.name}" found an unexpected active generation.`);
    }

    if (liveIsRestored) {
      if (!previous) throw new Error(`Rollback abort for "${record.name}" is missing its prior active skill.`);
      if (existsSync(discardedRestoredDir)) {
        throw new Error(`Rollback abort for "${record.name}" found duplicate restored content.`);
      }
      renameSync(activeDir, discardedRestoredDir);
      this.rollbackFailpoint?.('after-restored-discard');
      live = null;
    }
    if (!live) {
      if (!previous) throw new Error(`Rollback abort for "${record.name}" is missing its prior active skill.`);
      renameSync(previousActiveDir, activeDir);
      this.rollbackFailpoint?.('after-previous-restore');
    }
    this.bestEffortRetireRollbackTransaction(transactionDir);
  }

  /** Complete or discard durable skill-publication transactions left by an interrupted process. */
  recoverPendingActivations(onlyName?: string): void {
    if (this.recoveringTransactions || !existsSync(this.skillsRoot)) return;
    const transactionsRoot = join(this.skillsRoot, TRANSACTIONS_DIR);
    if (!existsSync(transactionsRoot)) return;
    assertContainedPath(this.skillsRoot, transactionsRoot, 'skill transaction store');
    assertDirectory(transactionsRoot, 'skill transaction store');
    this.recoveringTransactions = true;
    try {
      const entries = readdirSync(transactionsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const transactionDir = join(transactionsRoot, entry.name);
        if (entry.name.startsWith('.completed-rollback-') || entry.name.startsWith('.completed-aborting-rollback-')) {
          assertContainedPath(this.skillsRoot, transactionDir, 'completed rollback transaction');
          try {
            rmSync(transactionDir, { recursive: true, force: true });
          } catch {
            /* It remains hidden and inert until a later cleanup succeeds. */
          }
          continue;
        }
        if (entry.name.startsWith('.pending-rollback-')) {
          assertContainedPath(this.skillsRoot, transactionDir, 'pending rollback transaction');
          let record: RollbackTransactionRecord;
          try {
            record = this.readRollbackTransaction(transactionDir);
          } catch {
            // A process can die before the unpublished staging directory receives its record.
            // It is hidden and inert; leave it alone rather than blocking skill discovery.
            continue;
          }
          this.discardUnpublishedRollback(transactionDir, record, onlyName);
          continue;
        }
        if (entry.name.startsWith('.aborting-rollback-')) {
          assertContainedPath(this.skillsRoot, transactionDir, 'rollback abort transaction');
          const record = this.readRollbackTransaction(transactionDir);
          if (onlyName && record.name !== onlyName) continue;
          try {
            this.withLock(this.skillsRoot, record.name, () =>
              this.recoverRollbackAbort(transactionDir, record));
          } catch (error) {
            if ((error as Error).message.includes('already being changed by another process')) continue;
            throw error;
          }
          continue;
        }
        if (entry.name.startsWith('activate-')) {
          assertContainedPath(this.skillsRoot, transactionDir, 'activation transaction');
          const record = this.readActivationTransaction(transactionDir);
          if (onlyName && record.name !== onlyName) continue;
          try {
            this.withLock(this.candidatesRoot, record.name, () =>
              this.withLock(this.skillsRoot, record.name, () => this.recoverActivationTransaction(transactionDir, record)));
          } catch (error) {
            if ((error as Error).message.includes('already being changed by another process')) continue;
            throw error;
          }
          continue;
        }
        if (entry.name.startsWith('rollback-')) {
          assertContainedPath(this.skillsRoot, transactionDir, 'rollback transaction');
          const record = this.readRollbackTransaction(transactionDir);
          if (onlyName && record.name !== onlyName) continue;
          try {
            this.withLock(this.skillsRoot, record.name, () =>
              this.recoverRollbackTransaction(transactionDir, record));
          } catch (error) {
            if ((error as Error).message.includes('already being changed by another process')) continue;
            throw error;
          }
        }
      }
    } finally {
      this.recoveringTransactions = false;
    }
  }

  private readCurrentVersion(candidateDir: string): number {
    assertContainedPath(this.skillsRoot, candidateDir, 'candidate');
    assertDirectory(candidateDir, 'candidate');
    const pointerPath = join(candidateDir, CURRENT_FILE);
    const pointer = readJson(pointerPath, 4096, 'candidate pointer') as unknown as CurrentPointer;
    if (pointer.schemaVersion !== 1 || !Number.isSafeInteger(pointer.version) || pointer.version < 1) {
      throw new Error('Candidate pointer is malformed.');
    }
    return pointer.version;
  }

  private readSnapshot(name: string, requestedVersion?: number): SkillCandidateSnapshot {
    this.requireName(name);
    if (!existsSync(this.skillsRoot) || !existsSync(this.candidatesRoot)) throw new Error(`Skill candidate "${name}" was not found.`);
    assertContainedPath(this.skillsRoot, this.candidatesRoot, 'candidate store');
    assertDirectory(this.candidatesRoot, 'candidate store');
    const candidateDir = this.candidateDir(name);
    if (!existsSync(candidateDir)) throw new Error(`Skill candidate "${name}" was not found.`);
    const version = requestedVersion ?? this.readCurrentVersion(candidateDir);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Candidate version must be a positive integer.');
    const versionDir = join(candidateDir, 'versions', versionDirName(version));
    assertContainedPath(this.skillsRoot, versionDir, 'candidate version');
    assertDirectory(versionDir, 'candidate version');
    const metadata = readJson(join(versionDir, RECORD_FILE), MAX_CANDIDATE_METADATA_BYTES, 'candidate metadata');
    const skillMarkdown = readCapped(join(versionDir, SKILL_FILE), MAX_SKILL_CANDIDATE_BYTES, 'candidate SKILL.md');
    const candidate = { ...metadata, skillMarkdown } as unknown as SkillCandidateSnapshot;
    if (candidate.name !== name || candidate.version !== version) throw new Error('Candidate snapshot identity does not match its path.');
    assertValidCandidate(candidate);
    return candidate;
  }

  private writeSnapshotFiles(dir: string, candidate: SkillCandidateSnapshot): void {
    atomicWrite(join(dir, RECORD_FILE), stringify(metadataOf(candidate)), 0o600);
    atomicWrite(join(dir, SKILL_FILE), candidate.skillMarkdown, 0o600);
  }

  private commitInitial(candidate: SkillCandidateSnapshot): void {
    const finalDir = this.candidateDir(candidate.name);
    const pending = join(this.candidatesRoot, `.pending-${candidate.name}-${randomUUID()}`);
    assertContainedPath(this.skillsRoot, pending, 'candidate staging directory');
    mkdirSync(join(pending, 'versions', versionDirName(candidate.version)), { recursive: true, mode: 0o700 });
    try {
      this.writeSnapshotFiles(join(pending, 'versions', versionDirName(candidate.version)), candidate);
      atomicWrite(join(pending, CURRENT_FILE), stringify({ schemaVersion: 1, version: candidate.version }), 0o600);
      renameSync(pending, finalDir);
    } catch (error) {
      rmSync(pending, { recursive: true, force: true });
      throw error;
    }
  }

  private commitNext(candidateDir: string, candidate: SkillCandidateSnapshot): void {
    const versions = join(candidateDir, 'versions');
    assertContainedPath(this.skillsRoot, versions, 'candidate versions');
    assertDirectory(versions, 'candidate versions');
    const finalVersion = join(versions, versionDirName(candidate.version));
    if (existsSync(finalVersion)) throw new Error(`Candidate version ${candidate.version} already exists; refusing to overwrite history.`);
    const pending = join(versions, `.pending-${versionDirName(candidate.version)}-${randomUUID()}`);
    mkdirSync(pending, { mode: 0o700 });
    try {
      this.writeSnapshotFiles(pending, candidate);
      renameSync(pending, finalVersion);
      atomicWrite(join(candidateDir, CURRENT_FILE), stringify({ schemaVersion: 1, version: candidate.version }), 0o600);
    } catch (error) {
      rmSync(pending, { recursive: true, force: true });
      throw error;
    }
  }

  draftCandidate(input: DraftSkillCandidateInput): SkillCandidateSnapshot {
    this.ensureBase();
    this.requireName(input.name);
    return this.withLock(this.candidatesRoot, input.name, () => {
      const candidateDir = this.candidateDir(input.name);
      if (existsSync(candidateDir)) throw new Error(`Skill candidate "${input.name}" already exists; update it with an expected version.`);
      const now = this.timestamp();
      const candidate: SkillCandidateSnapshot = {
        schemaVersion: SKILL_CANDIDATE_SCHEMA_VERSION,
        name: input.name,
        version: 1,
        status: 'draft',
        rationale: input.rationale,
        skillMarkdown: input.skillMarkdown,
        contentDigest: sha256Text(input.skillMarkdown),
        claims: (input.claims ?? []).map((claim) => ({ ...claim, evidenceRefs: [...claim.evidenceRefs] })),
        evidence: normalizeEvidence(input.evidence, now),
        verificationResults: normalizeVerification(input.verificationResults, now),
        ...(input.source ? { source: normalizeSource(input.source) } : {}),
        createdAt: now,
        updatedAt: now,
      };
      assertValidCandidate(candidate);
      this.commitInitial(candidate);
      return candidate;
    });
  }

  updateCandidate(name: string, expectedVersion: number, patch: UpdateSkillCandidateInput): SkillCandidateSnapshot {
    this.ensureBase();
    this.requireName(name);
    return this.withLock(this.candidatesRoot, name, () => {
      const current = this.readSnapshot(name);
      if (current.version !== expectedVersion) {
        throw new Error(`Candidate version changed: expected ${expectedVersion}, current is ${current.version}.`);
      }
      if (Object.keys(patch).length === 0) throw new Error('Candidate update contains no changes.');
      const now = this.timestamp();
      const skillMarkdown = patch.skillMarkdown ?? current.skillMarkdown;
      const skillContentChanged = skillMarkdown !== current.skillMarkdown;
      const claims = (patch.claims ?? current.claims).map((claim) => ({ ...claim, evidenceRefs: [...claim.evidenceRefs] }));
      const evidence = patch.evidence === undefined
        ? current.evidence.map((item) => ({ ...item }))
        : normalizeEvidence(patch.evidence, now);
      const validationScopeChanged =
        skillContentChanged ||
        JSON.stringify(claims) !== JSON.stringify(current.claims) ||
        JSON.stringify(evidence) !== JSON.stringify(current.evidence);
      const candidate: SkillCandidateSnapshot = {
        schemaVersion: SKILL_CANDIDATE_SCHEMA_VERSION,
        name,
        version: current.version + 1,
        status: 'draft',
        rationale: patch.rationale ?? current.rationale,
        skillMarkdown,
        contentDigest: sha256Text(skillMarkdown),
        claims,
        evidence,
        // A validation/replay receipt proves the exact procedure that existed when it ran. Never
        // carry those receipts across a SKILL.md change: the revised procedure must be validated
        // again before the activation gate can open.
        verificationResults: patch.verificationResults === undefined
          ? validationScopeChanged
            ? []
            : current.verificationResults.map((item) => ({ ...item, evidenceRefs: [...item.evidenceRefs] }))
          : normalizeVerification(patch.verificationResults, now),
        ...(patch.source !== undefined
          ? { source: normalizeSource(patch.source) }
          : current.source
            ? { source: normalizeSource(current.source) }
            : {}),
        createdAt: current.createdAt,
        updatedAt: now,
      };
      assertValidCandidate(candidate);
      this.commitNext(this.candidateDir(name), candidate);
      return candidate;
    });
  }

  private recordDecision(
    name: string,
    input: CandidateDecisionInput,
    kind: 'rejected' | 'archived',
  ): SkillCandidateSnapshot {
    this.ensureBase();
    this.requireName(name);
    return this.withLock(this.candidatesRoot, name, () => {
      const current = this.readSnapshot(name);
      if (current.version !== input.expectedVersion) {
        throw new Error(`Candidate version changed: expected ${input.expectedVersion}, current is ${current.version}.`);
      }
      if (current.status === kind) throw new Error(`Candidate "${name}" is already ${kind}.`);
      const now = this.timestamp();
      const next: SkillCandidateSnapshot = {
        ...current,
        version: current.version + 1,
        status: kind,
        updatedAt: now,
        decision: { kind, by: input.by, at: now, reason: input.reason },
      };
      assertValidCandidate(next);
      this.commitNext(this.candidateDir(name), next);
      return next;
    });
  }

  rejectCandidate(name: string, input: CandidateDecisionInput): SkillCandidateSnapshot {
    return this.recordDecision(name, input, 'rejected');
  }

  archiveCandidate(name: string, input: CandidateDecisionInput): SkillCandidateSnapshot {
    return this.recordDecision(name, input, 'archived');
  }

  inspectCandidate(name: string, version?: number): SkillCandidateSnapshot {
    this.recoverPendingActivations(name);
    return this.readSnapshot(name, version);
  }

  listCandidates(options: ListSkillCandidateOptions = {}): SkillCandidateSummary[] {
    if (!existsSync(this.skillsRoot) || !existsSync(this.candidatesRoot)) return [];
    this.recoverPendingActivations();
    assertContainedPath(this.skillsRoot, this.candidatesRoot, 'candidate store');
    assertDirectory(this.candidatesRoot, 'candidate store');
    const allowed = options.statuses ? new Set(options.statuses) : null;
    const out: SkillCandidateSummary[] = [];
    for (const entry of readdirSync(this.candidatesRoot, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isDirectory() || entry.isSymbolicLink() || !isSafeSkillName(entry.name)) continue;
      try {
        const candidate = this.readSnapshot(entry.name);
        if (allowed && !allowed.has(candidate.status)) continue;
        out.push({
          name: candidate.name,
          version: candidate.version,
          status: candidate.status,
          rationale: candidate.rationale,
          updatedAt: candidate.updatedAt,
          contentDigest: candidate.contentDigest,
        });
      } catch {
        // A corrupt or hostile entry never becomes a usable candidate through listing.
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
  }

  validateCandidate(name: string, version?: number): SkillValidationReport {
    return validateSkillCandidate(this.inspectCandidate(name, version));
  }

  private activeDir(name: string): string {
    this.requireName(name);
    return join(this.skillsRoot, name);
  }

  private assertActiveRecord(value: Record<string, unknown>, name: string, markdown: string): ActiveSkillRecord {
    const record = value as unknown as ActiveSkillRecord;
    if (
      record.schemaVersion !== 1 || record.name !== name || !Number.isSafeInteger(record.generation) || record.generation < 1 ||
      !Number.isSafeInteger(record.candidateVersion) || record.candidateVersion < 1 ||
      typeof record.activatedAt !== 'string' || !Number.isFinite(Date.parse(record.activatedAt)) ||
      typeof record.approvedBy !== 'string' || !record.approvedBy.trim() ||
      !Array.isArray(record.claimIds) || !record.claimIds.every((item) => isSafeSkillName(item)) ||
      !Array.isArray(record.evidenceRefs) || !record.evidenceRefs.every((item) => isSafeSkillName(item)) ||
      !Array.isArray(record.verificationResultIds) || !record.verificationResultIds.every((item) => isSafeSkillName(item)) ||
      (record.restoredFromGeneration !== undefined &&
        (!Number.isSafeInteger(record.restoredFromGeneration) || record.restoredFromGeneration < 1)) ||
      record.contentDigest !== sha256Text(markdown)
    ) {
      throw new Error(`Managed active skill "${name}" has invalid metadata.`);
    }
    return record;
  }

  private readActiveFromDir(name: string, dir: string): ActiveSkill {
    assertContainedPath(this.skillsRoot, dir, `active skill "${name}"`);
    assertDirectory(dir, `active skill "${name}"`);
    const markdown = readCapped(join(dir, SKILL_FILE), MAX_SKILL_CANDIDATE_BYTES, 'active SKILL.md');
    const raw = readJson(join(dir, ACTIVE_RECORD_FILE), 64 * 1024, 'active skill metadata');
    return { ...this.assertActiveRecord(raw, name, markdown), skillMarkdown: markdown };
  }

  readActiveSkill(name: string): ActiveSkill | null {
    this.requireName(name);
    this.recoverPendingActivations(name);
    if (!existsSync(this.skillsRoot)) return null;
    assertDirectory(this.skillsRoot, 'skill store root');
    const dir = this.activeDir(name);
    if (!existsSync(dir)) return null;
    return this.readActiveFromDir(name, dir);
  }

  private writeActiveFiles(dir: string, active: ActiveSkill): void {
    const { skillMarkdown, ...record } = active;
    atomicWrite(join(dir, SKILL_FILE), skillMarkdown, 0o600);
    atomicWrite(join(dir, ACTIVE_RECORD_FILE), stringify(record), 0o600);
  }

  private activeSkillsMatch(left: ActiveSkill, right: ActiveSkill): boolean {
    const { skillMarkdown: leftMarkdown, ...leftRecord } = left;
    const { skillMarkdown: rightMarkdown, ...rightRecord } = right;
    return leftMarkdown === rightMarkdown && stringify(leftRecord) === stringify(rightRecord);
  }

  private archiveActive(active: ActiveSkill): void {
    assertContainedPath(this.skillsRoot, this.revisionsRoot, 'skill revision store');
    ensureDirectory(this.revisionsRoot, 'skill revision store');
    const skillRevisions = join(this.revisionsRoot, active.name);
    assertContainedPath(this.skillsRoot, skillRevisions, 'skill revisions');
    ensureDirectory(skillRevisions, 'skill revisions');
    const finalDir = join(skillRevisions, versionDirName(active.generation));
    if (existsSync(finalDir)) {
      const archived = this.readActiveFromDir(active.name, finalDir);
      if (this.activeSkillsMatch(archived, active)) return;
      throw new Error(`Active generation ${active.generation} is already archived with different content; refusing to overwrite it.`);
    }
    const pending = join(skillRevisions, `.pending-${versionDirName(active.generation)}-${randomUUID()}`);
    mkdirSync(pending, { mode: 0o700 });
    try {
      this.writeActiveFiles(pending, active);
      renameSync(pending, finalDir);
    } catch (error) {
      rmSync(pending, { recursive: true, force: true });
      throw error;
    }
  }

  private planActiveCandidate(
    candidate: SkillCandidateSnapshot,
    approval: SkillActivationApproval,
    activatedAt: string,
  ): { active: ActiveSkill; current: ActiveSkill | null } {
    const dir = this.activeDir(candidate.name);
    let current: ActiveSkill | null = null;
    if (existsSync(dir)) {
      current = this.readActiveFromDir(candidate.name, dir);
      const unexpected = readdirSync(dir).filter((entry) => entry !== SKILL_FILE && entry !== ACTIVE_RECORD_FILE);
      if (unexpected.length > 0) throw new Error(`Active skill "${candidate.name}" contains unmanaged files; refusing to overwrite it.`);
    }
    const actualGeneration = current?.generation ?? 0;
    if (approval.expectedActiveGeneration !== undefined && approval.expectedActiveGeneration !== actualGeneration) {
      throw new Error(`Active generation changed: expected ${approval.expectedActiveGeneration}, current is ${actualGeneration}.`);
    }

    const passed = candidate.verificationResults.filter((result) => result.passed);
    const active: ActiveSkill = {
      schemaVersion: 1,
      name: candidate.name,
      generation: actualGeneration + 1,
      contentDigest: candidate.contentDigest,
      candidateVersion: candidate.version,
      activatedAt,
      approvedBy: approval.approvedBy,
      claimIds: candidate.claims.map((claim) => claim.id),
      evidenceRefs: candidate.evidence.map((item) => item.id),
      verificationResultIds: passed.map((result) => result.id),
      skillMarkdown: candidate.skillMarkdown,
    };
    return { active, current };
  }

  private stageActivation(
    active: ActiveSkill,
    previousCandidateVersion: number,
    activatedCandidateVersion: number,
  ): { transactionDir: string; stagedActiveDir: string; previousActiveDir: string } {
    const transactionsRoot = join(this.skillsRoot, TRANSACTIONS_DIR);
    assertContainedPath(this.skillsRoot, transactionsRoot, 'skill transaction store');
    ensureDirectory(transactionsRoot, 'skill transaction store');
    const nonce = randomUUID();
    const pendingTransactionDir = join(transactionsRoot, `.pending-activate-${active.name}-${nonce}`);
    const transactionDir = join(transactionsRoot, `activate-${active.name}-${nonce}`);
    assertContainedPath(this.skillsRoot, pendingTransactionDir, 'pending activation transaction');
    assertContainedPath(this.skillsRoot, transactionDir, 'activation transaction');
    const pendingActiveDir = join(pendingTransactionDir, 'active');
    const stagedActiveDir = join(transactionDir, 'active');
    const previousActiveDir = join(transactionDir, 'previous-active');
    mkdirSync(pendingActiveDir, { recursive: true, mode: 0o700 });
    try {
      this.writeActiveFiles(pendingActiveDir, active);
      const record: ActivationTransactionRecord = {
        schemaVersion: 1,
        name: active.name,
        previousCandidateVersion,
        activatedCandidateVersion,
        previousActiveGeneration: active.generation - 1,
        activeGeneration: active.generation,
        activeContentDigest: active.contentDigest,
      };
      atomicWrite(join(pendingTransactionDir, TRANSACTION_RECORD_FILE), stringify(record), 0o600);
      renameSync(pendingTransactionDir, transactionDir);
      return { transactionDir, stagedActiveDir, previousActiveDir };
    } catch (error) {
      rmSync(pendingTransactionDir, { recursive: true, force: true });
      rmSync(transactionDir, { recursive: true, force: true });
      throw error;
    }
  }

  private stageRollback(
    current: ActiveSkill,
    restored: ActiveSkill,
    targetGeneration: number,
  ): {
    transactionDir: string;
    stagedActiveDir: string;
    previousActiveDir: string;
    record: RollbackTransactionRecord;
  } {
    const transactionsRoot = join(this.skillsRoot, TRANSACTIONS_DIR);
    assertContainedPath(this.skillsRoot, transactionsRoot, 'skill transaction store');
    ensureDirectory(transactionsRoot, 'skill transaction store');
    const nonce = randomUUID();
    const pendingTransactionDir = join(transactionsRoot, `.pending-rollback-${restored.name}-${nonce}`);
    const transactionDir = join(transactionsRoot, `rollback-${restored.name}-${nonce}`);
    assertContainedPath(this.skillsRoot, pendingTransactionDir, 'pending rollback transaction');
    assertContainedPath(this.skillsRoot, transactionDir, 'rollback transaction');
    const pendingActiveDir = join(pendingTransactionDir, 'active');
    const stagedActiveDir = join(transactionDir, 'active');
    const previousActiveDir = join(transactionDir, 'previous-active');
    const record: RollbackTransactionRecord = {
      schemaVersion: 1,
      kind: 'rollback',
      name: restored.name,
      previousActiveGeneration: current.generation,
      previousActiveSnapshotDigest: activeSnapshotDigest(current),
      targetGeneration,
      restoredGeneration: restored.generation,
      restoredActiveSnapshotDigest: activeSnapshotDigest(restored),
    };
    mkdirSync(pendingActiveDir, { recursive: true, mode: 0o700 });
    try {
      this.writeActiveFiles(pendingActiveDir, restored);
      atomicWrite(join(pendingTransactionDir, TRANSACTION_RECORD_FILE), stringify(record), 0o600);
      this.rollbackFailpoint?.('before-transaction-publish');
      renameSync(pendingTransactionDir, transactionDir);
      return { transactionDir, stagedActiveDir, previousActiveDir, record };
    } catch (error) {
      rmSync(pendingTransactionDir, { recursive: true, force: true });
      rmSync(transactionDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Durably select abort recovery after a synchronous failure, then complete it. A crash before
   * the marker rename recovers forward; a crash after it restores the prior generation. */
  private abortRollbackTransaction(
    transactionDir: string,
    record: RollbackTransactionRecord,
  ): void {
    const abortTransactionDir = join(dirname(transactionDir), `.aborting-${basename(transactionDir)}`);
    renameSync(transactionDir, abortTransactionDir);
    this.rollbackFailpoint?.('after-abort-marker');
    this.recoverRollbackAbort(abortTransactionDir, record);
  }

  private removeActivationVersion(candidateDir: string, version: number): void {
    const versionDir = join(candidateDir, 'versions', versionDirName(version));
    try {
      rmSync(versionDir, { recursive: true, force: true });
    } catch {
      // A failed cleanup is inert because current.json still points at the prior draft.
    }
  }

  activateCandidate(
    name: string,
    approval: SkillActivationApproval,
  ): { candidate: SkillCandidateSnapshot; active: ActiveSkill } {
    this.ensureBase();
    this.requireName(name);
    if (approval.confirmation !== 'activate') throw new Error('Activation requires explicit confirmation: "activate".');
    if (!approval.approvedBy?.trim()) throw new Error('Activation requires an approving caller identity.');
    return this.withLock(this.candidatesRoot, name, () => {
      const candidate = this.readSnapshot(name);
      if (candidate.version !== approval.expectedVersion) {
        throw new Error(`Candidate version changed: expected ${approval.expectedVersion}, current is ${candidate.version}.`);
      }
      assertCandidateActivationReady(candidate);
      return this.withLock(this.skillsRoot, name, () => {
        const now = this.timestamp();
        const { active, current } = this.planActiveCandidate(candidate, approval, now);
        const activated: SkillCandidateSnapshot = {
          ...candidate,
          version: candidate.version + 1,
          status: 'activated',
          updatedAt: now,
          decision: {
            kind: 'activated',
            by: approval.approvedBy,
            at: now,
            activeGeneration: active.generation,
          },
        };
        assertValidCandidate(activated);
        const candidateDir = this.candidateDir(name);
        const activeDir = this.activeDir(name);
        const staged = this.stageActivation(active, candidate.version, activated.version);
        let decisionCommitted = false;
        let previousMoved = false;
        try {
          // Preserve the exact previous generation before publishing either side. This operation
          // is idempotent so a failed activation can be retried without losing rollback history.
          if (current) this.archiveActive(current);

          this.activationFailpoint?.('before-candidate-commit');
          this.commitNext(candidateDir, activated);
          decisionCommitted = true;

          // Publication order is deliberate: once the new active directory is visible, the
          // candidate decision already says activated. A failure before the final rename restores
          // both the candidate pointer and the previous active directory.
          if (current) {
            renameSync(activeDir, staged.previousActiveDir);
            previousMoved = true;
          }
          this.activationFailpoint?.('before-active-publish');
          renameSync(staged.stagedActiveDir, activeDir);

          // No fallible operation belongs after publication. Cleanup is best effort because the
          // transaction is already committed and the previous generation is safely archived.
          try {
            rmSync(staged.transactionDir, { recursive: true, force: true });
          } catch {
            /* An abandoned hidden transaction directory is not an active skill. */
          }
          return { candidate: activated, active };
        } catch (error) {
          const recoveryErrors: Error[] = [];
          let candidateRestored = !decisionCommitted;
          if (previousMoved && !existsSync(activeDir)) {
            try {
              renameSync(staged.previousActiveDir, activeDir);
            } catch (recoveryError) {
              recoveryErrors.push(recoveryError as Error);
            }
          }
          if (decisionCommitted) {
            try {
              atomicWrite(join(candidateDir, CURRENT_FILE), stringify({ schemaVersion: 1, version: candidate.version }), 0o600);
              candidateRestored = true;
            } catch (recoveryError) {
              recoveryErrors.push(recoveryError as Error);
            }
          }
          if (candidateRestored) this.removeActivationVersion(candidateDir, activated.version);
          if (recoveryErrors.length === 0) {
            try {
              rmSync(staged.transactionDir, { recursive: true, force: true });
            } catch {
              /* Preserve the primary error; hidden staging content is never discovered as active. */
            }
          }
          if (recoveryErrors.length > 0) {
            throw new AggregateError([error as Error, ...recoveryErrors], 'Activation failed and recovery was incomplete.');
          }
          throw error;
        }
      });
    });
  }

  private readArchivedGeneration(name: string, generation: number): ActiveSkill {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Target generation must be a positive integer.');
    const dir = join(this.revisionsRoot, name, versionDirName(generation));
    if (!existsSync(dir)) throw new Error(`Archived generation ${generation} of "${name}" was not found.`);
    return this.readActiveFromDir(name, dir);
  }

  rollbackActiveSkill(name: string, approval: SkillRollbackApproval): ActiveSkill {
    this.ensureBase();
    this.requireName(name);
    if (approval.confirmation !== 'rollback') throw new Error('Rollback requires explicit confirmation: "rollback".');
    if (!approval.approvedBy?.trim()) throw new Error('Rollback requires an approving caller identity.');
    return this.withLock(this.skillsRoot, name, () => {
      const current = this.readActiveSkill(name);
      if (!current) throw new Error(`Active skill "${name}" was not found.`);
      if (current.generation !== approval.expectedGeneration) {
        throw new Error(`Active generation changed: expected ${approval.expectedGeneration}, current is ${current.generation}.`);
      }
      const target = this.readArchivedGeneration(name, approval.targetGeneration);
      const restored: ActiveSkill = {
        ...target,
        generation: current.generation + 1,
        activatedAt: this.timestamp(),
        approvedBy: approval.approvedBy,
        restoredFromGeneration: approval.targetGeneration,
      };
      const activeDir = this.activeDir(name);
      const staged = this.stageRollback(current, restored, approval.targetGeneration);
      try {
        this.rollbackFailpoint?.('before-current-archive');
        this.archiveActive(current);
        this.rollbackFailpoint?.('before-current-move');
        renameSync(activeDir, staged.previousActiveDir);
        this.rollbackFailpoint?.('before-active-publish');
        renameSync(staged.stagedActiveDir, activeDir);
        this.rollbackFailpoint?.('after-active-publish');
        this.bestEffortRetireRollbackTransaction(staged.transactionDir);
        return restored;
      } catch (error) {
        try {
          this.abortRollbackTransaction(staged.transactionDir, staged.record);
        } catch (recoveryError) {
          throw new AggregateError(
            [error as Error, recoveryError as Error],
            'Rollback failed and recovery was incomplete.',
          );
        }
        throw error;
      }
    });
  }
}
