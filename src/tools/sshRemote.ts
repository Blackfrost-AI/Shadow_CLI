// sshRemote — scoped remote file access over SSH with a pinned host identity.
//
// Doctrine (plans/complete-shadow-daily-workflow-upgrade.md §10):
// - Configured hosts only. The host registry is supplied at construction,
//   validated up front, and immutable. A request naming any alias that is not
//   in the registry is refused before a single runner call is made; there is no
//   ad-hoc host string anywhere in this module.
// - Host-key pinning. Every operation first asks the runner to connect and
//   report the host key the server actually presented; that fingerprint is
//   compared against the pinned fingerprint BEFORE any probe, read or transfer
//   is issued. A mismatch aborts with the specific pinned-vs-presented diff.
// - No agent forwarding by default. The built command line always carries an
//   explicit ForwardAgent setting; forwarding is enabled only when the host
//   configuration explicitly opts in, and a call-time request without that
//   configuration is refused before any connection.
// - Bounded remote paths. Every remote path is POSIX-normalized and must land
//   under the host's configured allowed prefix (exactly the prefix or below
//   it); anything else is refused before any connection.
// - Approval binding mirrors src/tools/mutation.ts: a write approval digest
//   binds the host-identity fingerprint, the exact remote path, the exact
//   content digest, and the precondition digest of what is currently at that
//   path. It is compared with timingSafeEqual at approve AND apply time, so an
//   approval for one content, path, or host can never authorize another.
// - Honest outcomes. Remote writes resolve to applied | partial | unknown with
//   per-item remote truth; reads resolve to complete | partial | refused |
//   unknown with per-item status. Partial and unknown outcomes are recorded as
//   exactly that, never as success. Local checkpoints NEVER restore remote
//   state: there is no remote rollback, and localRestore always refuses.
//
// Honest limitations (by design, for reviewers):
// - The real network runner (realRunner) is an explicit opt-in and is NOT
//   exercised by the unit tests: this repository has no live authorized
//   target in CI, so realRunner is UNVERIFIED until it is run against an
//   explicitly configured, operator-authorized host.
// - Remote writes are not atomic on the remote side. The journal's durable
//   applying marker plus a post-transfer live re-probe make torn outcomes
//   VISIBLE and classified, not impossible.
// - There is no cross-process advisory lock. The live precondition re-probe at
//   apply time is the cross-process guard — a second process applying the same
//   approved write sees the precondition drift and aborts before any transfer —
//   but a small race window remains.
// - Remote path checks are lexical. A symlink on the remote host inside the
//   allowed prefix can still point elsewhere on that host. The prefix bounds
//   where the operator directs transfers; it is not a remote filesystem
//   semantics guarantee.
// - Reads never overwrite an existing local file and require the parent
//   directory to already exist; they refuse rather than silently creating
//   directories. Reads are not journaled: they hold no approval to bind and
//   have no crash-recovery decision to replay, and their per-item outcomes are
//   reported in full in the operation result.

import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

export class SshRemoteError extends Error {}

// ── Configuration ──────────────────────────────────────────────────────────────

/** Raw operator configuration for one host; validated and frozen at construction. */
export interface SshHostConfig {
  /** Registry lookup key. Must match [A-Za-z0-9._-]+. */
  alias: string;
  /** Hostname or IPv4 address (no user@ prefix, no IPv6 in v1). */
  address: string;
  /** SSH port; defaults to 22. */
  port?: number;
  /** Remote login user. Must match [A-Za-z0-9._-]+. */
  user: string;
  /** Pinned host-key fingerprint, canonical OpenSSH form SHA256:<43 chars>=. */
  hostKeyFingerprint: string;
  /** Absolute POSIX path every remote target must live under. '/' is refused. */
  allowedPrefix: string;
  /** Explicit opt-in for agent forwarding. Off unless set to true. */
  allowAgentForwarding?: boolean;
  /** Per-file read cap. Defaults to 1 MiB; hard limit 64 MiB. */
  maxReadBytes?: number;
}

/** The validated, frozen form handed to the runner. Never raw model input. */
export interface PinnedHost {
  alias: string;
  address: string;
  port: number;
  user: string;
  hostKeyFingerprint: string;
  allowedPrefix: string;
  allowAgentForwarding: boolean;
  maxReadBytes: number;
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const ADDRESS_RE = /^[A-Za-z0-9.-]+$/;
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}=$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const MAX_READ_BYTES_LIMIT = 64 * 1024 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;
const OP_TIMEOUT_MS = 120_000;

const sha256hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/**
 * Normalize a remote POSIX path: absolute only, no NUL/control/whitespace/backslash,
 * '.' and '..' resolved away. Returns the normalized path or throws.
 */
function normalizeRemotePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new SshRemoteError('Remote path must be a nonempty string');
  }
  if (input.includes('\0')) throw new SshRemoteError('Remote path must not contain NUL');
  for (const ch of input) {
    if (ch <= ' ' || ch === '\\') {
      throw new SshRemoteError(`Remote path must not contain whitespace or backslash: ${input}`);
    }
  }
  if (!input.startsWith('/')) throw new SshRemoteError(`Remote path must be absolute: ${input}`);
  const normalized = posix.normalize(input);
  if (!posix.isAbsolute(normalized)) {
    throw new SshRemoteError(`Remote path does not normalize to an absolute path: ${input}`);
  }
  return normalized;
}

