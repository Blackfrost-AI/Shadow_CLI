import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { fail } from './types.js';
import { clamp } from './util.js';
import { wrapCommand } from '../safety/sandbox.js';
import type { BgRegistry } from './bgShell.js';
import { createShellLog, FileTail } from './shellLog.js';
import { scrubbedEnv, UNIX_SAFE_ENV } from '../util/safeEnv.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard ceiling
const MAX_CAPTURE = 8 * 1024 * 1024; // cap retained stdout/stderr per stream
const STDOUT_CLAMP = 16_000;
const STDERR_CLAMP = 8_000;

const IS_WIN = process.platform === 'win32';

/**
 * Environment allowlist. ONLY these vars are forwarded to the child. Everything
 * else — crucially every `*_API_KEY` / secret in the agent's own environment
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) — is withheld, so a command the model
 * runs cannot exfiltrate the keys that power the agent. Per-platform: Windows
 * shells need SYSTEMROOT/PATHEXT/etc. or they fail to start.
 */
/** Close an fd we handed to a child, ignoring an already-closed descriptor. */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

/** Kill the child's whole process group (POSIX) so grandchildren can't orphan. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (!IS_WIN && typeof child.pid === 'number') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already gone */
  }
}

/** Commands that run their argument as another (usually root) user. */
const PRIVILEGE_CMDS = new Set(['sudo', 'doas', 'pkexec', 'run0']);
/**
 /** Words that keep the NEXT word in command position (precommand modifiers + shell keywords). */
 const COMMAND_PREFIXES = new Set([
   'time', 'exec', 'command', 'builtin', 'env', 'nice', 'nohup', 'setsid', 'xargs', 'stdbuf',
   'timeout', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{',
 ]);
 /** Shells that execute their `-c` argument as a script. */
 const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);

interface ShellScan {
  /** Every simple command found, as its unquoted words (quotes removed, escapes resolved). */
  commands: string[][];
  /** True when the top-level command list ends with a lone `&` (job backgrounded). */
  trailingAmp: boolean;
}

/**
 * Minimal quote-aware POSIX shell lexer — only what is needed to find COMMAND-POSITION words.
 * Text inside '…', "…" and heredoc bodies is data, never a command; `$(…)` and backticks
 * (including inside double quotes) open a nested command context. Not a full parser: on
 * malformed input (unterminated quotes) it flushes what it has, which can only under-report.
 */
