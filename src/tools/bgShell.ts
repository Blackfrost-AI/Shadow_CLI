import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { FileTail } from './shellLog.js';
import type { WorkCenter } from '../app/workCenter.js';

const MAX_CAPTURE = 8 * 1024 * 1024;
const IS_WIN = process.platform === 'win32';

/** A shell started with run_shell `run_in_background: true`. */
export interface BgProc {
  id: string;
  command: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  readStdout: number; // bytes already returned by bash_output
  readStderr: number;
  exitCode: number | null;
  signal: string | null;
  running: boolean;
  startedAt: number;
  /** Log files backing this shell's stdio; absent when a caller registers a bare child. */
  logPaths?: { stdout: string; stderr: string };
}

/**
 * Registry of background shells. run_shell registers a detached child here and
 * returns immediately; `bash_output` drains buffered output incrementally and
 * `kill_shell` terminates it. One instance per session (created in index.ts).
 */
export class BgRegistry {
  private readonly procs = new Map<string, BgProc>();
  /** Live log tailers for file-backed shells (one per stream, keyed by shell id). */
  private readonly tails = new Map<string, FileTail[]>();
  private seq = 0;
  private workCenter?: WorkCenter;

  /** Attach a WorkCenter for integrated tracking (optional) */
  attachWorkCenter(wc: WorkCenter | undefined): void {
    this.workCenter = wc;
  }

  add(
    command: string,
    child: ChildProcess,
    seed?: { stdout?: string; stderr?: string },
    logPaths?: { stdout: string; stderr: string },
    startOffsets?: { stdout: number; stderr: number },
  ): BgProc {
    const id = `bash_${++this.seq}`;
    const startedAt = Date.now();
    const proc: BgProc = {
      id,
      command,
      child,
      // Output the caller already captured before handing the child over (a foreground shell
      // promoted on timeout). Without this, bytes the model has seen would vanish from
      // bash_output's buffer and it would look like the command restarted.
      stdout: seed?.stdout ?? '',
      stderr: seed?.stderr ?? '',
      readStdout: 0,
      readStderr: 0,
      exitCode: null,
      signal: null,
      running: true,
      startedAt,
    };
    // Two wiring modes:
    //  - file-backed (normal): the child owns real fds; tail the log files so output still streams
    //    to the UI and bash_output while the child is immune to our exit.
    //  - pipe-backed (a caller registering a bare child, e.g. tests): listen on the pipes.
    if (logPaths) {
      proc.logPaths = logPaths;
      this.attachTails(id, proc, logPaths, startOffsets);
    } else {
      child.stdout?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        if (proc.stdout.length < MAX_CAPTURE) proc.stdout += chunk;
        // Track output activity in WorkCenter
        this.workCenter?.addShellOutput(id, 'stdout', chunk);
      });
      child.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        if (proc.stderr.length < MAX_CAPTURE) proc.stderr += chunk;
        this.workCenter?.addShellOutput(id, 'stderr', chunk);
      });
    }
    child.on('close', (code, sig) => {
      // Drain whatever the child wrote before it died — otherwise the final lines (usually the
      // most interesting: a traceback, an exit summary) never reach the caller.
      for (const tail of this.tails.get(id) ?? []) tail.stop(true);
      this.tails.delete(id);
      proc.running = false;
      proc.exitCode = code;
      proc.signal = sig;
      // Update WorkCenter status
      const status = code === 0 ? 'completed' : 'failed';
      this.workCenter?.updateShellStatus(id, status, code, sig);
    });
    child.on('error', () => {
      proc.running = false;
      this.workCenter?.updateShellStatus(id, 'failed', null, null);
    });
    this.procs.set(id, proc);
    this.evictFinished();
    // Register in WorkCenter
    this.workCenter?.registerShell(id, command, startedAt);
    return proc;
  }

  /**
   * Tail a file-backed shell's log files into its buffers and the WorkCenter.
   *
   * The child writes to plain files, so output must be pulled rather than pushed. One interval
   * per stream, unref'd so an idle session can still exit; the interval is short enough that
   * interactive output feels immediate.
   */
  private attachTails(
    id: string,
    proc: BgProc,
    paths: { stdout: string; stderr: string },
    startOffsets?: { stdout: number; stderr: number },
  ): void {
    const tails: FileTail[] = [];
    const out = new FileTail(
      paths.stdout,
      (chunk) => {
        if (proc.stdout.length < MAX_CAPTURE) proc.stdout += chunk;
        this.workCenter?.addShellOutput(id, 'stdout', chunk);
      },
      { startOffset: startOffsets?.stdout },
    );
    const err = new FileTail(
      paths.stderr,
      (chunk) => {
        if (proc.stderr.length < MAX_CAPTURE) proc.stderr += chunk;
        this.workCenter?.addShellOutput(id, 'stderr', chunk);
      },
      { startOffset: startOffsets?.stderr },
    );
    out.start();
    err.start();
    tails.push(out, err);
    this.tails.set(id, tails);
  }

  /** Bound the registry: over the cap, drop the oldest FINISHED shells (running ones are kept). */
  private evictFinished(): void {
    const MAX = 100;
    if (this.procs.size <= MAX) return;
    for (const [id, p] of this.procs) {
      if (this.procs.size <= MAX) break;
      if (!p.running) this.procs.delete(id);
    }
  }

  get(id: string): BgProc | undefined {
    return this.procs.get(id);
  }

  /** List all background shells (for /work integration) */
  list(): BgProc[] {
    return Array.from(this.procs.values());
  }

  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const p = this.procs.get(id);
    if (!p || !p.running) return false;
    try {
      if (!IS_WIN && typeof p.child.pid === 'number') process.kill(-p.child.pid, signal);
      else p.child.kill(signal);
    } catch {
      /* already gone */
    }
    this.workCenter?.cancelShell(id);
    return true;
  }

  /** Kill every still-running background shell. ONLY on explicit user request. */
  killAll(): void {
    for (const p of this.procs.values()) if (p.running) this.kill(p.id, 'SIGKILL');
  }

  /**
   * Detach every still-running shell so it OUTLIVES this Shadow process.
   *
   * Background shells are already spawned `detached: true` (own process-group leader), so the
   * only thing tying them to us is the pipe. `unref()` on the child and its stdio stops that pipe
   * from holding Node's event loop open, and we deliberately do NOT kill them.
   *
   * This is the fix for "the download died when Shadow exited": shutdown used to call killAll(),
   * so every detached shell was converted into turn-scoped work and SIGKILLed on the way out — no
   * `nohup`, `setsid`, or separate terminal could save it, because the killer was us.
   */
  releaseForExit(): void {
    for (const p of this.procs.values()) {
      if (!p.running) continue;
      try {
        p.child.unref();
        // Node's stream types omit unref() even though the underlying socket/handle has it.
        const unref = (s: unknown): void => (s as { unref?: () => void } | null)?.unref?.();
        unref(p.child.stdout);
        unref(p.child.stderr);
        unref((p.child as { stdin?: unknown }).stdin);
      } catch {
        /* best effort: a shell we cannot unref is still left ALIVE, which is the point */
      }
    }
  }
}