/** Exact-prefix containment: the path itself, or strictly below prefix + '/'. */
export function withinPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function validateHost(raw: SshHostConfig): PinnedHost {
  if (!raw || typeof raw !== 'object') throw new SshRemoteError('Host configuration must be an object');
  const { alias, address, user, hostKeyFingerprint, allowedPrefix } = raw;
  if (typeof alias !== 'string' || !NAME_RE.test(alias)) {
    throw new SshRemoteError(`Host alias must match ${NAME_RE.source}: ${String(alias)}`);
  }
  if (typeof address !== 'string' || !ADDRESS_RE.test(address) || address.includes('..')) {
    throw new SshRemoteError(`Host address must be a hostname or IPv4 literal: ${String(address)}`);
  }
  const port = raw.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshRemoteError(`Host port must be an integer in 1..65535: ${String(raw.port)}`);
  }
  if (typeof user !== 'string' || !NAME_RE.test(user)) {
    throw new SshRemoteError(`Host user must match ${NAME_RE.source}: ${String(user)}`);
  }
  if (typeof hostKeyFingerprint !== 'string' || !FINGERPRINT_RE.test(hostKeyFingerprint)) {
    throw new SshRemoteError(
      `Host key fingerprint must be canonical OpenSSH form SHA256:<base64>= for host ${alias}`,
    );
  }
  let prefix: string;
  try {
    prefix = normalizeRemotePath(allowedPrefix);
  } catch (error) {
    throw new SshRemoteError(`Allowed prefix for host ${alias} is invalid: ${(error as Error).message}`);
  }
  if (prefix === '/') {
    throw new SshRemoteError(`Allowed prefix for host ${alias} must be narrower than /`);
  }
  const maxReadBytes = raw.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  if (!Number.isInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > MAX_READ_BYTES_LIMIT) {
    throw new SshRemoteError(`maxReadBytes for host ${alias} must be an integer in 1..${MAX_READ_BYTES_LIMIT}`);
  }
  const pinned: PinnedHost = {
    alias, address, port, user, hostKeyFingerprint,
    allowedPrefix: prefix,
    allowAgentForwarding: raw.allowAgentForwarding === true,
    maxReadBytes,
  };
  return Object.freeze(pinned);
}

// ── Runner surface ────────────────────────────────────────────────────────────

export type RunnerKind = 'connect' | 'probe' | 'read' | 'write';

/** One runner invocation. The runner is the ONLY execution surface. */
export interface RunnerSpec {
  kind: RunnerKind;
  /** The validated, pinned host — never a raw model string. */
  host: PinnedHost;
  /** The exact command the runner must execute, built by this module. */
  argv: readonly string[];
  remotePath?: string;
  maxBytes?: number;
  /** Write payload (stdin for the real runner). */
  payload?: Buffer;
  /** Per-operation known-hosts pin file; the real runner fills it after verification. */
  knownHostsFile: string;
  timeoutMs: number;
}

export interface RunnerResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  /** The host key fingerprint the server actually presented (connect only). */
  presentedFingerprint?: string;
}

export type SshRunner = (spec: RunnerSpec) => Promise<RunnerResult>;

/** Remote probe protocol: 'MISSING', 'TYPE', or '<bytes>\n<sha256hex>'. */
const PROBE_SCRIPT =
  'if [ ! -e "$1" ]; then printf "MISSING\\n"; exit 0; fi; ' +
  'if [ ! -f "$1" ]; then printf "TYPE\\n"; exit 0; fi; ' +
  'wc -c < "$1"; ' +
  '(sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d " " -f 1';