function scanShell(cmd: string): ShellScan {
  type Code = { kind: 'top' | 'subst' | 'bt'; words: string[]; cur: string; has: boolean; depth: number };
  type Frame = Code | { kind: 'dq' };
  const commands: string[][] = [];
  const stack: Frame[] = [{ kind: 'top', words: [], cur: '', has: false, depth: 0 }];
  let trailingAmp = false;
  const heredocs: { delim: string; strip: boolean }[] = [];

  const code = (): Code => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k]!;
      if (f.kind !== 'dq') return f;
    }
    return stack[0] as Code;
  };
  const endWord = (c: Code): void => {
    if (c.has) c.words.push(c.cur);
    c.cur = '';
    c.has = false;
  };
  const endCommand = (c: Code): void => {
    endWord(c);
    if (c.words.length) commands.push(c.words);
    c.words = [];
  };
  const append = (c: Code, s: string): void => {
    c.cur += s;
    c.has = true;
    if (c.kind === 'top') trailingAmp = false;
  };

  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const ch = cmd[i]!;
    const nx = cmd[i + 1];
    const top = stack[stack.length - 1]!;

    if (top.kind === 'dq') {
      const c = code();
      if (ch === '\\' && i + 1 < n) { append(c, nx!); i += 2; continue; }
      if (ch === '"') { stack.pop(); c.has = true; i++; continue; }
      if (ch === '$' && nx === '(') { stack.push({ kind: 'subst', words: [], cur: '', has: false, depth: 0 }); i += 2; continue; }
      if (ch === '`') { stack.push({ kind: 'bt', words: [], cur: '', has: false, depth: 0 }); i++; continue; }
      append(c, ch);
      i++;
      continue;
    }

    const c = top;
    if (ch === '\\') {
      if (nx === '\n') { i += 2; continue; } // line continuation
      if (i + 1 < n) append(c, nx!);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = cmd.indexOf("'", i + 1);
      const end = close === -1 ? n : close;
      append(c, cmd.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === '"') { c.has = true; if (c.kind === 'top') trailingAmp = false; stack.push({ kind: 'dq' }); i++; continue; }
    if (ch === '$' && nx === '(') {
      if (c.kind === 'top') trailingAmp = false;
      stack.push({ kind: 'subst', words: [], cur: '', has: false, depth: 0 });
      i += 2;
      continue;
    }
    if (ch === '`') {
      if (c.kind === 'bt') { endCommand(c); stack.pop(); code().has = true; i++; continue; }
      if (c.kind === 'top') trailingAmp = false;
      stack.push({ kind: 'bt', words: [], cur: '', has: false, depth: 0 });
      i++;
      continue;
    }
    if (ch === ')') {
      if (c.kind === 'subst' && c.depth === 0) { endCommand(c); stack.pop(); code().has = true; i++; continue; }
      if (c.depth > 0) c.depth--;
      endCommand(c);
      i++;
      continue;
    }
    if (ch === '(') { c.depth++; endCommand(c); if (c.kind === 'top') trailingAmp = false; i++; continue; }
    if (ch === '#' && !c.has) {
      while (i < n && cmd[i] !== '\n') i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(c); i++; continue; }
    if (ch === '<' && nx === '<' && cmd[i + 2] !== '<') {
      // Heredoc: capture the delimiter; its body (after the next newline) is data.
      let j = i + 2;
      let strip = false;
      if (cmd[j] === '-') { strip = true; j++; }
      while (cmd[j] === ' ' || cmd[j] === '\t') j++;
      let delim = '';
      while (j < n && !/[\s;&|<>()]/.test(cmd[j]!)) {
        const d = cmd[j]!;
        if (d !== '"' && d !== "'" && d !== '\\') delim += d;
        j++;
      }
      if (delim) heredocs.push({ delim, strip });
      endWord(c);
      i = j;
      continue;
    }
    if (ch === '&') {
      const prev = cmd[i - 1];
      if (prev === '>' || prev === '<' || nx === '>') { append(c, ch); i++; continue; } // 2>&1, &>file
      if (nx === '&') { endCommand(c); if (c.kind === 'top') trailingAmp = false; i += 2; continue; }
      endCommand(c);
      if (c.kind === 'top') trailingAmp = true;
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      endCommand(c);
      if (c.kind === 'top' && ch !== '\n') trailingAmp = false;
      i++;
      if (ch === '\n' && heredocs.length) {
        // Skip each pending heredoc body up to and including its delimiter line.
        while (heredocs.length && i < n) {
          const { delim, strip } = heredocs[0]!;
          const eol = cmd.indexOf('\n', i);
          const lineEnd = eol === -1 ? n : eol;
          const line = cmd.slice(i, lineEnd);
          i = lineEnd + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) heredocs.shift();
        }
        heredocs.length = 0;
      }
      continue;
    }
    append(c, ch);
    i++;
  }
  // Flush any unterminated nested contexts, innermost first.
  for (let k = stack.length - 1; k >= 0; k--) {
    const f = stack[k]!;
    if (f.kind !== 'dq') endCommand(f);
  }
  return { commands, trailingAmp };
}

/** Command-position words of one simple command: assignments + prefix opts skipped. */
function commandChain(words: string[]): string[] {
  const chain: string[] = [];
  let expectCommand = true;
  for (const w of words) {
    if (!expectCommand) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue; // FOO=bar cmd
    // Options, option values and durations consumed by a prefix (nice -n 10, timeout 5s).
    if (chain.length && (/^-/.test(w) || /^\d+(\.\d+)?[smhd]?$/.test(w))) continue;
    const base = w.includes('/') ? w.slice(w.lastIndexOf('/') + 1) : w;
    chain.push(base);
    expectCommand = COMMAND_PREFIXES.has(base);
  }
  return chain;
}

