import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  coerceSessionHarness,
  type SessionHarnessSnapshot,
} from './sessionState.js';

const BINDING_SCHEMA_VERSION = 1;
const MAX_BINDING_BYTES = 64 * 1024;
/** Legacy migration is exceptional; bound the one-time stable read so a workspace file cannot OOM Shadow. */
export const MAX_LEGACY_SESSION_BYTES = 256 * 1024 * 1024;

interface StableFileRead {
  bytes: Buffer;
  digest: string;
}

interface SessionBindingIdentity {
  schemaVersion: 1;
  sessionId: string;
  pathDigest: string;
}

export interface CurrentSessionHarnessBinding extends SessionBindingIdentity {
  /** Missing in bindings written by the first v2 development build; normalized on read. */
  kind: 'harness';
  harness: SessionHarnessSnapshot;
}

export interface LegacySessionBinding extends SessionBindingIdentity {
  kind: 'legacy';
  /** SHA-256 of the complete legacy JSONL at the moment the user explicitly trusted it. */
  sessionDigest: string;
}

export type SessionHarnessBinding = CurrentSessionHarnessBinding | LegacySessionBinding;

export interface SessionHarnessBindingOptions {
  /** Test/embedding override. Production defaults outside the workspace under ~/.shadow. */
  bindingsDir?: string;
}

function bindingsDir(options: SessionHarnessBindingOptions = {}): string {
  return options.bindingsDir ?? join(homedir(), '.shadow', 'session-harness-bindings');
}

function pathDigest(sessionPath: string): string {
  return createHash('sha256').update(resolve(sessionPath)).digest('hex');
}

function sessionId(sessionPath: string): string {
  const filename = sessionPath.replace(/\\/g, '/').split('/').pop() ?? '';
  return filename.endsWith('.jsonl') ? filename.slice(0, -'.jsonl'.length) : filename;
}

export function sessionHarnessBindingPath(
  sessionPath: string,
  options: SessionHarnessBindingOptions = {},
): string {
  return join(bindingsDir(options), `${pathDigest(sessionPath)}.json`);
}

function expectedBinding(sessionPath: string, harness: SessionHarnessSnapshot): CurrentSessionHarnessBinding {
  return {
    schemaVersion: BINDING_SCHEMA_VERSION,
    kind: 'harness',
    sessionId: sessionId(sessionPath),
    pathDigest: pathDigest(sessionPath),
    harness: structuredClone(harness),
  };
}

function sameBinding(left: SessionHarnessBinding, right: SessionHarnessBinding): boolean {
  if (left.schemaVersion !== right.schemaVersion
      || left.kind !== right.kind
      || left.sessionId !== right.sessionId
      || left.pathDigest !== right.pathDigest) {
    return false;
  }
  if (left.kind === 'legacy' && right.kind === 'legacy') {
    return left.sessionDigest === right.sessionDigest;
  }
  return left.kind === 'harness' && right.kind === 'harness'
    && JSON.stringify(left.harness) === JSON.stringify(right.harness);
}