/** ssh arguments shared by every probe/read/write command. Pure function. */
function baseSshArgs(host: PinnedHost, knownHostsFile: string): string[] {
  const args = [
    'ssh',
    '-p', String(host.port),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHostsFile}`,
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', host.allowAgentForwarding ? 'ForwardAgent=yes' : 'ForwardAgent=no',
  ];
  if (!host.allowAgentForwarding) args.push('-o', 'ClearAllForwardings=yes');
  args.push('-o', 'ConnectTimeout=15');
  args.push(`${host.user}@${host.address}`);
  return args;
}

function connectArgv(host: PinnedHost): string[] {
  return ['ssh-keyscan', '-p', String(host.port), '-T', '5', host.address];
}

function probeArgv(host: PinnedHost, knownHostsFile: string, remotePath: string): string[] {
  return [...baseSshArgs(host, knownHostsFile), 'sh', '-c', PROBE_SCRIPT, 'probe', remotePath];
}

function readArgv(host: PinnedHost, knownHostsFile: string, remotePath: string): string[] {
  return [...baseSshArgs(host, knownHostsFile), 'cat', remotePath];
}

function writeArgv(host: PinnedHost, knownHostsFile: string, remotePath: string): string[] {
  return [...baseSshArgs(host, knownHostsFile), 'sh', '-c', 'cat > "$1"', 'write', remotePath];
}

export type ProbeResult =
  | { status: 'regular'; bytes: number; digest: string }
  | { status: 'missing' }
  | { status: 'non-regular' }
  | { status: 'unreadable' };

export function parseProbeOutput(stdout: Buffer): ProbeResult {
  const text = stdout.toString('utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length === 1 && lines[0] === 'MISSING') return { status: 'missing' };
  if (lines.length === 1 && lines[0] === 'TYPE') return { status: 'non-regular' };
  if (lines.length === 2 && /^\d+$/.test(lines[0]) && DIGEST_RE.test(lines[1])) {
    return { status: 'regular', bytes: Number(lines[0]), digest: lines[1] };
  }
  return { status: 'unreadable' };
}

// ── Journal ───────────────────────────────────────────────────────────────────

export type RemoteWriteState =
  | 'prepared' | 'approved' | 'applying' | 'applied' | 'partial' | 'unknown';

export type RemoteItemTruth = 'matches-after' | 'matches-before' | 'drifted' | 'unverifiable';

export interface RemoteWriteItem {
  remotePath: string;
  contentB64: string;
  contentDigest: string;
  /** Digest of what the path held when the write was prepared; null = absent. */
  preconditionDigest: string | null;
}

export interface RemoteWriteRecord {
  version: 1;
  id: string;
  state: RemoteWriteState;
  approvalDigest: string;
  createdAt: string;
  hostAlias: string;
  /** The pinned host-identity fingerprint the approval is bound to. */
  hostFingerprint: string;
  items: RemoteWriteItem[];
  /** Per-item remote truth, recorded when the operation resolved to partial/unknown. */
  resolution?: Array<{ remotePath: string; truth: RemoteItemTruth }>;
}

/**
 * The approval digest binds host identity + exact path + exact content digest +
 * precondition digest. Mirrors mutation.ts: any change to content, path, host,
 * or precondition produces a different digest, so one approval can never be
 * replayed against another.
 */
export function remoteWriteApprovalDigest(hostFingerprint: string, items: RemoteWriteItem[]): string {
  return sha256hex(JSON.stringify({
    binding: 'ssh-remote-write-v1',
    hostFingerprint,
    items: items.map((item) => ({
      remotePath: item.remotePath,
      contentDigest: item.contentDigest,
      preconditionDigest: item.preconditionDigest,
    })),
  }));
}

export interface ReconciledRemoteOperation {
  id: string;
  hostAlias: string;
  state: RemoteWriteState;
  recordProblem?: string;
  items: Array<{ remotePath: string; truth: RemoteItemTruth }>;
}

export interface WriteOutcome {
  id: string;
  hostAlias: string;
  state: 'applied' | 'partial' | 'unknown';
  items: Array<{ remotePath: string; truth: RemoteItemTruth }>;
  /** Local checkpoints never restore remote state; this is always unavailable. */
  localRestore: { available: false; reason: string };
}

export type ReadItemStatus =
  | 'landed' | 'refused-oversize' | 'refused-missing' | 'refused-non-regular'
  | 'probe-failed' | 'transfer-failed' | 'truncated' | 'landing-failed' | 'landing-mismatch';

export interface ReadItemOutcome {
  remotePath: string;
  localPath: string;
  status: ReadItemStatus;
  bytes: number;
  digest: string | null;
}

export interface ReadOutcome {
  hostAlias: string;
  outcome: 'complete' | 'partial' | 'refused' | 'unknown';
  items: ReadItemOutcome[];
}

export interface SshRemote {
  readRemote(request: {
    host: string;
    items: Array<{ remotePath: string; localPath: string }>;
    agentForwarding?: boolean;
  }): Promise<ReadOutcome>;
  prepareWrite(request: { host: string; items: Array<{ remotePath: string; content: string }> }): Promise<RemoteWriteRecord>;
  approveWrite(id: string, approvalDigest: string): Promise<RemoteWriteRecord>;
  applyWrite(id: string, approvalDigest: string): Promise<WriteOutcome>;
  writeStatus(id: string): RemoteWriteRecord;
  /** Always refuses: local checkpoints do not restore remote state. */
  localRestore(id: string): Promise<never>;
  localRestoreStatus(id: string): Promise<{ available: false; reason: string; remoteState: RemoteWriteState }>;
  reconcile(): Promise<ReconciledRemoteOperation[]>;
}

export interface SshRemoteOptions {
  /** Test hook: the entire SSH command surface. No real network when injected. */
  runner?: SshRunner;
  /**
   * Explicit opt-in for the REAL network runner. Without an injected runner and
   * without this flag every operation fails closed. The real runner is
   * UNVERIFIED in this repository (no live authorized target in CI).
   */
  realRunner?: boolean;
}

const WRITE_STATES: readonly RemoteWriteState[] = [
  'prepared', 'approved', 'applying', 'applied', 'partial', 'unknown',
];

export function createSshRemote(workspaceRoot: string, hosts: SshHostConfig[], options: SshRemoteOptions = {}): SshRemote {
  const root = realpathSync(resolve(workspaceRoot));
  const journalDir = join(root, '.shadow', 'ssh-remote');
  const knownHostsDir = join(journalDir, 'known-hosts');
  const reservedPrefix = `${journalDir}${sep}`;

  const registry = new Map<string, PinnedHost>();
  if (Array.isArray(hosts)) {
    for (const raw of hosts) {
      const pinned = validateHost(raw);
      if (registry.has(pinned.alias)) {
        throw new SshRemoteError(`Duplicate host alias in the registry: ${pinned.alias}`);
      }
      registry.set(pinned.alias, pinned);
    }
  }

  const runner: SshRunner | undefined = options.runner;
  const useRealRunner = options.realRunner === true && !runner;
  const inFlight = new Set<string>();

  function requireRunner(): SshRunner {
    if (runner) return runner;
    if (useRealRunner) return realRunner;
    throw new SshRemoteError(
      'No SSH runner configured: remote access is disabled. Live access requires an explicitly configured authorized target.',
    );
  }

  function ensureJournalDirectory(): void {
    let current = root;
    for (const part of ['.shadow', 'ssh-remote']) {
      current = resolve(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new SshRemoteError(`SSH journal path must be a real directory: ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(current, { mode: 0o700 });
        chmodSync(current, 0o700);
      }
    }
    try {
      const stat = lstatSync(knownHostsDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new SshRemoteError(`Known-hosts path must be a real directory: ${knownHostsDir}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(knownHostsDir, { mode: 0o700 });
      chmodSync(knownHostsDir, 0o700);
    }
  }

  function durableWrite(path: string, content: string): void {
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeSync(fd, content);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw error;
    }
    try {
      const dirFd = openSync(dirname(path), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* best effort on platforms without directory fsync */ }
  }

  function landBytes(path: string, bytes: Buffer): void {
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw error;
    }
    try {
      const dirFd = openSync(dirname(path), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* best effort on platforms without directory fsync */ }
  }

  function cleanupTemp(path: string): void {
    try { unlinkSync(path); } catch { /* best effort */ }
  }

  function decode(raw: unknown): RemoteWriteRecord {
    let parsed: unknown;
    try { parsed = JSON.parse(String(raw)); } catch { throw new SshRemoteError('Invalid SSH remote journal record'); }
    if (!parsed || typeof parsed !== 'object') throw new SshRemoteError('Invalid SSH remote journal record');
    const record = parsed as Partial<RemoteWriteRecord>;
    if (record.version !== 1) throw new SshRemoteError('Unsupported SSH remote journal version');
    if (typeof record.id !== 'string' || !UUID_RE.test(record.id)) {
      throw new SshRemoteError('Invalid SSH remote journal metadata');
    }
    if (typeof record.state !== 'string' || !WRITE_STATES.includes(record.state as RemoteWriteState)) {
      throw new SshRemoteError('Invalid SSH remote journal metadata');
    }
    if (typeof record.approvalDigest !== 'string' || !DIGEST_RE.test(record.approvalDigest)) {
      throw new SshRemoteError('Invalid SSH remote journal metadata');
    }
    if (typeof record.createdAt !== 'string' || !ISO_RE.test(record.createdAt)) {
      throw new SshRemoteError('Invalid SSH remote journal metadata');
    }
    if (typeof record.hostAlias !== 'string' || !NAME_RE.test(record.hostAlias)) {
      throw new SshRemoteError('Invalid SSH remote journal metadata');
    }
    if (typeof record.hostFingerprint !== 'string' || !FINGERPRINT_RE.test(record.hostFingerprint)) {
      throw new SshRemoteError('Invalid SSH remote journal metadata');
    }
    if (!Array.isArray(record.items) || record.items.length === 0) {
      throw new SshRemoteError('Invalid SSH remote journal record');
    }
    for (const item of record.items) {
      if (!item || typeof item.remotePath !== 'string' || !item.remotePath.startsWith('/')) {
        throw new SshRemoteError('Invalid SSH remote journal record');
      }
      if (typeof item.contentB64 !== 'string' || !B64_RE.test(item.contentB64)) {
        throw new SshRemoteError('Invalid SSH remote journal record');
      }
      if (typeof item.contentDigest !== 'string' || !DIGEST_RE.test(item.contentDigest)) {
        throw new SshRemoteError('Invalid SSH remote journal record');
      }
      // The approval binds the EXACT bytes: the decoded payload must re-derive
      // the approved digest. Without this, a same-user process could swap the
      // transferred bytes while leaving the digest (and thus the approval) valid.
      if (sha256hex(Buffer.from(item.contentB64, 'base64')) !== item.contentDigest) {
        throw new SshRemoteError('SSH remote journal record does not match its approved digest');
      }
      if (item.preconditionDigest !== null
        && (typeof item.preconditionDigest !== 'string' || !DIGEST_RE.test(item.preconditionDigest))) {
        throw new SshRemoteError('Invalid SSH remote journal record');
      }
    }
    if (new Set(record.items.map((item) => item.remotePath)).size !== record.items.length) {
      throw new SshRemoteError('Duplicate remote targets in journal record');
    }
    if (record.resolution !== undefined) {
      if (!Array.isArray(record.resolution) || record.resolution.length === 0) {
        throw new SshRemoteError('Invalid SSH remote journal record');
      }
      for (const row of record.resolution) {
        if (!row || typeof row.remotePath !== 'string' || !row.remotePath.startsWith('/')) {
          throw new SshRemoteError('Invalid SSH remote journal record');
        }
        if (row.truth !== 'matches-after' && row.truth !== 'matches-before'
          && row.truth !== 'drifted' && row.truth !== 'unverifiable') {
          throw new SshRemoteError('Invalid SSH remote journal record');
        }
      }
    }
    if (record.approvalDigest !== remoteWriteApprovalDigest(record.hostFingerprint, record.items)) {
      throw new SshRemoteError('Approval digest does not match journal contents');
    }
    return record as RemoteWriteRecord;
  }

  function readRecord(id: string): RemoteWriteRecord {
    if (!UUID_RE.test(id)) throw new SshRemoteError('Invalid remote write id');
    ensureJournalDirectory();
    const path = join(journalDir, `${id}.json`);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SshRemoteError('Journal record must be a real file');
    }
    return decode(readFileSync(path));
  }

  function persist(record: RemoteWriteRecord): void {
    ensureJournalDirectory();
    durableWrite(join(journalDir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }

  function assertDigest(actual: string, expected: string): void {
    if (!DIGEST_RE.test(expected)) {
      throw new SshRemoteError('Approval digest must be a lowercase SHA256 hex digest');
    }
    if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) {
      throw new SshRemoteError('Approval does not bind to this exact host, path, content, and precondition');
    }
  }

  function lookupHost(alias: string): PinnedHost {
    if (typeof alias !== 'string' || alias.length === 0) {
      throw new SshRemoteError('Host alias must be a nonempty string');
    }
    const pinned = registry.get(alias);
    if (!pinned) {
      throw new SshRemoteError(
        `Host is not configured: ${alias}. Only pre-configured hosts with a pinned host key may be accessed; ad-hoc hosts are refused.`,
      );
    }
    return pinned;
  }

  /** Validate every remote path against the host's allowed prefix. */
  function checkRemotePaths(host: PinnedHost, paths: string[]): string[] {
    return paths.map((raw) => {
      let normalized: string;
      try {
        normalized = normalizeRemotePath(raw);
      } catch (error) {
        throw new SshRemoteError(`Refusing remote path: ${(error as Error).message}`);
      }
      if (!withinPrefix(normalized, host.allowedPrefix)) {
        throw new SshRemoteError(
          `Remote path is outside the allowed prefix for host ${host.alias}: ${normalized} is not under ${host.allowedPrefix}`,
        );
      }
      return normalized;
    });
  }

  function checkAgentForwarding(host: PinnedHost, requested?: boolean): void {
    if (requested === true && !host.allowAgentForwarding) {
      throw new SshRemoteError(
        `Agent forwarding is not configured for host ${host.alias}; it is off by default and cannot be enabled per call.`,
      );
    }
  }

  /**
   * Validate a fresh local landing target for a read: workspace-relative, no
   * symlink anywhere on the existing path, parent directory must exist, the
   * target itself must not exist, and never inside the journal.
   */
  function localLandingTarget(input: string): string {
    if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
      throw new SshRemoteError('Local landing path must be a nonempty path');
    }
    if (isAbsolute(input)) throw new SshRemoteError(`Local landing path must be workspace-relative: ${input}`);
    const absolute = resolve(root, input);
    const normalized = relative(root, absolute);
    if (!normalized || normalized === '..' || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
      throw new SshRemoteError(`Local landing path must stay inside the workspace: ${input}`);
    }
    if (absolute === journalDir || absolute.startsWith(reservedPrefix)) {
      throw new SshRemoteError('Local landing path cannot be inside the SSH journal');
    }
    const parts = normalized.split(sep);
    let current = root;
    for (let index = 0; index < parts.length - 1; index++) {
      current = resolve(current, parts[index]!);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        throw new SshRemoteError(`Landing parent directory does not exist: ${input}`);
      }
      if (stat.isSymbolicLink()) throw new SshRemoteError(`Symbolic links in the landing path are unsupported: ${input}`);
      if (!stat.isDirectory()) throw new SshRemoteError(`Landing parent must be a directory: ${input}`);
    }
    const final = resolve(current, parts[parts.length - 1]!);
    try {
      const stat = lstatSync(final);
      if (stat.isSymbolicLink()) throw new SshRemoteError(`Symbolic links in the landing path are unsupported: ${input}`);
      throw new SshRemoteError(`Local landing target already exists; reads never overwrite: ${input}`);
    } catch (error) {
      if ((error as Error) instanceof SshRemoteError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return final;
  }

  /**
   * Connect and verify the host key BEFORE any probe, read, or transfer. The
   * comparison is authoritative in this module, not in the runner.
   */
  async function connectAndVerify(host: PinnedHost, knownHostsFile: string): Promise<void> {
    const result = await requireRunner()({
      kind: 'connect',
      host,
      argv: connectArgv(host),
      knownHostsFile,
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    const presented = result.presentedFingerprint;
    if (typeof presented !== 'string' || presented.length === 0) {
      throw new SshRemoteError(
        `Host key verification failed for host ${host.alias}: no host key was presented (${result.stderr.trim() || 'no output'})`,
      );
    }
    if (presented !== host.hostKeyFingerprint) {
      throw new SshRemoteError(
        `Host key mismatch for host ${host.alias}: pinned ${host.hostKeyFingerprint} but the server presented ${presented}. ` +
        'Aborting before any command or transfer; the pinned fingerprint must be re-verified out of band before this host is used again.',
      );
    }
  }

  async function liveProbe(host: PinnedHost, knownHostsFile: string, remotePath: string): Promise<ProbeResult> {
    const result = await requireRunner()({
      kind: 'probe',
      host,
      argv: probeArgv(host, knownHostsFile, remotePath),
      remotePath,
      knownHostsFile,
      timeoutMs: OP_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return { status: 'unreadable' };
    return parseProbeOutput(result.stdout);
  }

  function classifyTruth(
    probe: ProbeResult,
    contentDigest: string,
    preconditionDigest: string | null,
  ): RemoteItemTruth {
    if (probe.status === 'unreadable') return 'unverifiable';
    if (probe.status === 'regular' && probe.digest === contentDigest) return 'matches-after';
    if (preconditionDigest === null && probe.status === 'missing') return 'matches-before';
    if (probe.status === 'regular' && preconditionDigest !== null && probe.digest === preconditionDigest) {
      return 'matches-before';
    }
    return 'drifted';
  }

  async function classifyRecord(record: RemoteWriteRecord): Promise<RemoteItemTruth[]> {
    const host = registry.get(record.hostAlias);
    if (!host) return record.items.map(() => 'unverifiable' as const);
    const knownHostsFile = join(knownHostsDir, `${randomUUID()}.known_hosts`);
    try {
      try {
        await connectAndVerify(host, knownHostsFile);
      } catch {
        return record.items.map(() => 'unverifiable' as const);
      }
      const truths: RemoteItemTruth[] = [];
      for (const item of record.items) {
        const probe = await liveProbe(host, knownHostsFile, item.remotePath);
        truths.push(classifyTruth(probe, item.contentDigest, item.preconditionDigest));
      }
      return truths;
    } finally {
      cleanupTemp(knownHostsFile);
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async function readRemote(request: {
    host: string;
    items: Array<{ remotePath: string; localPath: string }>;
    agentForwarding?: boolean;
  }): Promise<ReadOutcome> {
    if (!request || !Array.isArray(request.items) || request.items.length === 0) {
      throw new SshRemoteError('readRemote requires a nonempty item array');
    }
    for (const item of request.items) {
      if (!item || typeof item.remotePath !== 'string' || typeof item.localPath !== 'string') {
        throw new SshRemoteError('Each read item requires remotePath and localPath');
      }
    }
    if (new Set(request.items.map((item) => item.localPath)).size !== request.items.length) {
      throw new SshRemoteError('Read items must have unique local landing paths');
    }
    const host = lookupHost(request.host);
    checkAgentForwarding(host, request.agentForwarding);
    const remotePaths = checkRemotePaths(host, request.items.map((item) => item.remotePath));
    if (new Set(remotePaths).size !== remotePaths.length) {
      throw new SshRemoteError('Read items must have unique remote paths');
    }
    const localPaths = request.items.map((item) => localLandingTarget(item.localPath));
    const maxBytes = host.maxReadBytes;
    const knownHostsFile = join(knownHostsDir, `${randomUUID()}.known_hosts`);
    const outcomes: ReadItemOutcome[] = [];
    try {
      await connectAndVerify(host, knownHostsFile);
      for (let index = 0; index < remotePaths.length; index++) {
        const remotePath = remotePaths[index]!;
        const localPath = localPaths[index]!;
        const base: ReadItemOutcome = { remotePath, localPath, status: 'probe-failed', bytes: 0, digest: null };
        const probe = await liveProbe(host, knownHostsFile, remotePath);
        if (probe.status === 'unreadable') { outcomes.push(base); continue; }
        if (probe.status === 'missing') {
          outcomes.push({ ...base, status: 'refused-missing' }); continue;
        }
        if (probe.status === 'non-regular') {
          outcomes.push({ ...base, status: 'refused-non-regular' }); continue;
        }
        if (probe.bytes > maxBytes) {
          outcomes.push({ ...base, status: 'refused-oversize' }); continue;
        }
        const result = await requireRunner()({
          kind: 'read',
          host,
          argv: readArgv(host, knownHostsFile, remotePath),
          remotePath,
          maxBytes,
          knownHostsFile,
          timeoutMs: OP_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) {
          outcomes.push({ ...base, status: 'transfer-failed' });
          continue;
        }
        const received = result.stdout;
        if (received.length > maxBytes) {
          outcomes.push({ ...base, status: 'truncated', bytes: received.length });
          continue;
        }
        const digest = sha256hex(received);
        let renameLanded = false;
        try {
          landBytes(localPath, received);
          renameLanded = true;
        } catch {
          // The atomic rename may still have completed (a post-rename fsync
          // failure throws after the file is in place). Do not guess: verify
          // below what actually landed, byte-for-byte.
        }
        try {
          const verify = readFileSync(localPath);
          if (verify.equals(received)) {
            outcomes.push({ ...base, status: 'landed', bytes: received.length, digest });
          } else {
            // The landed bytes differ from what we received: remove our own
            // bad landing (the target was verified absent beforehand) and
            // record the mismatch — never a success.
            cleanupTemp(localPath);
            outcomes.push({ ...base, status: 'landing-mismatch', bytes: received.length });
          }
        } catch {
          // Nothing landed (or the landing is unreadable): nothing to clean.
          outcomes.push({ ...base, status: 'landing-failed', bytes: renameLanded ? received.length : 0 });
        }
      }
    } finally {
      cleanupTemp(knownHostsFile);
    }
    const landedCount = outcomes.filter((item) => item.status === 'landed').length;
    // Undetermined effects are NEVER claimed as a refusal: a failed probe or
    // transfer means the outcome is unknown, not "we declined it". A truncated
    // item means the probe and the transfer disagreed about the file's size —
    // the cap enforcement layers contradicted each other, which is an integrity
    // failure, not a routine refusal.
    const undetermined = outcomes.some((item) =>
      item.status === 'probe-failed'
      || item.status === 'transfer-failed'
      || item.status === 'truncated');
    const unclearLanding = outcomes.some(
      (item) => item.status === 'landing-failed' || item.status === 'landing-mismatch');
    let outcome: ReadOutcome['outcome'];
    if (undetermined || unclearLanding) outcome = 'unknown';
    else if (landedCount === outcomes.length) outcome = 'complete';
    else if (landedCount > 0) outcome = 'partial';
    else outcome = 'refused';
    return { hostAlias: host.alias, outcome, items: outcomes };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  async function prepareWrite(request: { host: string; items: Array<{ remotePath: string; content: string }> }): Promise<RemoteWriteRecord> {
    if (!request || !Array.isArray(request.items) || request.items.length === 0) {
      throw new SshRemoteError('prepareWrite requires a nonempty item array');
    }
    for (const item of request.items) {
      if (!item || typeof item.remotePath !== 'string' || typeof item.content !== 'string') {
        throw new SshRemoteError('Each write item requires remotePath and content');
      }
    }
    if (new Set(request.items.map((item) => item.remotePath)).size !== request.items.length) {
      throw new SshRemoteError('Write items must have unique remote paths');
    }
    const host = lookupHost(request.host);
    const remotePaths = checkRemotePaths(host, request.items.map((item) => item.remotePath));
    const items: RemoteWriteItem[] = [];
    for (let index = 0; index < remotePaths.length; index++) {
      const bytes = Buffer.from(request.items[index]!.content, 'utf8');
      if (bytes.length > MAX_WRITE_BYTES) {
        throw new SshRemoteError(`Remote write exceeds ${MAX_WRITE_BYTES} bytes: ${remotePaths[index]}`);
      }
      items.push({
        remotePath: remotePaths[index]!,
        contentB64: bytes.toString('base64'),
        contentDigest: sha256hex(bytes),
        preconditionDigest: null,
      });
    }
    const knownHostsFile = join(knownHostsDir, `${randomUUID()}.known_hosts`);
    try {
      await connectAndVerify(host, knownHostsFile);
      for (const item of items) {
        const probe = await liveProbe(host, knownHostsFile, item.remotePath);
        if (probe.status === 'unreadable') {
          throw new SshRemoteError(`Cannot bind an approval to an unreadable precondition: ${item.remotePath}`);
        }
        if (probe.status === 'non-regular') {
          throw new SshRemoteError(`Refusing to write over a non-regular remote file: ${item.remotePath}`);
        }
        item.preconditionDigest = probe.status === 'missing' ? null : probe.digest;
      }
      const record: RemoteWriteRecord = {
        version: 1,
        id: randomUUID(),
        state: 'prepared',
        approvalDigest: remoteWriteApprovalDigest(host.hostKeyFingerprint, items),
        createdAt: new Date().toISOString(),
        hostAlias: host.alias,
        hostFingerprint: host.hostKeyFingerprint,
        items,
      };
      persist(record);
      return record;
    } finally {
      cleanupTemp(knownHostsFile);
    }
  }

  async function approveWrite(id: string, approvalDigest: string): Promise<RemoteWriteRecord> {
    const record = readRecord(id);
    if (record.state !== 'prepared') throw new SshRemoteError('Only a prepared remote write can be approved');
    assertDigest(record.approvalDigest, approvalDigest);
    record.state = 'approved';
    persist(record);
    return record;
  }

  async function applyWrite(id: string, approvalDigest: string): Promise<WriteOutcome> {
    if (inFlight.has(id)) throw new SshRemoteError('This remote write is already in progress');
    const record = readRecord(id);
    if (record.state !== 'approved') {
      throw new SshRemoteError('Only an approved remote write can be applied; interrupted operations are never replayed');
    }
    assertDigest(record.approvalDigest, approvalDigest);
    const host = registry.get(record.hostAlias);
    if (!host) {
      throw new SshRemoteError(`Host ${record.hostAlias} is no longer configured; the approved write cannot be applied`);
    }
    if (host.hostKeyFingerprint !== record.hostFingerprint) {
      throw new SshRemoteError(
        `Host ${record.hostAlias} has been re-pinned; the approval bound to ${record.hostFingerprint} no longer applies`,
      );
    }
    inFlight.add(id);
    const knownHostsFile = join(knownHostsDir, `${randomUUID()}.known_hosts`);
    try {
      // Fresh verification and a live precondition re-probe: any drift aborts
      // BEFORE the first transfer, with the record still 'approved' and no side
      // effects. This is also the cross-process guard.
      await connectAndVerify(host, knownHostsFile);
      for (const item of record.items) {
        const probe = await liveProbe(host, knownHostsFile, item.remotePath);
        if (probe.status === 'unreadable') {
          // The precondition cannot be verified right now: no transfer has
          // happened, so the record stays 'approved' and the operation refuses.
          // A later retry re-verifies from scratch.
          throw new SshRemoteError(
            `Remote precondition is unverifiable right now; refusing to apply without a verified precondition: ${item.remotePath}`,
          );
        }
        const drift = item.preconditionDigest === null
          ? probe.status !== 'missing'
          : !(probe.status === 'regular' && probe.digest === item.preconditionDigest);
        if (drift) {
          throw new SshRemoteError(
            `Remote precondition drifted before transfer; refusing to apply: ${item.remotePath}`,
          );
        }
      }
      record.state = 'applying';
      persist(record);
      let transferError: Error | undefined;
      try {
        for (const item of record.items) {
          const payload = Buffer.from(item.contentB64, 'base64');
          const result = await requireRunner()({
            kind: 'write',
            host,
            argv: writeArgv(host, knownHostsFile, item.remotePath),
            remotePath: item.remotePath,
            payload,
            knownHostsFile,
            timeoutMs: OP_TIMEOUT_MS,
          });
          if (result.exitCode !== 0) {
            // A nonzero transfer exit is a failure signal independent of what
            // the later live probe finds: stop transferring, classify what has
            // already happened, and never return a success-shaped result.
            transferError = new SshRemoteError(
              `Remote transfer failed for ${item.remotePath}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
            );
            break;
          }
        }
      } catch (error) {
        // The transfer attempt failed midway: the remote effect is undetermined
        // by the error alone. The live re-probe below decides applied/partial/
        // unknown, the journal records that truth, and the caller gets the
        // failure — never a success-shaped result.
        transferError = error as Error;
      }
      // Live per-item truth, whatever the transfers reported: the remote state
      // is re-probed and classified. Nothing is inferred from exit codes alone.
      const truths = await classifyRecord(record);
      const applied = truths.filter((truth) => truth === 'matches-after').length;
      const allBeforeOrAfter = truths.every(
        (truth) => truth === 'matches-after' || truth === 'matches-before',
      );
      let state: WriteOutcome['state'];
      if (applied === truths.length) state = 'applied';
      else if (applied > 0 && allBeforeOrAfter) state = 'partial';
      else state = 'unknown';
      record.state = state;
      const resolution = record.items.map((item, index) => ({
        remotePath: item.remotePath,
        truth: truths[index]!,
      }));
      record.resolution = resolution;
      persist(record);
      if (transferError) {
        throw new SshRemoteError(
          `Remote write ${record.id} did not complete: ${transferError.message}. ` +
          `The operation is durably recorded as '${state}' with per-item remote truth; it is never reported as success. ` +
          'Local checkpoints do not restore remote state.',
        );
      }
      return {
        id: record.id,
        hostAlias: record.hostAlias,
        state,
        items: resolution,
        localRestore: {
          available: false,
          reason: 'Local checkpoints do not restore remote state; there is no remote rollback. The per-item remote truth above is the authoritative record.',
        },
      };
    } finally {
      inFlight.delete(id);
      cleanupTemp(knownHostsFile);
    }
  }

  function writeStatus(id: string): RemoteWriteRecord {
    return readRecord(id);
  }

  async function localRestore(id: string): Promise<never> {
    const record = readRecord(id);
    throw new SshRemoteError(
      `Local checkpoints do not restore remote state: remote write ${record.id} on host ${record.hostAlias} ` +
      `is recorded as '${record.state}' and its remote truth stands. There is no remote rollback; ` +
      'any repair must be a new, separately approved remote write.',
    );
  }

  async function localRestoreStatus(id: string): Promise<{ available: false; reason: string; remoteState: RemoteWriteState }> {
    const record = readRecord(id);
    return {
      available: false,
      reason: 'Local checkpoints do not restore remote state; there is no remote rollback.',
      remoteState: record.state,
    };
  }

  async function reconcile(): Promise<ReconciledRemoteOperation[]> {
    ensureJournalDirectory();
    const results: ReconciledRemoteOperation[] = [];
    for (const name of readdirSync(journalDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      let record: RemoteWriteRecord;
      try {
        const path = join(journalDir, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new SshRemoteError('Journal record must be a real file');
        record = decode(readFileSync(path));
        if (record.id !== id) throw new SshRemoteError('Journal record id mismatch');
      } catch (error) {
        results.push({
          id, hostAlias: 'unknown', state: 'unknown',
          recordProblem: (error as Error).message,
          items: [],
        });
        continue;
      }
      if (record.state !== 'applying' && record.state !== 'partial' && record.state !== 'unknown') continue;
      const truths = await classifyRecord(record);
      results.push({
        id,
        hostAlias: record.hostAlias,
        state: record.state,
        items: record.items.map((item, index) => ({ remotePath: item.remotePath, truth: truths[index]! })),
      });
    }
    return results;
  }

  return { readRemote, prepareWrite, approveWrite, applyWrite, writeStatus, localRestore, localRestoreStatus, reconcile };
}

// ── Real runner (explicit opt-in, UNVERIFIED) ────────────────────────────────
//
// This is the only code path that touches a real network. It is an explicit
// opt-in (options.realRunner) and is NOT exercised by the unit tests: no live
// authorized target exists in CI. Strategy: fetch the presented host key with
// ssh-keyscan, extract its fingerprint with ssh-keygen, and only materialize a
// per-operation known_hosts pin when a scanned key EXACTLY matches the pinned
// fingerprint. Every subsequent ssh call runs with StrictHostKeyChecking=yes
// against that pin file. The module's own fingerprint comparison (above) is
// authoritative and aborts the operation on any mismatch before a command runs.

const REAL_RUNNER_NOTE = 'UNVERIFIED: the real SSH runner has no live authorized target in CI.';

async function spawnCollect(
  argv: readonly string[],
  payload: Buffer | undefined,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: string }> {
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let settled = false;
  return await new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      rejectPromise(new SshRemoteError(`${REAL_RUNNER_NOTE} spawn failed: ${(error as Error).message}`));
      return;
    }
    const finish = (exitCode: number | null, stderr: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, stdout: Buffer.concat(chunks), stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { errChunks.push(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; rejectPromise(new SshRemoteError(`${REAL_RUNNER_NOTE} ${error.message}`)); }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code, Buffer.concat(errChunks).toString('utf8'));
    });
    if (payload) {
      child.stdin?.on('error', () => { /* EPIPE: the close event carries the outcome */ });
      child.stdin?.end(payload);
    } else {
      child.stdin?.end();
    }
  });
}