/**
 * Every command chain in `cmd`, including scripts handed to `sh -c`/`bash -lc`/`eval`, which run
 * as children of the spawned shell. Depth-bounded so a pathological quote nest cannot recurse away.
 */
function allChains(cmd: string, depth = 0): string[][] {
  const out: string[][] = [];
  for (const words of scanShell(cmd).commands) {
    const chain = commandChain(words);
    out.push(chain);
    const head = chain[0];
    if (!head || depth >= 4) continue;
    let script: string | undefined;
    if (head === 'eval') script = words.slice(1).join(' ');
    else if (SHELLS.has(head)) {
      const at = words.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (at >= 0) script = words[at + 1];
    }
    if (script) out.push(...allChains(script, depth + 1));
  }
  return out;
}

/** True when `cmd` actually EXECUTES sudo/doas/pkexec/run0 (not merely mentions the word). */
export function invokesPrivilegeEscalation(cmd: string): boolean {
  return allChains(cmd).some((ch) => ch.some((w) => PRIVILEGE_CMDS.has(w)));
}

/**
 * Reason a command may escape ESC/Ctrl-C and need a MANUAL kill, or null. A command that
 * EXECUTES `sudo`/`doas` runs as another user (a non-root Shadow can't signal it);
 * `setsid`/`nohup`/`disown`/trailing `&` detach into a new session/background (out of the
 * killed process group). Only command-position words count — `git commit -m "fix sudo"`,
 * `grep -r "nohup " .`, or a heredoc body mentioning sudo are NOT flagged. When Shadow itself
 * runs as root it can signal root children, so the privilege warning is suppressed.
 */
export function uninterruptibleReason(
  cmd: string,
  opts: { shadowIsRoot?: boolean } = {},
): string | null {
  const shadowIsRoot = opts.shadowIsRoot ?? (typeof process.getuid === 'function' && process.getuid() === 0);
  const chains = allChains(cmd);
  const any = (pred: (w: string) => boolean): boolean => chains.some((ch) => ch.some(pred));
  if (!shadowIsRoot && any((w) => PRIVILEGE_CMDS.has(w))) return 'runs as root — Shadow cannot signal a root process';
  if (any((w) => w === 'setsid')) return 'detaches into a new session (setsid)';
  if (any((w) => w === 'nohup')) return 'detaches (nohup)';
  if (chains.some((ch) => ch[0] === 'disown')) return 'detaches (disown)';
  if (scanShell(cmd).trailingAmp) return 'backgrounded with & — may outlive the turn';
  return null;
}

const inputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Shell command to run. Executed from the workspace root with a scrubbed environment (no API keys or secrets are passed through).'),
  description: z
    .string()
    .optional()
    .describe('Active-voice description of what this command does (Claude Bash parity).'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Milliseconds before the command is killed. Defaults to the configured shellTimeoutMs; capped at 1800000 (30 min).'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('Run detached and return immediately with a shell id; read output later with bash_output, stop it with kill_shell. Use for long-running servers/watchers.'),
});

type RunShellInput = z.infer<typeof inputSchema>;

export interface RunShellData {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  sandboxed: boolean; // true when the OS sandbox actually confined the command
  backgroundId?: string; // set when run_in_background started a detached shell
  /**
   * Set when a FOREGROUND command outlived its timeout and was promoted to the background
   * registry instead of being killed. The work is still running; poll it with bash_output.
   */
  promotedId?: string;
}

