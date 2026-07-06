import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';

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
}

/**
 * Registry of background shells. run_shell registers a detached child here and
 * returns immediately; `bash_output` drains buffered output incrementally and
 * `kill_shell` terminates it. One instance per session (created in index.ts).
 */
export class BgRegistry {
  private readonly procs = new Map<string, BgProc>();
  private seq = 0;

  add(command: string, child: ChildProcess): BgProc {
    const id = `bash_${++this.seq}`;
    const proc: BgProc = {
      id,
      command,
      child,
      stdout: '',
      stderr: '',
      readStdout: 0,
      readStderr: 0,
      exitCode: null,
      signal: null,
      running: true,
      startedAt: Date.now(),
    };
    child.stdout?.on('data', (d: Buffer) => {
      if (proc.stdout.length < MAX_CAPTURE) proc.stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (proc.stderr.length < MAX_CAPTURE) proc.stderr += d.toString();
    });
    child.on('close', (code, sig) => {
      proc.running = false;
      proc.exitCode = code;
      proc.signal = sig;
    });
    child.on('error', () => {
      proc.running = false;
    });
    this.procs.set(id, proc);
    this.evictFinished();
    return proc;
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

  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const p = this.procs.get(id);
    if (!p) return false;
    try {
      if (!IS_WIN && typeof p.child.pid === 'number') process.kill(-p.child.pid, signal);
      else p.child.kill(signal);
    } catch {
      /* already gone */
    }
    return true;
  }

  /** Kill every still-running background shell (call on session shutdown). */
  killAll(): void {
    for (const p of this.procs.values()) if (p.running) this.kill(p.id, 'SIGKILL');
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
