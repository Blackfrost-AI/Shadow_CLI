import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadGlobalConfig, saveGlobalConfig } from '../state/globalStore.js';
import {
  emptyEndpointRegistry,
  ENDPOINT_SCHEMA_VERSION,
  normalizeEndpointUrl,
  type EndpointPatch,
  type EndpointRegistryState,
  type SavedEndpoint,
} from './types.js';

/** Sidecar lock beside the real global config; never written through, only created exclusively. */
const GLOBAL_LOCK_PATH = join(homedir(), '.shadow', 'endpoints.lock');
const LOCK_TIMEOUT_MS = 2_000;

function lockPath(path: string): string {
  return `${path}.lock`;
}
const STALE_LOCK_MS = 30_000;

export class EndpointConflictError extends Error {
  readonly code = 'endpoint_revision_conflict';
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`endpoint registry changed (expected revision ${expectedRevision}, found ${actualRevision})`);
    this.name = 'EndpointConflictError';
  }
}

function ensureParent(): void {
  mkdirSync(join(homedir(), '.shadow'), { recursive: true, mode: 0o700 });
}

function parseState(raw: string): EndpointRegistryState {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('endpoint registry must be an object');
  const candidate = parsed as Partial<EndpointRegistryState>;
  if (candidate.schemaVersion !== ENDPOINT_SCHEMA_VERSION || !Array.isArray(candidate.endpoints) || !Array.isArray(candidate.observations)) {
    throw new Error(`unsupported endpoint registry schema (expected ${ENDPOINT_SCHEMA_VERSION})`);
  }
  if (!Number.isInteger(candidate.revision) || (candidate.revision ?? -1) < 0) throw new Error('endpoint registry revision is invalid');
  return candidate as EndpointRegistryState;
}

export function loadEndpointRegistry(path?: string): EndpointRegistryState {
  if (!path) {
    const global = loadGlobalConfig();
    const value = global.endpoints;
    if (!value || typeof value !== 'object') return emptyEndpointRegistry();
    // A malformed or future-schema registry must not brick every endpoint route. Treat it as empty
    // so a user can re-add endpoints; the next successful write replaces the bad blob wholesale.
    try {
      return parseState(JSON.stringify(value));
    } catch {
      return emptyEndpointRegistry();
    }
  }
  ensureParent();
  if (!existsSync(path)) return emptyEndpointRegistry();
  return parseState(readFileSync(path, 'utf8'));
}

function acquireLock(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = lockPath(path);
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, 'owner'), `${process.pid}\n`, { mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // A disappearing lock is retried below.
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error('timed out waiting for endpoint registry lock');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function releaseLock(path: string): void {
  rmSync(lockPath(path), { recursive: true, force: true });
}

/** Synchronous sleep for the blocking lock retry (no event-loop turn is available there). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process exclusive lock for the GLOBAL registry (config.json).
 *
 * The production registry lives inside `~/.shadow/config.json`, which several processes (terminal,
 * `shadow web`, an MCP client) can write at once. Revisions are compared against a stale in-memory
 * read, so without a lock two overlapping writes both pass the expectedRevision check and the
 * second rename silently drops the first endpoint. The file lock makes the read-modify-write
 * genuinely exclusive; `saveGlobalConfig` still merges onto the CURRENT bytes and refuses to
 * overwrite an unparseable file, so a crash between read and write cannot lose other settings.
 */
function withGlobalLock<T>(fn: () => T): T {
  ensureParent();
  const lock = GLOBAL_LOCK_PATH;
  const started = Date.now();
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lock, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
      } catch {
        // A disappearing lock is retried below.
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error('timed out waiting for endpoint registry lock');
      // Block the thread instead of spinning: `updateEndpointRegistry` is synchronous, so a
      // thread-yielding wait cannot run (no event loop turn, and `Atomics.wait` on the main thread
      // throws). The holder needs real wall time to finish its write.
      sleepSync(10);
      continue;
    }
    closeSync(fd);
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

function writeState(path: string, state: EndpointRegistryState): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function applyPatch(state: EndpointRegistryState, patch: EndpointPatch, now: string): EndpointRegistryState {
  if (patch.expectedRevision !== state.revision) throw new EndpointConflictError(patch.expectedRevision, state.revision);
  let endpoints = [...state.endpoints];
  if (patch.add) {
    if (endpoints.some((endpoint) => endpoint.id === patch.add!.id)) throw new Error(`endpoint already exists: ${patch.add.id}`);
    endpoints.push({ ...patch.add, baseUrl: normalizeEndpointUrl(patch.add.baseUrl), updatedAt: now });
  }
  if (patch.update) {
    const index = endpoints.findIndex((endpoint) => endpoint.id === patch.update!.id);
    if (index < 0) throw new Error(`endpoint not found: ${patch.update.id}`);
    const current = endpoints[index];
    endpoints[index] = {
      ...current,
      ...patch.update,
      id: current.id,
      baseUrl: normalizeEndpointUrl(patch.update.baseUrl ?? current.baseUrl),
      updatedAt: now,
    };
  }
  if (patch.removeId) {
    endpoints = endpoints.filter((endpoint) => endpoint.id !== patch.removeId);
  }
  return { ...state, revision: state.revision + 1, endpoints, updatedAt: now };
}

/** Apply one narrow update against the latest on-disk revision. Conflicts fail closed. */
export function updateEndpointRegistry(patch: EndpointPatch, path: string | undefined = undefined, now = new Date().toISOString()): EndpointRegistryState {
  if (!path) {
    // Exclusive across processes: read the CURRENT revision, apply, and write while holding the
    // lock. Checking the revision outside the lock would let two writers agree on revision N and
    // lose one endpoint on the second rename.
    return withGlobalLock(() => {
      const current = loadEndpointRegistry();
      const next = applyPatch(current, patch, now);
      saveGlobalConfig({ endpoints: next });
      return next;
    });
  }
  acquireLock(path);
  try {
    const current = loadEndpointRegistry(path);
    const next = applyPatch(current, patch, now);
    writeState(path, next);
    return next;
  } finally {
    releaseLock(path);
  }
}

export function createEndpointId(): string {
  return `ep_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`;
}

export function savedEndpointFromModelEntry(entry: { label: string; provider: SavedEndpoint['provider']; model: string; baseUrl?: string; credRef?: string }): SavedEndpoint {
  const now = new Date().toISOString();
  if (!entry.baseUrl) throw new Error('a saved endpoint requires a base URL');
  return {
    id: createEndpointId(),
    label: entry.label,
    provider: entry.provider,
    model: entry.model,
    baseUrl: normalizeEndpointUrl(entry.baseUrl),
    credentialRef: entry.credRef,
    createdAt: now,
    updatedAt: now,
  };
}
