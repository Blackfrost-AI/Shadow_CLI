import { SessionLog } from './session.js';
import { hydrateContext, type ContextSnapshotData, type HydrateOptions } from './snapshot.js';
import type { Context } from '../agent/context.js';
import {
  coerceSessionState,
  legacySessionStateFromBytes,
  type SessionStateSnapshot,
} from './sessionState.js';
import {
  assertLegacySessionBindingDigest,
  assertSessionHarnessBinding,
  readSessionHarnessBinding,
  readStableSessionFile,
  recordLegacySessionBindingDigest,
  type SessionHarnessBindingOptions,
} from './sessionHarnessBinding.js';

export interface ResumableSession {
  path: string;
  id: string;
  ts: string;
  title: string;
}

export interface ResumeMeta {
  sessionId: string;
  sessionPath: string;
  title: string;
  snapshotTs?: string;
  turn?: number;
  subAgentTasks?: any[];
}

function sessionTsFromPath(path: string): string {
  const id = SessionLog.sessionIdFromPath(path);
  // Filenames use ISO stamps with ':' → '-' (e.g. 2025-01-01T12-00-00.000Z).
  return id.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3').replace(/-(\d{3})Z$/, '.$1Z');
}

/** Sessions that contain at least one `context_snapshot` record, newest first. */
export function listResumableSessions(workspaceRoot: string): ResumableSession[] {
  const out: ResumableSession[] = [];
  for (const path of SessionLog.list(workspaceRoot)) {
    // Manifest-backed: one tail scan per file (cached, mtime-invalidated), and no snapshot
    // PAYLOAD is read — just existence + ts. Previously this parsed every log TWICE per file.
    const info = SessionLog.snapshotInfo(path);
    if (!info.hasSnapshot) continue;
    out.push({
      path,
      id: SessionLog.sessionIdFromPath(path),
      ts: info.ts ?? sessionTsFromPath(path),
      title: SessionLog.titleFor(path) || 'Untitled session',
    });
  }
  return out;
}

export interface ResumeSessionOpts extends HydrateOptions, SessionHarnessBindingOptions {}

function persistedSessionState(
  path: string,
  value: unknown,
  options: SessionHarnessBindingOptions = {},
  legacyFile?: { bytes: Buffer; digest: string },
): SessionStateSnapshot {
  let binding: ReturnType<typeof readSessionHarnessBinding>;
  try {
    binding = readSessionHarnessBinding(path, options);
  } catch (error) {
    throw new Error(
      `Cannot resume session ${SessionLog.sessionIdFromPath(path)}: ${(error as Error).message}.`,
    );
  }
  const rawVersion = value && typeof value === 'object'
    ? (value as { version?: unknown }).version
    : undefined;

  if (rawVersion === 2) {
    const state = coerceSessionState(value);
    if (!state?.harness) {
      throw new Error(
        `Cannot resume session ${SessionLog.sessionIdFromPath(path)}: ` +
          'its current-format harness metadata is missing or malformed.',
      );
    }
    try {
      assertSessionHarnessBinding(path, state.harness, options);
    } catch (error) {
      throw new Error(
        `Cannot resume session ${SessionLog.sessionIdFromPath(path)}: ${(error as Error).message}.`,
      );
    }
    return state;
  }

  if (rawVersion !== undefined && rawVersion !== 1) {
    throw new Error(
      `Cannot resume session ${SessionLog.sessionIdFromPath(path)}: ` +
        'its session-state schema is unsupported or malformed.',
    );
  }

  // Absence cannot prove age: the workspace can copy/rename a bound v2 log to a fresh path and
  // strip its metadata. A genuine pre-harness log therefore needs an explicit, owner-only legacy
  // receipt bound to both this absolute path and these exact JSONL bytes.
  if (!binding) {
    const id = SessionLog.sessionIdFromPath(path);
    throw new Error(
      `Cannot resume session ${id}: this unbound log cannot be authenticated as pre-harness. ` +
        'After verifying it, migrate this one exact file with ' +
        '`shadow resume --session <path-to-verified-log> --trust-legacy`.',
    );
  }
  if (binding.kind !== 'legacy') {
    throw new Error(
      `Cannot resume session ${SessionLog.sessionIdFromPath(path)}: ` +
        'an owner-only harness binding exists, but the workspace snapshot lost its current-format harness metadata.',
    );
  }
  if (!legacyFile) {
    throw new Error(
      `Cannot resume session ${SessionLog.sessionIdFromPath(path)}: ` +
        'its legacy snapshot was not read from an authenticated stable file view.',
    );
  }
  try {
    assertLegacySessionBindingDigest(path, legacyFile.digest, options);
  } catch (error) {
    throw new Error(
      `Cannot resume session ${SessionLog.sessionIdFromPath(path)}: ${(error as Error).message}.`,
    );
  }
  return coerceSessionState(value) ?? legacySessionStateFromBytes(legacyFile.bytes);
}

/**
 * Authenticate the record that callers will actually hydrate. Current v2 records carry their
 * harness identity in that already-read object. Legacy records are reparsed from one stable fd
 * buffer whose digest is checked against the owner-side receipt, closing path-swap races.
 */
