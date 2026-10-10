/** Shadow-owned OAuth files; SQLite supplies process/crash-safe refresh exclusion. */
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class ChatGPTAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ChatGPTAuthError';
  }
}
export function cancelled(): ChatGPTAuthError {
  return new ChatGPTAuthError(
    'cancelled',
    'ChatGPT sign-in or credential operation was cancelled.',
  );
}
export function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

export function secureDirectory(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error();
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
  } catch {
    throw new ChatGPTAuthError(
      'storage_unavailable',
      'Shadow could not open its protected ChatGPT account directory.',
    );
  }
}
function checkFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error();
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}
export function readAuthFile(path: string): unknown | undefined {
  try {
    if (!existsSync(path)) return undefined;
    checkFile(path);
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new ChatGPTAuthError(
      'storage_corrupt',
      'A saved ChatGPT account record is unreadable; it was left unchanged.',
    );
  }
}
export async function writeAuthFile(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    if (existsSync(path)) checkFile(path);
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Windows may briefly deny replacement while another process reads a record.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, path);
        break;
      } catch (error) {
        if (
          process.platform !== 'win32' ||
          attempt >= 20 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
        await delay(25);
      }
    }
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } catch {
    throw new ChatGPTAuthError(
      'storage_unavailable',
      'Shadow could not save protected ChatGPT credentials.',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* The atomic rename normally consumed it. */
    }
  }
}

function busy(error: unknown): boolean {
  const e = error as { errcode?: number; code?: string; errstr?: string; message?: string };
  const detail = `${e.errstr ?? ''} ${e.message ?? ''}`.toLowerCase();
  return (
    e.errcode === 5 ||
    e.errcode === 6 ||
    e.code === 'SQLITE_BUSY' ||
    e.code === 'SQLITE_LOCKED' ||
    detail.includes('database is locked') ||
    detail.includes('database table is locked')
  );
}
// Keep the native wrapper reachable for the full critical section. A suspended callback's
// promise may otherwise become unreachable while another active handle keeps the process alive,
// allowing DatabaseSync finalization to release the transaction before the callback settles.
const heldLockConnections = new Set<DatabaseSync>();

/** A held BEGIN IMMEDIATE is released by the OS even when its owner process dies.
 * Zero SQLite busy_timeout plus asynchronous retries avoids blocking this process's
 * current lock owner while it awaits a token response. No stale lease can steal it. */
export async function withChatGPTLock<T>(
  dir: string,
  name: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  requireActive(signal);
  secureDirectory(dir);
  if (!/^[a-zA-Z0-9_-]+$/.test(name))
    throw new ChatGPTAuthError('invalid_profile', 'Invalid ChatGPT account selection.');
  const path = join(dir, `${name}.lock.sqlite`);
  let db: DatabaseSync | undefined;
  let held = false;
  try {
    try {
      try {
        const fd = openSync(path, 'wx', 0o600);
        closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      checkFile(path);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        requireActive(signal);
        try {
          // A second process can observe SQLITE_BUSY while opening a brand-new SQLite file or
          // applying the PRAGMA, before BEGIN IMMEDIATE runs. Keep the entire SQLite acquisition
          // inside the same bounded retry so contention is never misreported as corrupt storage.
          db = new DatabaseSync(path);
          db.exec('PRAGMA busy_timeout=0');
          db.exec('BEGIN IMMEDIATE');
          held = true;
          heldLockConnections.add(db);
          break;
        } catch (error) {
          try {
            db?.close();
          } catch {
            /* retry with a fresh connection */
          }
          db = undefined;
          if (!busy(error)) throw error;
          if (Date.now() >= deadline)
            throw new ChatGPTAuthError(
              'account_busy',
              'Another Shadow process is using this ChatGPT account. Try again after it finishes.',
            );
          try {
            await delay(25, undefined, { signal });
          } catch {
            throw cancelled();
          }
        }
      }
    } catch (error) {
      if (error instanceof ChatGPTAuthError) throw error;
      throw new ChatGPTAuthError(
        'storage_unavailable',
        'Shadow could not lock its protected ChatGPT account storage.',
      );
    }
    return await run();
  } finally {
    if (held) {
      try {
        db?.exec('ROLLBACK');
      } catch {
        /* close also releases the transaction */
      }
    }
    if (db) heldLockConnections.delete(db);
    db?.close();
  }
}
