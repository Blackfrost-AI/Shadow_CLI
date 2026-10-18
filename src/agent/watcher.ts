/**
 * Background watchers — work that outlives the session that started it.
 *
 * The defect this module exists to fix: before it, every form of recurring/long-lived work in
 * Shadow was scoped to the live process. `schedule_wakeup` arms a `setTimeout` inside the running
 * app; `run_shell` children die with their turn; the event bus is in-memory. So an agent that said
 * "I'll watch CI and report back" was making a promise it structurally could not keep — closing
 * the terminal ended the watch, and nothing recorded that it had ever existed.
 *
 * A watcher here is deliberately NOT a timer in the agent process. It is a detached child running
 * `sh -c 'while :; do <command>; sleep <interval>; done'` with stdout/stderr redirected to a log
 * file, and its identity persisted to `.shadow/watchers.json`. Consequences that matter:
 *
 * - It survives the session, the TUI, and the parent shell. Detached + `unref()` means Shadow can
 *   exit and the watcher keeps ticking.
 * - It is inspectable across processes. `list()` re-reads the durable record and probes each PID,
 *   so a fresh launch reports what is genuinely still running rather than what this process
 *   remembers spawning.
 * - A dead watcher is visible as dead. A PID that no longer answers `kill(pid, 0)` is reported
 *   `stopped` instead of silently vanishing.
 *
 * Everything is time- and process-injected so the state machine is testable without spawning.
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveWithin } from '../safety/workspaceJail.js';
import { redactString } from '../util/redact.js';

/** Where watcher state lives, relative to the workspace root. */
export const WATCHER_STATE_REL = '.shadow/watchers.json';
export const WATCHER_LOG_DIR_REL = '.shadow/watchers';

/** A watcher interval below this is a fork bomb with extra steps. */
export const MIN_INTERVAL_SEC = 10;
/** The log is tailed for display, never read whole — a chatty watcher can write megabytes. */
export const LOG_TAIL_BYTES = 4096;
/** Bound the registry so a runaway model loop cannot fork hundreds of detached processes. */
export const MAX_WATCHERS = 8;
/** A reaped watcher's log is trimmed once it exceeds this; the tail is what anyone reads. */
export const REAP_LOG_MAX_BYTES = 64 * 1024;
export const REAP_LOG_KEEP_BYTES = 16 * 1024;

export type WatcherStatus = 'running' | 'stopped' | 'failed';

export interface WatcherRecord {
  /** Stable, unique, model-chosen handle ('ci', 'deploy-logs'). */
  name: string;
  /** The shell command run each tick. Untrusted: it is what the model asked to run. */
  command: string;
  intervalSec: number;
  cwd: string;
  /** PID of the detached loop, or null when it was never started / already reaped. */
  pid: number | null;
  startedAt: number;
  /** Absolute path of this watcher's log file. */
  logPath: string;
  status: WatcherStatus;
}

export interface WatcherState {
  version: 1;
  watchers: WatcherRecord[];
}

/** Injected process seams — tests drive liveness and spawning without real processes. */
export interface WatcherRuntime {
  now?: () => number;
  /** Returns true when `pid` is a live process. Defaults to `process.kill(pid, 0)`. */
  alive?: (pid: number) => boolean;
  /** Start the detached loop. Returns the PID, or null when the spawn failed. */
  spawn?: (record: WatcherRecord) => number | null;
  /** Terminate a watcher's process group. Returns true when a signal was delivered. */
  kill?: (pid: number) => boolean;
  /**
   * Does `pid` still belong to THIS watcher (i.e. did we record it)? Guards every reap and kill
   * against PID recycling: PIDs are reused, so a stale record's number can name an unrelated
   * live process. Defaults to defaultVerify. A verifier that returns false makes the watcher
   * count as dead — the safe direction, since this gates a SIGTERM.
   */
  verify?: (record: WatcherRecord) => boolean;
}

export class WatcherError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'WatcherError';
  }
}

/** POSIX-sh validation: the name becomes a filename and a display key, never shell text. */
export function assertWatcherName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(trimmed)) {
    throw new WatcherError(
      'Watcher name must be 1-48 characters of letters, digits, dot, underscore or dash, starting with a letter or digit.',
      'bad_name',
    );
  }
  return trimmed;
}

/**
 * The detached loop body. `exec` replaces the shell so the recorded PID is the command itself
 * rather than a wrapper that outlives nothing, and the trailing `sleep` bounds the cadence.
 */
