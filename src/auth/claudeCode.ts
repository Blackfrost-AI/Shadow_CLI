/** Run the user's unmodified Claude Code installation. Never read or copy its credentials. */
import { spawn, type ChildProcess } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { isOfflineMode } from '../safety/egress.js';

export class ClaudeCodeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ClaudeCodeError'; }
}

/** Dependency injection for isolated executable fixtures; never exposed in user configuration. */
export interface ClaudeCodeRuntime {
  executable?: string;
  /** Test fixtures run a Node script without a shell; never populated by application config. */
  argsPrefix?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  killGraceMs?: number;
}

export interface ClaudeCodeStatus {
  installed: boolean;
  supported: boolean;
  version?: string;
  loggedIn: boolean;
  authMethod?: 'claude.ai' | 'none' | 'other';
  message?: string;
}

export function claudeCodeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    // An explicitly selected subscription must never silently use an inherited API key,
    // gateway, cloud account, injected process loader, or externally supplied OAuth token.
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_|CLAUDE_CODE_AWS_|CLAUDE_CODE_AZURE_|CLAUDE_CODE_VERTEX_|CLAUDE_CODE_BEDROCK_)/i.test(key)
      || /^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|DYLD_.*|LD_PRELOAD|LD_LIBRARY_PATH|CLAUDE_CODE_SIMPLE|CLAUDE_CODE_BASE_URL|CLAUDE_CODE_EXTRA_BODY|CLAUDE_CODE_SESSION_ACCESS_TOKEN)$/i.test(key)) delete env[key];
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_TELEMETRY = '1';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '0';
  return env;
}

export async function resolveClaudeCodeExecutable(runtime: ClaudeCodeRuntime = {}): Promise<string> {
  if (runtime.executable) return runtime.executable;
  const cwd = runtime.cwd ?? process.cwd();
  const env = runtime.env ?? process.env;
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const dir of path.split(delimiter)) {
    if (!isAbsolute(dir)) continue; // never execute a repository-local PATH shim
    const rel = relative(cwd, dir);
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) continue;
    try {
      const candidate = await realpath(join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'));
      const candidateRelative = relative(cwd, candidate);
      if (!candidateRelative || (!candidateRelative.startsWith('..') && !isAbsolute(candidateRelative))) continue;
      const info = await stat(candidate);
      if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o022) !== 0)) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* keep searching trusted, absolute PATH entries */ }
  }
  throw new ClaudeCodeError('claude_code_missing', 'Claude Code is not installed on PATH. Install the official native Claude Code CLI, then connect again.');
}

function terminateTree(child: ChildProcess, signal: NodeJS.Signals, detached: boolean): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Native taskkill handles descendants too; arguments contain only our integer PID.
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true, shell: false });
    killer.on('error', () => { try { child.kill(signal); } catch { /* process already exited */ } });
  } else {
    try { process.kill(detached ? -child.pid : child.pid, signal); } catch { /* process already exited */ }
  }
}

export interface ClaudeCodeProcessOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
  input?: string;
  onLine?: (line: string) => void;
  inheritStdio?: boolean;
}

/** All failures use fixed messages. Child stderr/auth output is never included in an error. */
export async function runClaudeCode(executable: string, args: string[], options: ClaudeCodeProcessOptions, runtime: ClaudeCodeRuntime = {}): Promise<{ stdout: string; exitCode: number | null }> {
  if (options.signal?.aborted) throw new ClaudeCodeError('aborted', 'Claude Code request interrupted.');
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32' && !options.inheritStdio;
    const child = spawn(executable, [...(runtime.argsPrefix ?? []), ...args], { cwd: runtime.cwd ?? process.cwd(), env: claudeCodeEnvironment(runtime.env), stdio: options.inheritStdio ? 'inherit' : ['pipe', 'pipe', 'pipe'], detached, windowsHide: true, shell: false });
    let stdout = ''; let pending = ''; let bytes = 0; let settled = false;
    let failure: ClaudeCodeError | undefined;
    let closed = false; let escalated = false; let exitCode: number | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    const maxBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finishTimer);
      options.signal?.removeEventListener('abort', abort);
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (failure) reject(failure); else resolve({ stdout, exitCode });
    };
    const stop = (error: ClaudeCodeError) => {
      if (failure || settled) return;
      failure = error;
      terminateTree(child, 'SIGTERM', detached);
      // Always signal the group again, even if the leader exits before a descendant.
      killTimer = setTimeout(() => {
        escalated = true;
        terminateTree(child, 'SIGKILL', detached);
        if (closed) finish();
        else finishTimer = setTimeout(finish, 1000);
      }, runtime.killGraceMs ?? 250);
    };
    const abort = () => stop(new ClaudeCodeError('aborted', 'Claude Code request interrupted.'));
    const timer = setTimeout(() => stop(new ClaudeCodeError('claude_code_timeout', 'Claude Code exceeded the request deadline.')), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on('error', () => { failure ??= new ClaudeCodeError('claude_code_spawn', 'Claude Code could not be started. Check the official native installation.'); closed = true; finish(); });
    child.on('close', (code) => {
      closed = true; exitCode = code;
      if (!failure && pending.trim() && options.onLine) {
        try { options.onLine(pending); } catch { failure = new ClaudeCodeError('claude_code_protocol', 'Claude Code returned an invalid response.'); }
      }
      if (!killTimer || escalated) finish();
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => {
      if (failure || settled) return;
      bytes += Buffer.byteLength(data);
      if (bytes > maxBytes) { stop(new ClaudeCodeError('claude_code_output_limit', 'Claude Code response exceeded the output limit.')); return; }
      if (!options.onLine) stdout += data;
      else {
        pending += data;
        let at: number;
        while ((at = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, at); pending = pending.slice(at + 1);
          try { if (line.trim()) options.onLine(line); } catch { stop(new ClaudeCodeError('claude_code_protocol', 'Claude Code returned an invalid response.')); return; }
        }
      }
    });
    // Drain without retaining stderr: it can contain account information or token-bearing URLs.
    child.stderr?.on('data', (data: Buffer) => { bytes += data.length; if (bytes > maxBytes) stop(new ClaudeCodeError('claude_code_output_limit', 'Claude Code response exceeded the output limit.')); });
    child.stdin?.on('error', () => { /* early CLI exits may close stdin before our bounded prompt */ });
    child.stdin?.end(options.input ?? '');
  });
}

