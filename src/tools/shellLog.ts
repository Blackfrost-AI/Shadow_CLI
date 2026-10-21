// File-backed stdio for run_shell.
//
// WHY THIS EXISTS — the bug this module fixes:
//
// Background shells were already spawned `detached: true`, which only makes the child its own
// process-group leader. That protects it from a process-GROUP kill (`kill -9 -PID`), but it does
// NOT protect it from the stdio pipe. With `stdio: ['ignore','pipe','pipe']` the child writes into
// a pipe whose READ end is this Node process. When Shadow dies — a torn-down SSH session, a
// closed terminal, an abrupt exit — the read end closes, and the child's very next progress write
// raises SIGPIPE and terminates it. No `nohup`, `setsid`, or `disown` helps, because the killer is
// the file descriptor, not the process group.
//
// That is exactly the observed failure: an `hf download` stopped dead at 35/84 with the log
// ending mid-progress and no traceback, and no process left behind. Measured behaviour
// (macOS/arm64, reproduced before this fix):
//
//   pipe stdio, parent SIGKILLed   -> child DEAD within 0.5s, SIGPIPE trapped repeatedly
//   file stdio, parent SIGKILLed   -> child ALIVE and still appending 30s later
//
// So the child gets REAL FILE DESCRIPTORS instead of pipes. Nothing it writes can fail because
// Shadow went away. In-session streaming is preserved by tailing the log file in-process, which
// costs one small interval timer per live shell and gives streaming AND durability.
//
// Logs live under `<workspace>/.shadow/shell-logs/` so a user can read them after Shadow exits —
// deliberately NOT deleted on completion, since surviving the session is the entire point.

import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Directory for shell logs, relative to the workspace root. */
export const SHELL_LOG_DIR = join('.shadow', 'shell-logs');

export interface ShellLog {
  outPath: string;
  errPath: string;
  /** fds handed straight to spawn()'s stdio — the child owns these, we never write. */
  outFd: number;
  errFd: number;
}

/**
 * Create (or append to) the stdout/stderr files for one shell command and return their fds.
 * Files are created eagerly so the child can never race ahead of an existing path.
 */
export function createShellLog(workspaceRoot: string, id: string): ShellLog {
  const dir = join(workspaceRoot, SHELL_LOG_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `a` (append) so a promoted shell keeps one continuous log across the hand-off.
  const outPath = join(dir, `${id}.out.log`);
  const errPath = join(dir, `${id}.err.log`);
  return {
    outPath,
    errPath,
    outFd: openSync(outPath, 'a'),
    errFd: openSync(errPath, 'a'),
  };
}

/**
 * Incrementally read a growing log file and emit new text.
 *
 * Deliberately a polling reader rather than fs.watch: watch semantics differ across platforms
 * (and miss appends on some network filesystems), while a positional read is portable, cannot
 * miss data, and drains deterministically during the child's 'close' transition. The default
 * interval keeps typing latency imperceptible while costing almost nothing on an idle shell.
 */
export class FileTail {
  private offset: number;
  private timer?: ReturnType<typeof setInterval>;
  private fd: number | null = null;
  private readonly decoder = new StringDecoder('utf8');
  private stopped = false;

  constructor(
    private readonly path: string,
    private readonly onData: (chunk: string) => void,
    opts: { startOffset?: number; intervalMs?: number } = {},
  ) {
    this.offset = opts.startOffset ?? 0;
    this.intervalMs = opts.intervalMs ?? 100;
  }

  private readonly intervalMs: number;

  start(): void {
    if (this.timer) return;
    try {
      this.fd = openSync(this.path, 'r');
    } catch {
      this.fd = null; // file evicted; nothing to stream
      return;
    }
    this.timer = setInterval(() => this.drain(), this.intervalMs);
    // Must not hold the event loop open: an idle session should still be able to exit.
    this.timer.unref?.();
  }

  /** Read everything appended since the last drain. Returns the number of bytes emitted. */
  drain(): number {
    if (this.fd === null || this.stopped) return 0;
    let size: number;
    try {
      size = fstatSync(this.fd).size;
    } catch {
      return 0;
    }
    let emitted = 0;
    // Loop so a large burst (a dump, a build log) is fully drained in one tick, capped per read
    // so one enormous append cannot allocate an unbounded buffer.
    while (size > this.offset) {
      const len = Math.min(size - this.offset, 1 << 20);
      const buf = Buffer.allocUnsafe(len);
      let n: number;
      try {
        n = readSync(this.fd, buf, 0, len, this.offset);
      } catch {
        break;
      }
      if (n <= 0) break;
      this.offset += n;
      emitted += n;
      const text = this.decoder.write(buf.subarray(0, n));
      if (text) this.onData(text);
    }
    return emitted;
  }

  /** Byte offset already consumed — used to hand a live shell to the registry without a gap. */
  get consumed(): number {
    return this.offset;
  }

  /**
   * Stop tailing. `flush` defaults to true so the final bytes a child wrote are never lost when
   * it exits; pass false when another owner is taking over at this exact offset.
   */
  stop(flush = true): void {
    if (this.stopped) return;
    if (flush) this.drain();
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
  }
}