function authenticatedSnapshot(
  path: string,
  options: SessionHarnessBindingOptions = {},
): { record: Record<string, unknown>; data: ContextSnapshotData; state: SessionStateSnapshot } | undefined {
  let binding: ReturnType<typeof readSessionHarnessBinding>;
  try {
    binding = readSessionHarnessBinding(path, options);
  } catch (error) {
    throw new Error(
      `Cannot resume session ${SessionLog.sessionIdFromPath(path)}: ${(error as Error).message}.`,
    );
  }
  if (!binding) {
    throw new Error(
      `Cannot resume session ${SessionLog.sessionIdFromPath(path)}: ` +
        'the owner-only session harness binding is missing. This unbound log cannot be authenticated as pre-harness. ' +
        'If it is a verified pre-harness session, migrate this one exact file with ' +
        '`shadow resume --session <path-to-verified-log> --trust-legacy`.',
    );
  }
  const legacyFile = binding.kind === 'legacy' ? readStableSessionFile(path) : undefined;
  const record = legacyFile
    ? SessionLog.findLatestSnapshotRecordFromBytes(legacyFile.bytes)
    : SessionLog.findLatestSnapshotRecord(path);
  if (!record) return undefined;
  const data = record.data as ContextSnapshotData | undefined;
  if (!data) return undefined;
  return {
    record,
    data,
    state: persistedSessionState(path, data.sessionState, options, legacyFile),
  };
}

/**
 * Explicit one-file migration for sessions created before harness receipts existed. This never
 * converts or blesses a v2 record; it only writes the owner-side content receipt that a later
 * resume requires.
 */
export function trustLegacySession(
  path: string,
  options: SessionHarnessBindingOptions = {},
): void {
  const stable = readStableSessionFile(path);
  const record = SessionLog.findLatestSnapshotRecordFromBytes(stable.bytes);
  const data = record?.data as ContextSnapshotData | undefined;
  if (!data) throw new Error(`No context snapshot in session: ${path}`);
  // A copied v2 lineage with a legacy-looking tail is still known-current. Explicit migration is
  // for genuinely pre-harness files, not a route around a missing/mismatched current binding.
  if (SessionLog.hasSnapshotStateVersionFromBytes(stable.bytes, 2)) {
    throw new Error('refusing legacy migration because this log contains a current-format v2 snapshot');
  }
  const value = data.sessionState;
  const rawVersion = value && typeof value === 'object'
    ? (value as { version?: unknown }).version
    : undefined;
  if (rawVersion === 2) {
    throw new Error('refusing legacy migration for a current-format v2 session');
  }
  if (rawVersion !== undefined && rawVersion !== 1) {
    throw new Error('refusing legacy migration for an unsupported or malformed session-state schema');
  }
  const existing = readSessionHarnessBinding(path, options);
  if (existing?.kind === 'harness') {
    throw new Error('refusing legacy migration because this path already has a current-format harness binding');
  }
  recordLegacySessionBindingDigest(path, stable.digest, options);
}

export function readSessionState(
  path: string,
  options: SessionHarnessBindingOptions = {},
): SessionStateSnapshot {
  const authenticated = authenticatedSnapshot(path, options);
  if (!authenticated) throw new Error(`No context snapshot in session: ${path}`);
  return authenticated.state;
}

/** Exact identity wins; duplicate titles remain ambiguous and must be presented to the user. */
export function resolveSessionMatches(sessions: ResumableSession[], query: string): ResumableSession[] {
  const value = query.trim();
  if (!value) return sessions;
  const identity = sessions.filter((session) => session.id === value || session.path === value);
  if (identity.length) return identity;
  const title = sessions.filter((session) => session.title.toLocaleLowerCase() === value.toLocaleLowerCase());
  if (title.length) return title;
  return sessions.filter((session) => session.id.startsWith(value) || session.path.endsWith(value)
    || session.title.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
}

/** Hydrate context from the latest snapshot in a session log. */
export function resumeSession(
  sessionPath: string,
  opts: ResumeSessionOpts,
): { context: Context; meta: ResumeMeta; state: SessionStateSnapshot } {
  // One read of the latest snapshot record — data + metadata together.
  const { bindingsDir, ...hydrateOptions } = opts;
  const authenticated = authenticatedSnapshot(sessionPath, { bindingsDir });
  if (!authenticated) throw new Error(`No context snapshot in session: ${sessionPath}`);
  const { record, data, state } = authenticated;
  // Authenticate the harness/legacy boundary before hydrating any workspace-controlled context.
  const context = hydrateContext(data, hydrateOptions);
  return {
    context,
    state,
    meta: {
      sessionId: SessionLog.sessionIdFromPath(sessionPath),
      sessionPath,
      title: SessionLog.titleFor(sessionPath),
      snapshotTs: record?.ts as string | undefined,
      turn: typeof record?.turn === 'number' ? record.turn : undefined,
      subAgentTasks: (data as any).subAgentTasks,
    },
  };
}
