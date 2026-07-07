import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { fail } from './types.js';
import { clamp } from './util.js';
import { wrapCommand } from '../safety/sandbox.js';
import type { BgRegistry } from './bgShell.js';

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
const UNIX_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL'];
const WIN_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE',
  'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES',
  'PROGRAMDATA', 'PSMODULEPATH',
];

function scrubbedEnv(allowlist: readonly string[]): NodeJS.ProcessEnv {
  // On Windows always union in the shell-essential vars (SYSTEMROOT/PATHEXT/…) or
  // PowerShell can't even start, regardless of how the user trimmed the allowlist.
  const keys = IS_WIN ? unique([...WIN_ALLOWLIST, ...allowlist]) : allowlist;
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const v = process.env[key]; // process.env is case-insensitive on Windows
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs)];
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

/**
 * Reason a command may escape ESC/Ctrl-C and need a MANUAL kill, or null. `sudo`/`doas`
 * run as root (a non-root Shadow can't signal them); `setsid`/`nohup`/`disown`/trailing `&`
 * detach into a new session/background (out of the killed process group).
 */
export function uninterruptibleReason(cmd: string): string | null {
  if (/(^|[\s;&|(])(sudo|doas)\s/.test(cmd)) return 'runs as root — Shadow cannot signal a root process';
  if (/(^|[\s;&|(])setsid\b/.test(cmd)) return 'detaches into a new session (setsid)';
  if (/(^|[\s;&|(])nohup\b/.test(cmd)) return 'detaches (nohup)';
  if (/(^|[\s;])disown\b/.test(cmd)) return 'detaches (disown)';
  if (/&\s*$/.test(cmd.trim())) return 'backgrounded with & — may outlive the turn';
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
  const allowlist = opts.envAllowlist ?? UNIX_ALLOWLIST;
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
        const child = spawn(sandbox.argv[0]!, sandbox.argv.slice(1), {
          cwd: ctx.workspaceRoot,
          env: scrubbedEnv(allowlist),
          detached: !IS_WIN,
          windowsHide: true,
        });
        const proc = opts.bg.add(input.command, child);
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
        const child = spawn(sandbox.argv[0]!, sandbox.argv.slice(1), {
          cwd: ctx.workspaceRoot,
          env: scrubbedEnv(allowlist),
          detached: !IS_WIN, // process-group leader so killTree can take the whole tree
          windowsHide: true,
        });

        if (!child.stdout || !child.stderr) {
          resolve(
            fail('run_shell', 'exec', Date.now() - start, 'spawn_failed', 'child process has no stdio pipes'),
          );
          return;
        }
        const childStdout = child.stdout;
        const childStderr = child.stderr;

        // Surface the child PID (for the HUD) and warn if the command can outlive an ESC.
        if (typeof child.pid === 'number') {
          const warn = uninterruptibleReason(input.command);
          ctx.onShellStart?.({ pid: child.pid, warn });
          if (warn) {
            const killCmd = /(^|[\s;&|(])(sudo|doas)\s/.test(input.command) ? `sudo kill ${child.pid}` : `kill ${child.pid}`;
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
        let timer: ReturnType<typeof setTimeout>;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const GRACE_MS = 3000;

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

        timer = setTimeout(() => {
          timedOut = true;
          killTree(child, 'SIGKILL');
          graceTimer = setTimeout(graceResolve, GRACE_MS);
        }, timeoutMs);

        const onAbort = (): void => {
          aborted = true;
          killTree(child, 'SIGKILL');
          graceTimer = setTimeout(graceResolve, GRACE_MS);
        };
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });

        const cleanup = (): void => {
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          ctx.signal.removeEventListener('abort', onAbort);
        };

        childStdout.on('data', (d: Buffer) => {
          const chunk = d.toString();
          if (ctx.streamShell && ctx.onShellOutput) ctx.onShellOutput(chunk, 'stdout');
          if (stdout.length < MAX_CAPTURE) stdout += chunk;
        });
        childStderr.on('data', (d: Buffer) => {
          const chunk = d.toString();
          if (ctx.streamShell && ctx.onShellOutput) ctx.onShellOutput(chunk, 'stderr');
          if (stderr.length < MAX_CAPTURE) stderr += chunk;
        });

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(fail('run_shell', 'exec', Date.now() - start, 'spawn_failed', `failed to start command: ${err.message}`));
        });

        child.on('close', (code, sig) => {
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