/** Read one immutable view of a regular file and reject symlink swaps or in-place mutation. */
function readStableRegularFile(
  path: string,
  label: string,
  maxBytes?: number,
  ownerOnly = false,
): StableFileRead {
  let pathBefore;
  try {
    pathBefore = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new Error(`cannot inspect the ${label}: ${(error as Error).message}`);
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new Error(`the ${label} is not a regular file`);
  }
  if (ownerOnly && process.platform !== 'win32') {
    const uid = process.getuid?.();
    if ((uid !== undefined && pathBefore.uid !== BigInt(uid)) || (pathBefore.mode & 0o077n) !== 0n) {
      throw new Error(`the ${label} is not owner-only`);
    }
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== pathBefore.dev || opened.ino !== pathBefore.ino) {
      throw new Error(`the ${label} changed while it was being opened`);
    }
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)
        || (maxBytes !== undefined && opened.size > BigInt(maxBytes))) {
      throw new Error(`the ${label} is too large`);
    }
    const expectedSize = Number(opened.size);
    const bytes = Buffer.allocUnsafe(expectedSize);
    const hash = createHash('sha256');
    let total = 0;
    while (total < expectedSize) {
      const count = readSync(fd, bytes, total, Math.min(1024 * 1024, expectedSize - total), null);
      if (count === 0) break;
      hash.update(bytes.subarray(total, total + count));
      total += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (total !== expectedSize
        || after.dev !== opened.dev
        || after.ino !== opened.ino
        || after.size !== opened.size
        || after.mtimeNs !== opened.mtimeNs
        || after.ctimeNs !== opened.ctimeNs) {
      throw new Error(`the ${label} changed while it was being read`);
    }
    let pathAfter;
    try {
      pathAfter = lstatSync(path, { bigint: true });
    } catch {
      throw new Error(`the ${label} path changed while it was being read`);
    }
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
        || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new Error(`the ${label} path changed while it was being read`);
    }
    return { bytes, digest: hash.digest('hex') };
  } catch (error) {
    if ((error as Error).message.startsWith(`the ${label}`)) throw error;
    throw new Error(`cannot read the ${label}: ${(error as Error).message}`);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/** Ensure the receipt root itself cannot be redirected into the workspace or shared by another user. */
function inspectBindingsDir(options: SessionHarnessBindingOptions, create: boolean): boolean {
  if (!options.bindingsDir) {
    const shadowRoot = join(homedir(), '.shadow');
    if (create) mkdirSync(shadowRoot, { recursive: true, mode: 0o700 });
    let rootStat;
    try {
      rootStat = lstatSync(shadowRoot);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error(`cannot inspect the owner Shadow directory: ${(error as Error).message}`);
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('the owner Shadow directory must not be a symlink');
    }
    if (process.platform !== 'win32') {
      const uid = process.getuid?.();
      if (uid !== undefined && rootStat.uid !== uid) {
        throw new Error('the owner Shadow directory is not owned by the current user');
      }
      if ((rootStat.mode & 0o022) !== 0) {
        throw new Error('the owner Shadow directory is writable by another user');
      }
    }
  }
  const dir = bindingsDir(options);
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`cannot inspect the session binding directory: ${(error as Error).message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('the session binding root is not a regular directory');
  }
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error('the session binding root is not owned by the current user');
    }
    if (create) {
      try { chmodSync(dir, 0o700); } catch (error) {
        throw new Error(`cannot secure the session binding directory: ${(error as Error).message}`);
      }
      stat = lstatSync(dir);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('the session binding root is not owner-only');
    }
  }
  return true;
}

/**
 * Read the owner-only binding kept outside the workspace. An existing malformed binding is an
 * integrity failure, never equivalent to an old session that predates bindings.
 */
export function readSessionHarnessBinding(
  sessionPath: string,
  options: SessionHarnessBindingOptions = {},
): SessionHarnessBinding | undefined {
  if (!inspectBindingsDir(options, false)) return undefined;
  const path = sessionHarnessBindingPath(sessionPath, options);
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot inspect the session harness binding: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      readStableRegularFile(path, 'session harness binding', MAX_BINDING_BYTES, true).bytes.toString('utf8'),
    ) as unknown;
  } catch (error) {
    throw new Error(`the session harness binding is unreadable or malformed: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('the session harness binding is malformed');
  const value = raw as Partial<SessionHarnessBinding> & { kind?: unknown; harness?: unknown };
  if (value.schemaVersion !== BINDING_SCHEMA_VERSION
      || typeof value.sessionId !== 'string' || !value.sessionId
      || typeof value.pathDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.pathDigest)) {
    throw new Error('the session harness binding is malformed');
  }
  let binding: SessionHarnessBinding;
  if (value.kind === 'legacy') {
    if (typeof value.sessionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.sessionDigest)) {
      throw new Error('the legacy session binding is malformed');
    }
    binding = {
      schemaVersion: BINDING_SCHEMA_VERSION,
      kind: 'legacy',
      sessionId: value.sessionId,
      pathDigest: value.pathDigest,
      sessionDigest: value.sessionDigest,
    };
  } else {
    // Bindings written before the explicit discriminator were all current-format harness
    // receipts. Preserve them, but reject every other unknown kind rather than guessing.
    if (value.kind !== undefined && value.kind !== 'harness') {
      throw new Error('the session harness binding has an unsupported kind');
    }
    const harness = coerceSessionHarness(value.harness);
    if (!harness) throw new Error('the session harness binding is malformed');
    binding = {
      schemaVersion: BINDING_SCHEMA_VERSION,
      kind: 'harness',
      sessionId: value.sessionId,
      pathDigest: value.pathDigest,
      harness,
    };
  }
  const expectedPath = pathDigest(sessionPath);
  if (binding.sessionId !== sessionId(sessionPath) || binding.pathDigest !== expectedPath) {
    throw new Error('the session harness binding does not identify this session log');
  }
  return binding;
}