interface BashOutputData {
  id: string;
  running: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function makeBashOutput(bg: BgRegistry): Tool<{ id: string }, BashOutputData> {
  return {
    name: 'bash_output',
    description:
      'Read NEW output from a background shell started with run_shell run_in_background. Returns only ' +
      'stdout/stderr since the last read, plus whether the shell is still running and its exit code.',
    risk: 'read',
    inputSchema: z.object({ id: z.string().min(1).describe('Background shell id, e.g. bash_1.') }),
    async run(input): Promise<ToolResult<BashOutputData>> {
      const start = Date.now();
      const p = bg.get(input.id);
      if (!p) return fail('bash_output', 'read', Date.now() - start, 'unknown_id', `No background shell "${input.id}".`);
      const out = p.stdout.slice(p.readStdout);
      const err = p.stderr.slice(p.readStderr);
      p.readStdout = p.stdout.length;
      p.readStderr = p.stderr.length;
      const status = p.running ? 'running' : `exited (code ${p.exitCode ?? 'unknown'})`;
      const body = [`[${p.id}] ${status}`, out, err ? `[stderr]\n${err}` : '']
        .filter((s) => s !== '')
        .join('\n')
        .trimEnd();
      return ok('bash_output', 'read', Date.now() - start, body || `[${p.id}] ${status} — no new output`, {
        id: p.id,
        running: p.running,
        exitCode: p.exitCode,
        stdout: out,
        stderr: err,
      });
    },
  };
}

export function makeKillShell(bg: BgRegistry): Tool<{ id: string }, { id: string; killed: boolean }> {
  return {
    name: 'kill_shell',
    description: 'Terminate a background shell started with run_shell run_in_background.',
    risk: 'exec',
    inputSchema: z.object({ id: z.string().min(1).describe('Background shell id to kill.') }),
    async run(input): Promise<ToolResult<{ id: string; killed: boolean }>> {
      const start = Date.now();
      const p = bg.get(input.id);
      if (!p) return fail('kill_shell', 'exec', Date.now() - start, 'unknown_id', `No background shell "${input.id}".`);
      if (!p.running) return ok('kill_shell', 'exec', Date.now() - start, `[${p.id}] already exited.`, { id: p.id, killed: false });
      bg.kill(p.id, 'SIGTERM');
      return ok('kill_shell', 'exec', Date.now() - start, `[${p.id}] sent SIGTERM.`, { id: p.id, killed: true });
    },
  };
}