export function watcherScript(command: string, intervalSec: number): string {
  // The command is the model's own request; it is passed as a single -c argument, so shell
  // metacharacters inside it are intentional rather than an injection into OUR script.
  return `while :; do ${command}; sleep ${intervalSec}; done`;
}

/** Resolve and validate the state path inside the workspace jail. */
function statePath(workspaceRoot: string): string {
  return resolveWithin(workspaceRoot, WATCHER_STATE_REL);
}

/**
 * Durable watcher registry. Every mutation rewrites the state file atomically, so a crash mid-run
 * leaves either the previous list or the new one, never a truncated file.
 */
export class WatcherRegistry {
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly spawnImpl: (record: WatcherRecord) => number | null;
  private readonly killImpl: (pid: number) => boolean;
  private readonly verify: (record: WatcherRecord) => boolean;

  constructor(
    private readonly workspaceRoot: string,
    runtime: WatcherRuntime = {},
  ) {
    this.now = runtime.now ?? Date.now;
    this.alive = runtime.alive ?? defaultAlive;
    this.spawnImpl = runtime.spawn ?? ((record) => defaultSpawn(record));
    this.killImpl = runtime.kill ?? defaultKill;
    // Liveness and identity are one decision, so they move together: a caller supplying `alive`
    // owns "is this process ours?" semantics outright, and a real inspection of a fake PID would
    // only contradict it. Callers that supply neither get the real probe behind the real check.
    this.verify = runtime.verify ?? (runtime.alive ? () => true : (record) => defaultVerify(record));
  }

  /**
   * Is this record's PID still ours AND still running?
   *
   * Both halves matter. `alive` alone is a PID-recycling bug: when a watcher dies and the OS
   * reissues its number, `kill(pid, 0)` succeeds for a completely unrelated process. Left
   * unchecked that is merely a lying status chip, but `cancel`/`remove` would then SIGTERM a
   * stranger's process group. `verify` compares the live process's identity against what we
   * recorded, so a recycled number reads as dead and is never signalled.
   */
  private isLive(record: WatcherRecord): boolean {
    if (record.pid === null) return false;
    return this.alive(record.pid) && this.verify(record);
  }

  /** Current watchers, with liveness re-probed. A dead PID is reported, never silently dropped. */
  list(): WatcherRecord[] {
    const state = this.read();
    let changed = false;
    for (const w of state.watchers) {
      if (w.status === 'running' && w.pid !== null && !this.isLive(w)) {
        w.status = 'stopped';
        changed = true;
      }
    }
    if (changed) this.write(state);
    return state.watchers;
  }

  get(name: string): WatcherRecord | undefined {
    return this.list().find((w) => w.name === name);
  }