function recordBinding(
  sessionPath: string,
  expected: SessionHarnessBinding,
  options: SessionHarnessBindingOptions = {},
): void {
  inspectBindingsDir(options, true);
  const path = sessionHarnessBindingPath(sessionPath, options);
  const body = Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, 'utf8');
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    let written = 0;
    while (written < body.length) {
      const count = writeSync(fd, body, written, body.length - written);
      if (count <= 0) throw new Error('short write while recording the session harness binding');
      written += count;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      // A failed first write must not leave a truncated binding that looks intentional.
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
      throw new Error(`cannot record the session harness binding: ${(error as Error).message}`);
    }
    const existing = readSessionHarnessBinding(sessionPath, options);
    if (!existing || !sameBinding(existing, expected)) {
      throw new Error('the existing session harness binding does not match the active harness');
    }
  }
}

/** Create the current-format harness binding once. A pre-existing file must match exactly. */
export function recordSessionHarnessBinding(
  sessionPath: string,
  harness: SessionHarnessSnapshot,
  options: SessionHarnessBindingOptions = {},
): void {
  recordBinding(sessionPath, expectedBinding(sessionPath, harness), options);
}

/**
 * Hash one explicitly selected legacy log without following a pre-existing symlink. Legacy trust
 * is content-bound as well as path-bound: a copied, renamed, or later-rewritten log cannot inherit
 * the receipt. New Shadow sessions never call this automatically.
 */
export function readStableSessionFile(sessionPath: string): StableFileRead {
  return readStableRegularFile(sessionPath, 'legacy session log', MAX_LEGACY_SESSION_BYTES);
}

/** Record an explicit, owner-authorized exception for one exact pre-harness session file. */
export function recordLegacySessionBinding(
  sessionPath: string,
  options: SessionHarnessBindingOptions = {},
): void {
  recordLegacySessionBindingDigest(sessionPath, readStableSessionFile(sessionPath).digest, options);
}

/** Record a digest computed from the same stable bytes the caller validated as a legacy log. */
export function recordLegacySessionBindingDigest(
  sessionPath: string,
  sessionDigest: string,
  options: SessionHarnessBindingOptions = {},
): void {
  if (!/^[a-f0-9]{64}$/.test(sessionDigest)) throw new Error('invalid legacy session digest');
  const expected: LegacySessionBinding = {
    schemaVersion: BINDING_SCHEMA_VERSION,
    kind: 'legacy',
    sessionId: sessionId(sessionPath),
    pathDigest: pathDigest(sessionPath),
    sessionDigest,
  };
  recordBinding(sessionPath, expected, options);
}

export function assertSessionHarnessBinding(
  sessionPath: string,
  harness: SessionHarnessSnapshot,
  options: SessionHarnessBindingOptions = {},
): void {
  const actual = readSessionHarnessBinding(sessionPath, options);
  if (!actual) throw new Error('the owner-only session harness binding is missing');
  const expected = expectedBinding(sessionPath, harness);
  if (!sameBinding(actual, expected)) {
    throw new Error('the session harness snapshot does not match its owner-only binding');
  }
}

/** Require the owner-authorized legacy receipt and the exact JSONL bytes it was issued for. */
export function assertLegacySessionBinding(
  sessionPath: string,
  options: SessionHarnessBindingOptions = {},
): void {
  assertLegacySessionBindingDigest(sessionPath, readStableSessionFile(sessionPath).digest, options);
}

/** Validate a digest computed from the exact stable bytes the resume parser will hydrate. */
export function assertLegacySessionBindingDigest(
  sessionPath: string,
  sessionDigest: string,
  options: SessionHarnessBindingOptions = {},
): void {
  const actual = readSessionHarnessBinding(sessionPath, options);
  if (!actual) throw new Error('the owner-only legacy session binding is missing');
  if (actual.kind !== 'legacy') {
    throw new Error('the session has a current-format harness binding, not a legacy receipt');
  }
  if (actual.sessionDigest !== sessionDigest) {
    throw new Error('the legacy session log no longer matches its owner-only binding');
  }
}