/** Extract the SHA256 fingerprint of a raw host-key block using ssh-keygen. */
async function fingerprintOf(rawKey: string): Promise<string | null> {
  const result = await spawnCollect(['ssh-keygen', '-lf', '-'], Buffer.from(rawKey, 'utf8'), 20_000);
  if (result.exitCode !== 0) return null;
  const match = result.stdout.toString('utf8').match(/SHA256:[A-Za-z0-9+/]{43}=/);
  return match ? match[0] : null;
}

async function writePinnedFile(path: string, content: string): Promise<void> {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const realRunner: SshRunner = async (spec) => {
  if (spec.kind === 'connect') {
    const scan = await spawnCollect(spec.argv, undefined, spec.timeoutMs);
    const blocks = scan.stdout.toString('utf8').split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    if (blocks.length === 0) {
      return { exitCode: scan.exitCode ?? 1, stdout: Buffer.alloc(0), stderr: scan.stderr || 'no host key presented' };
    }
    for (const block of blocks) {
      const fingerprint = await fingerprintOf(block);
      if (fingerprint && fingerprint === spec.host.hostKeyFingerprint) {
        await writePinnedFile(spec.knownHostsFile, `${block}\n`);
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: scan.stderr, presentedFingerprint: fingerprint };
      }
    }
    const first = await fingerprintOf(blocks[0]!);
    return {
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: `${REAL_RUNNER_NOTE} no scanned host key matched the pinned fingerprint`,
      presentedFingerprint: first ?? undefined,
    };
  }
  const result = await spawnCollect(spec.argv, spec.payload, spec.timeoutMs);
  if (!existsSync(spec.knownHostsFile)) {
    return { ...result, exitCode: result.exitCode ?? 1, stderr: `${REAL_RUNNER_NOTE} known-hosts pin was not materialized` };
  }
  return result;
};