function describeRunShell(defaultTimeoutMs: number): string {
  // Describe the CURRENT platform's shell only — naming PowerShell on a POSIX host primes
  // weaker models to emit `pwsh`/cmdlets that don't belong here.
  const shellNote = IS_WIN
    ? 'Runs in PowerShell. '
    : 'Runs in a POSIX shell (bash/sh) — use POSIX syntax, NOT PowerShell/pwsh or cmdlets, and quote any path containing spaces, e.g. ls "/a b/c". ';
  return (
    'Run a shell command from the workspace root in a scrubbed environment (no API keys or secrets ' +
    'are passed through). ' + shellNote +
    'Captures stdout, stderr and the exit code. Prefer the dedicated read_file/grep/glob ' +
    `tools for inspecting files; use this for builds, tests, installs and other commands. Default timeout ${Math.round(defaultTimeoutMs / 1000)}s.`
  );
}

/**
 * Heuristic: a PowerShell command issued on a POSIX host (wrong shell), so it can be steered to
 * bash. Start-anchored on purpose — the command must BE pwsh or BE a cmdlet, so a POSIX command
 * that merely contains a `Verb-Noun` arg (e.g. `find -name Test-X`) is not flagged.
 */
export function looksLikePowerShell(cmd: string): boolean {
  const c = cmd.trim();
  return /^(pwsh|powershell)\b/i.test(c) || /^(Get|Set|New|Remove|Write|Invoke|Start|Stop|Test|Add|Clear|Select)-[A-Z]\w+/.test(c);
}

/**
 * Build the run_shell tool. `opts.denylist`, when supplied, is consulted before
 * every command: returning a non-null string blocks the command and surfaces
 * that string as the reason. M2 plugs the catastrophic-command guard in here.
 */