const REQUIRED_FLAGS = ['--safe-mode', '--restricted', '--tools', '--strict-mcp-config', '--mcp-config', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--json-schema', '--output-format', '--include-partial-messages', '--permission-prompts'];

export async function preflightClaudeCode(runtime: ClaudeCodeRuntime = {}, signal?: AbortSignal): Promise<{ executable: string; version: string }> {
  const executable = await resolveClaudeCodeExecutable(runtime);
  const versionResult = await runClaudeCode(executable, ['--version'], { signal, timeoutMs: 10_000, maxOutputBytes: 4096 }, runtime);
  const version = versionResult.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (versionResult.exitCode !== 0 || !version || !versionResult.stdout.includes('Claude Code')) throw new ClaudeCodeError('claude_code_unsupported', 'The installed executable is not a supported official Claude Code CLI.');
  const help = await runClaudeCode(executable, ['--help'], { signal, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 }, runtime);
  if (help.exitCode !== 0 || REQUIRED_FLAGS.some((flag) => !help.stdout.includes(flag))) throw new ClaudeCodeError('claude_code_unsupported', 'Update the official Claude Code CLI: this version lacks the isolation or structured-output flags Shadow requires.');
  return { executable, version };
}

export async function readClaudeCodeStatus(executable: string, runtime: ClaudeCodeRuntime = {}, signal?: AbortSignal): Promise<Pick<ClaudeCodeStatus, 'loggedIn' | 'authMethod' | 'message'>> {
  const result = await runClaudeCode(executable, ['--safe-mode', '--restricted', 'auth', 'status'], { signal, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 }, runtime);
  let parsed: any;
  try { parsed = JSON.parse(result.stdout); } catch { throw new ClaudeCodeError('claude_code_auth_status', 'Claude Code authentication status could not be checked. Run claude auth login in your terminal.'); }
  const loggedIn = result.exitCode === 0 && parsed.loggedIn === true;
  const authMethod = parsed.authMethod === 'claude.ai' ? 'claude.ai' : !loggedIn || parsed.authMethod === 'none' ? 'none' : 'other';
  return { loggedIn, authMethod, ...(!loggedIn ? { message: 'Sign in through the official Claude Code login to use your subscription.' } : authMethod !== 'claude.ai' ? { message: 'Claude Code is using another billing method. Select a Claude subscription through the official login.' } : {}) };
}

export async function claudeCodeStatus(options: { signal?: AbortSignal; runtime?: ClaudeCodeRuntime } = {}): Promise<ClaudeCodeStatus> {
  try {
    const ready = await preflightClaudeCode(options.runtime, options.signal);
    if (isOfflineMode()) return { installed: true, supported: true, version: ready.version, loggedIn: false, message: 'Claude Code subscription access is unavailable in offline mode.' };
    return { installed: true, supported: true, version: ready.version, ...await readClaudeCodeStatus(ready.executable, options.runtime, options.signal) };
  } catch (error) {
    if (error instanceof ClaudeCodeError && error.code === 'aborted') throw error;
    return { installed: !(error instanceof ClaudeCodeError && error.code === 'claude_code_missing'), supported: false, loggedIn: false, message: error instanceof ClaudeCodeError ? error.message : 'Claude Code could not be checked.' };
  }
}

export async function claudeCodeLogin(options: { signal?: AbortSignal; runtime?: ClaudeCodeRuntime } = {}): Promise<void> {
  if (isOfflineMode()) throw new ClaudeCodeError('offline', 'Claude Code login is unavailable in offline mode.');
  const { executable } = await preflightClaudeCode(options.runtime, options.signal);
  const result = await runClaudeCode(executable, ['auth', 'login'], { signal: options.signal, timeoutMs: 10 * 60_000, inheritStdio: true }, options.runtime);
  if (result.exitCode !== 0) throw new ClaudeCodeError('claude_code_login', 'Claude Code login did not complete. Run claude auth login in your terminal to try again.');
}