  /** Start a watcher. Idempotent per name: re-starting a live watcher is refused, not duplicated. */
  start(input: { name: string; command: string; intervalSec: number; cwd?: string }): WatcherRecord {
    const name = assertWatcherName(input.name);
    const command = input.command.trim();
    if (!command) throw new WatcherError('Watcher command must not be empty.', 'bad_command');
    if (!Number.isFinite(input.intervalSec) || input.intervalSec < 1) {
      throw new WatcherError('interval_seconds must be a positive number.', 'bad_interval');
    }
    const intervalSec = Math.max(MIN_INTERVAL_SEC, Math.round(input.intervalSec));

    const state = this.read();
    const existing = state.watchers.find((w) => w.name === name);
    if (existing && existing.status === 'running' && this.isLive(existing)) {
      throw new WatcherError(
        `Watcher '${name}' is already running (pid ${existing.pid}). Cancel it first to change it.`,
        'already_running',
      );
    }
    if (state.watchers.filter((w) => w.status === 'running').length >= MAX_WATCHERS) {
      throw new WatcherError(
        `At most ${MAX_WATCHERS} watchers may run at once. Cancel one before starting another.`,
        'too_many',
      );
    }

    const logPath = resolveWithin(this.workspaceRoot, join(WATCHER_LOG_DIR_REL, `${name}.log`));
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });

    const record: WatcherRecord = {
      name,
      command: redactString(command),
      intervalSec,
      cwd: input.cwd ?? this.workspaceRoot,
      pid: null,
      startedAt: this.now(),
      logPath,
      status: 'failed',
    };

    const pid = this.spawnImpl(record);
    if (pid === null) {
      // Keep the record: a watcher that failed to start is information the user needs, and it
      // must not look like it was never asked for.
      record.status = 'failed';
    } else {
      record.pid = pid;
      record.status = 'running';
    }

    const next: WatcherState = {
      version: 1,
      watchers: [...state.watchers.filter((w) => w.name !== name), record],
    };
    this.write(next);
    return record;
  }

  /** Stop a watcher and mark it stopped. Succeeds even when the process already died. */
  cancel(name: string): WatcherRecord {
    const state = this.read();
    const record = state.watchers.find((w) => w.name === name);
    if (!record) throw new WatcherError(`No watcher named '${name}'.`, 'not_found');

    const wasAlive = this.isLive(record);
    if (wasAlive && record.pid !== null) this.killImpl(record.pid);
    record.status = wasAlive ? 'stopped' : record.status === 'running' ? 'stopped' : record.status;
    record.pid = null;
    this.write(state);
    return record;
  }

  /**
   * Reap orphaned watchers. Call once per session start.
   *
   * The gap this closes: a detached loop outlives the session by design, but nothing guaranteed
   * it was ever *stopped*. If Shadow exited without cancelling — SIGKILL, a closed terminal, a
   * crash — the process kept ticking and kept writing to its log forever, and the record stayed
   * `running` as long as the PID answered. `MAX_WATCHERS` bounded how many could exist, so this
   * was a slow leak rather than an explosion, but "leaks slowly" is not a lifecycle.
   *
   * Three outcomes per record, and they are deliberately different:
   *
   *  - **Still alive and ours** → left running. A watcher that survived the session is exactly
   *    what the feature is for, and reaping it would break the core promise.
   *  - **Dead** → marked `stopped` and its PID cleared. The record is KEPT: it is evidence the
   *    watch existed and how far its log got, which is what the user needs to decide whether to
   *    restart it. Deleting the record would erase that.
   *  - **Never started, or a dead PID that now names a stranger** → marked `failed`/`stopped`
   *    and its PID cleared WITHOUT signalling. The PID is the hazard here: we must not SIGTERM a
   *    number that no longer means what we recorded.
   *
   * Only logs of records we just confirmed dead are trimmed, so a live watcher's output is never
   * touched. Returns the records whose status changed, for the caller to surface.
   */
  reap(): WatcherRecord[] {
    const state = this.read();
    const changed: WatcherRecord[] = [];
    for (const w of state.watchers) {
      if (w.status !== 'running') continue;
      if (this.isLive(w)) continue;
      // Dead. Do NOT signal: either the PID is gone, or it was recycled onto a stranger.
      w.status = w.pid === null ? 'failed' : 'stopped';
      w.pid = null;
      changed.push(w);
      this.trimLog(w);
    }
    if (changed.length) this.write(state);
    return changed;
  }

  /** Cap a dead watcher's log so a long-lived loop cannot leave an unbounded file behind. */
  private trimLog(record: WatcherRecord): void {
    try {
      if (!existsSync(record.logPath)) return;
      const buf = readFileSync(record.logPath);
      if (buf.length <= REAP_LOG_MAX_BYTES) return;
      // Keep the TAIL — the most recent output is the part worth reading — and say so, so the
      // truncation cannot be mistaken for the watcher having started late.
      const kept = buf.subarray(buf.length - REAP_LOG_KEEP_BYTES).toString('utf8');
      writeFileSync(record.logPath, `[reaped: older output trimmed]\n${kept}`, { mode: 0o600 });
    } catch {
      /* a log we cannot trim is not a reason to fail the reap */
    }
  }

  /** Remove a watcher entirely, cancelling it first. */
  remove(name: string): boolean {
    const state = this.read();
    const record = state.watchers.find((w) => w.name === name);
    if (!record) return false;
    if (record.pid !== null && this.isLive(record)) this.killImpl(record.pid);
    this.write({ version: 1, watchers: state.watchers.filter((w) => w.name !== name) });
    try {
      if (existsSync(record.logPath)) unlinkSync(record.logPath);
    } catch {
      /* a log we cannot remove is not a reason to fail the cancel */
    }
    return true;
  }

  /** Tail of a watcher's output, clamped. Used by the overlay; never the whole file. */  logTail(name: string, bytes = LOG_TAIL_BYTES): string {
    const record = this.get(name);
    if (!record) throw new WatcherError(`No watcher named '${name}'.`, 'not_found');
    if (!existsSync(record.logPath)) return '';
    try {
      const buf = readFileSync(record.logPath);
      const slice = buf.subarray(Math.max(0, buf.length - Math.max(1, bytes)));
      return redactString(slice.toString('utf8'));
    } catch {
      return '';
    }
  }

  private read(): WatcherState {
    const path = statePath(this.workspaceRoot);
    if (!existsSync(path)) return { version: 1, watchers: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WatcherState>;
      if (!parsed || !Array.isArray(parsed.watchers)) return { version: 1, watchers: [] };
      return { version: 1, watchers: parsed.watchers.filter(isRecord) };
    } catch {
      // A corrupt file must not make the feature permanently unusable.
      return { version: 1, watchers: [] };
    }
  }

  private write(state: WatcherState): void {
    const path = statePath(this.workspaceRoot);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }
}