export function makeRunShell(
  opts: {
    denylist?: (cmd: string) => string | null;
    /** Env vars forwarded to the child (config `shellEnvAllowlist`). Defaults to the unix essentials. */
    envAllowlist?: readonly string[];
    /** Default timeout when the model omits `timeout_ms` (config `shellTimeoutMs`). */
    defaultTimeoutMs?: number;
    /** OS sandbox mode (config `sandbox`). 'auto' = confine where supported; 'off' = unconfined. */
    sandbox?: 'auto' | 'off';
    /** Allow network inside the sandbox (config `sandboxNetwork`). */
    allowNetwork?: boolean;
    /** Registry for `run_in_background` shells (enables bash_output / kill_shell). */
    bg?: BgRegistry;
  } = {},
): Tool<RunShellInput, RunShellData> {
  const allowlist = opts.envAllowlist ?? UNIX_SAFE_ENV;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sandboxEnabled = (opts.sandbox ?? 'auto') !== 'off';
  const allowNetwork = opts.allowNetwork ?? true;
  return {
    name: 'run_shell',
    description: describeRunShell(defaultTimeoutMs),
    risk: 'exec',
    inputSchema,
    async run(input, ctx): Promise<ToolResult<RunShellData>> {
      const start = Date.now();

      const blocked = opts.denylist?.(input.command) ?? null;
      if (blocked) {
        return fail('run_shell', 'exec', Date.now() - start, 'denied', `command blocked: ${blocked}`);
      }

      // Wrong-shell guard: a PowerShell command on a POSIX host (some models default to it). Steer
      // it back to bash instead of running flaky pwsh — recoverable, so the model just re-issues.
      if (!IS_WIN && looksLikePowerShell(input.command)) {
        return fail(
          'run_shell',
          'exec',
          Date.now() - start,
          'wrong_shell',
          `This is a PowerShell command, but you are on ${process.platform} with a POSIX shell. Re-issue it in ` +
            `bash/sh syntax (e.g. \`ls\`, \`cat\`, \`grep -r\`), and quote any path containing spaces, e.g. ls "/a b/c".`,
        );
      }

      const timeoutMs = Math.min(input.timeout_ms ?? defaultTimeoutMs, MAX_TIMEOUT_MS);

      const sandbox = wrapCommand({
        command: input.command,
        workspaceRoot: ctx.workspaceRoot,
        additionalRoots: ctx.additionalRoots ?? [],
        allowNetwork,
        enabled: sandboxEnabled,
      });

      // when the OS sandbox was requested but no tool actually confined the
      // command, it ran UNCONFINED — surface that to the model. The note rides at
      // the FRONT of the summary so a large output tail can't truncate it away.
      const sbWarn =
        sandboxEnabled && !sandbox.sandboxed && sandbox.note ? `⚠ ${sandbox.note}\n` : '';
      if (sbWarn) ctx.log(sandbox.note!);

      if (ctx.dryRun) {
        const how = sandbox.sandboxed ? ' (sandboxed)' : '';
        return result(start, false, 'dry_run', `[dry-run] would run${how}: ${input.command}`, {
          command: input.command,
          stdout: '',
          stderr: '',
          exitCode: null,
          signal: null,
          timedOut: false,
          aborted: false,
          sandboxed: sandbox.sandboxed,
        });
      }

      // Background: spawn detached, register, and return the id immediately.
      if (input.run_in_background && opts.bg) {
        // FILE-BACKED stdio, not pipes. A piped child dies of SIGPIPE the moment Shadow's read
        // end closes, which is what silently killed long downloads mid-progress. See shellLog.ts.
        const logId = `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const log = createShellLog(ctx.workspaceRoot, logId);
        const child = spawn(sandbox.argv[0]!, sandbox.argv.slice(1), {
          cwd: ctx.workspaceRoot,
          env: scrubbedEnv(allowlist),
          // The child owns real files: nothing it writes can fail because we exited. stdin stays
          // 'ignore' so a detached job that reads stdin cannot wedge on a pipe nobody closes.
          stdio: ['ignore', log.outFd, log.errFd],
          detached: !IS_WIN,
          windowsHide: true,
        });
        // The child holds its own duplicate of each fd; ours must be closed or the log file never
        // reaches EOF and we leak a descriptor per background shell.
        closeQuietly(log.outFd);
        closeQuietly(log.errFd);
        const proc = opts.bg.add(input.command, child, undefined, { stdout: log.outPath, stderr: log.errPath });
        return result(
          start,
          true,
          '',
          sbWarn +
            `Started in background as ${proc.id}. Read output with bash_output("${proc.id}"); stop it with kill_shell("${proc.id}").`,
          {
            command: input.command,
            stdout: '',
            stderr: '',
            exitCode: null,
            signal: null,
            timedOut: false,
            aborted: false,
            sandboxed: sandbox.sandboxed,
            backgroundId: proc.id,
          },
        );
      }

      return await new Promise<ToolResult<RunShellData>>((resolve) => {
        // FILE-BACKED stdio on the foreground path too. A foreground child that is still running
        // when Shadow exits (a long build, a download) dies the same way a background one did —
        // SIGPIPE on the closed pipe — and that is precisely the reported "stopped at 35/84 with
        // no traceback". With real files the child is unaffected by our lifetime; the tool still
        // streams because we tail the log.
        const fgLogId = `fg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const log = createShellLog(ctx.workspaceRoot, fgLogId);
        const child = spawn(sandbox.argv[0]!, sandbox.argv.slice(1), {
          cwd: ctx.workspaceRoot,
          env: scrubbedEnv(allowlist),
          // Empty stdin: nothing may wedge waiting for input the agent will never type. Without
          // this the child inherits an open pipe nobody writes or closes, so `cat`, `read`, a bare
          // `python`/`node` REPL, `ssh`, `npm login` all block until the timeout (60s by default,
          // and the reported failure is a misleading "timed out"). The sibling spawn sites in
          // agent/diagnostics.ts and agent/formatter.ts already do exactly this.
          stdio: ['ignore', log.outFd, log.errFd],
          detached: !IS_WIN, // process-group leader so killTree can take the whole tree
          windowsHide: true,
        });
        // The child holds its own duplicates; ours would otherwise leak one fd per command and
        // keep the log from reaching EOF.
        closeQuietly(log.outFd);
        closeQuietly(log.errFd);

        // Surface the child PID (for the HUD) and warn if the command can outlive an ESC.
        if (typeof child.pid === 'number') {
          const warn = uninterruptibleReason(input.command);
          ctx.onShellStart?.({ pid: child.pid, warn });
          if (warn) {
            const killCmd = invokesPrivilegeEscalation(input.command) ? `sudo kill ${child.pid}` : `kill ${child.pid}`;
            const note = `⚠ shell pid ${child.pid}: ${warn}. ESC may not stop it — kill with: ${killCmd}`;
            ctx.log(note);
            if (ctx.streamShell && ctx.onShellOutput) ctx.onShellOutput(`${note}\n`, 'stderr');
          }
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const GRACE_MS = 3000;

        // Stream from the log files instead of pipes. `stdout`/`stderr` remain the accumulators the
        // result is built from, so downstream behaviour is unchanged. Declared here — before every
        // settling closure — so each exit path can flush and stop them.
        const fgTailOut = new FileTail(log.outPath, (chunk) => {
          if (ctx.streamShell && ctx.onShellOutput) ctx.onShellOutput(chunk, 'stdout');
          if (stdout.length < MAX_CAPTURE) stdout += chunk;
        });
        const fgTailErr = new FileTail(log.errPath, (chunk) => {
          if (ctx.streamShell && ctx.onShellOutput) ctx.onShellOutput(chunk, 'stderr');
          if (stderr.length < MAX_CAPTURE) stderr += chunk;
        });
        fgTailOut.start();
        fgTailErr.start();
        /** Stop tailing, draining final bytes first so nothing a child wrote is lost. */
        const stopTails = (flush = true): void => {
          fgTailOut.stop(flush);
          fgTailErr.stop(flush);
        };

        // If killTree can't actually stop the child (an unkillable root/sudo process — the EPERM is
        // swallowed by killTree), the 'close' event never fires and this Promise would never settle,
        // hanging the WHOLE agent turn on ESC/timeout. After a kill, arm a grace timer that force-resolves
        // with the aborted/timeout result so control always returns to the user.
        const graceResolve = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          ctx.signal.removeEventListener('abort', onAbort);
          const data: RunShellData = {
            command: input.command,
            stdout: clamp(stdout, STDOUT_CLAMP),
            stderr: clamp(stderr, STDERR_CLAMP),
            exitCode: null,
            signal: 'SIGKILL',
            timedOut,
            aborted,
            sandboxed: sandbox.sandboxed,
          };
          const msg = timedOut
            ? sbWarn + `command timed out after ${timeoutMs}ms and could not be killed — it may still be running.`
            : sbWarn + 'command was aborted but could not be killed — it may still be running.';
          resolve(result(start, false, timedOut ? 'timeout' : 'aborted', msg, data));
        };

        // Assigned once; graceResolve/cleanup close over it and only run after this line.
        const timer = setTimeout(() => {
          timedOut = true;
          // A foreground command that simply needs LONGER is not a failure — killing it is what
          // destroyed the user's in-flight download. When the registry is available the child is
          // ADOPTED from its log files: it is already a detached process-group leader with
          // FILE-BACKED stdio, so nothing about it depends on this turn staying alive.
          if (opts.bg) {
            promoteToBackground();
            return;
          }
          killTree(child, 'SIGKILL');
          graceTimer = setTimeout(graceResolve, GRACE_MS);
        }, timeoutMs);

        const onAbort = (): void => {
          aborted = true;
          // Same reasoning as the timeout: interrupt the TURN, not the user's work.
          if (opts.bg) {
            promoteToBackground();
            return;
          }
          killTree(child, 'SIGKILL');
          graceTimer = setTimeout(graceResolve, GRACE_MS);
        };

        const cleanup = (): void => {
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          ctx.signal.removeEventListener('abort', onAbort);
        };

        /**
         * Hand the LIVE child to the background registry and settle the tool call now.
         *
         * The child was spawned as its own process-group leader with FILE-BACKED stdio (see
         * shellLog.ts), so nothing about it depends on this turn continuing: BgRegistry.add() tails
         * the same log files from the offsets already consumed and makes the job pollable with
         * bash_output. This is the difference between "your download died at 60s" and "your download
         * kept going and you can check on it" — the tool call ends, the WORK does not.
         *
         * Output captured before the hand-off is replayed into the registry first so nothing the
         * model already saw is lost from bash_output's buffer — and the registry resumes tailing at
         * the byte offset we already consumed, so nothing is emitted twice.
         */
        const promoteToBackground = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          // Drain what the child has written so far, then hand over at the exact consumed offset.
          // The child's stdio is FILE-BACKED (see shellLog.ts), so the registry cannot attach pipe
          // listeners — it tails the same files, and these offsets stop it re-reading our output.
          stopTails(false);
          const proc = opts.bg!.add(input.command, child, { stdout, stderr }, { stdout: log.outPath, stderr: log.errPath }, {
            stdout: fgTailOut.consumed,
            stderr: fgTailErr.consumed,
          });
          const reason = aborted ? 'the turn was interrupted' : `the foreground timeout (${timeoutMs}ms) elapsed`;
          const lead = aborted
            ? `Command was still running when ${reason}, so it was NOT killed.`
            : `Command exceeded ${reason}, so it was NOT killed.`;
          const data: RunShellData = {
            command: input.command,
            stdout: clamp(stdout, STDOUT_CLAMP),
            stderr: clamp(stderr, STDERR_CLAMP),
            exitCode: null,
            signal: null,
            // NOT reported as timedOut/aborted: the work is alive and is meant to be resumed, and
            // a failure flag here makes weaker models conclude the command died.
            timedOut: false,
            aborted: false,
            sandboxed: sandbox.sandboxed,
            backgroundId: proc.id,
            promotedId: proc.id,
          };
          resolve(
            result(
              start,
              true,
              '',
              sbWarn +
                `${lead} It is still running as background shell ${proc.id}. ` +
                `Poll it with bash_output("${proc.id}"); stop it with kill_shell("${proc.id}").`,
              data,
            ),
          );
        };
        // Registered only now, after promoteToBackground and cleanup exist: ctx.signal may already
        // be aborted, which calls onAbort SYNCHRONOUSLY.
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          stopTails();
          cleanup();
          resolve(fail('run_shell', 'exec', Date.now() - start, 'spawn_failed', `failed to start command: ${err.message}`));
        });

        child.on('close', (code, sig) => {
          // Drain final bytes before deciding anything: a child's last output is usually the most
          // informative (traceback, exit summary) and must not be lost to a tail interval boundary.
          stopTails();
          if (settled) return;
          settled = true;
          cleanup();
          const data: RunShellData = {
            command: input.command,
            stdout: clamp(stdout, STDOUT_CLAMP),
            stderr: clamp(stderr, STDERR_CLAMP),
            exitCode: code,
            signal: sig,
            timedOut,
            aborted,
            sandboxed: sandbox.sandboxed,
          };
          if (timedOut) {
            return resolve(result(start, false, 'timeout', sbWarn + `command timed out after ${timeoutMs}ms.`, data));
          }
          if (aborted) {
            return resolve(result(start, false, 'aborted', sbWarn + 'command was aborted.', data));
          }
          if (code === 0) {
            return resolve(result(start, true, '', sbWarn + 'Command exited 0.', data));
          }
          return resolve(result(start, false, 'nonzero_exit', sbWarn + `command exited with code ${code ?? 'unknown'}.`, data));
        });
      });
    },
  };
}

/**
 * Build a ToolResult that always carries the captured `data` — even on failure,
 * so the model still sees stdout/stderr for a command that ran but exited
 * non-zero (the `fail` builder alone cannot attach data).
 */
function result(
  start: number,
  okFlag: boolean,
  code: string,
  message: string,
  data: RunShellData,
): ToolResult<RunShellData> {
  return {
    ok: okFlag,
    summary: message,
    data,
    error: okFlag ? undefined : { code, message, recoverable: true },
    meta: { tool: 'run_shell', durationMs: Date.now() - start, risk: 'exec' },
  };
}

/** Default run_shell with no denylist (M2 supplies one via makeRunShell). */
export const runShell = makeRunShell();