function isRecord(value: unknown): value is WatcherRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<WatcherRecord>;
  return (
    typeof r.name === 'string' &&
    typeof r.command === 'string' &&
    typeof r.intervalSec === 'number' &&
    typeof r.cwd === 'string' &&
    typeof r.logPath === 'string' &&
    typeof r.startedAt === 'number' &&
    (r.pid === null || typeof r.pid === 'number') &&
    (r.status === 'running' || r.status === 'stopped' || r.status === 'failed')
  );
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive for our purposes.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Does `pid` still look like the watcher we recorded, and not a recycled number?
 *
 * `kill(pid, 0)` only answers "some process has this number". Between a watcher dying and the
 * next `cancel()` the OS may hand that number to anything at all, including a process whose
 * group we would then SIGTERM. So compare the live process's identity against the shape every
 * watcher is spawned with:
 *
 *   - argv is `/bin/sh -c 'while :; do …; sleep N; done'` (we read `/proc/<pid>/cmdline` on
 *     Linux, `ps` elsewhere), and
 *   - it leads its own process group (we spawn detached, so pgid == pid).
 *
 * A process that satisfies both is overwhelmingly likely to be ours; a recycled PID that happens
 * to be a detached sh polling loop with our exact interval is not a scenario worth engineering
 * against. Crucially this errs toward FALSE (treat as dead, never signal) when it cannot inspect
 * the process at all — the safe direction for a function guarding a SIGTERM.
 *
 * Note this is deliberately NOT used by list(): that runs on every render and must stay a single
 * syscall per record. A recycled PID can therefore show a stale "running" chip momentarily, but
 * it can never be signalled, and reap() corrects the record at session start.
 */
function defaultVerify(record: WatcherRecord): boolean {
  const pid = record.pid;
  if (pid === null) return false;
  const intervalSec = record.intervalSec;
  if (process.platform === 'win32') return true; // no comparable inspection; liveness only

  let argv: string | null = null;
  let pgid: number | null = null;

  try {
    // Linux: cheapest and exact — no process spawn.
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    argv = raw.split('\u0000').filter(Boolean).join(' ');
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 5 (1-based) is pgrp; the comm field can contain spaces so measure from the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    pgid = Number(fields[2]);
  } catch {
    // Not Linux, or the process vanished mid-probe: fall back to ps.
    try {
      const out = spawnSync('/bin/ps', ['-o', 'pgid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 2000,
      });
      if (out.status !== 0 || !out.stdout) return false;
      const line = out.stdout.trim().split('\n')[0] ?? '';
      const sp = line.search(/\s/);
      if (sp < 0) return false;
      pgid = Number(line.slice(0, sp));
      argv = line.slice(sp + 1).trim();
    } catch {
      return false;
    }
  }

  if (!argv) return false;
  if (pgid !== null && Number.isFinite(pgid) && pgid !== pid) return false;
  // Our loop: sh -c 'while :; do <command>; sleep <interval>; done'
  return /(?:^|\/)sh\b/.test(argv) && /while :; do .*; sleep \d+; done/.test(argv)
    ? argv.includes(`sleep ${intervalSec};`)
    : false;
}

/**
 * Spawn the detached loop. `detached: true` puts the child in its own process group so it is not
 * signalled when the terminal's foreground group is interrupted; `unref()` drops it from our event
 * loop so Shadow can exit while it keeps running. Output goes to the log file, never our stdio.
 */
function defaultSpawn(record: WatcherRecord): number | null {
  const fd = openSync(record.logPath, 'a', 0o600);
  try {
    const child = spawn('/bin/sh', ['-c', watcherScript(record.command, record.intervalSec)], {
      cwd: record.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, SHADOW_WATCHER: record.name },
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Signal the whole process group, so the `sh -c` loop and its child both stop. */
function defaultKill(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}
