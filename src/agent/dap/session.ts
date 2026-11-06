// DAP session lifecycle (mission m-10): the state machine that owns the adapter transport,
// the capabilities registry, and every gate boundary.
//
// Wire ordering enforced here (DAP spec §Initialized Event):
//   initialize → capabilities → launch/attach request sent (the spec defers its response
//   until after configurationDone) → adapter's `initialized` event → breakpoint
//   configuration → configurationDone → launch response → running/stopped per events.
//   A launch request NEVER precedes configurationDone, and a stopped-state request
//   (stackTrace/scopes/variables/evaluate) NEVER runs while the debuggee is running.
//
// State machine (forward-only; every failure lands in `closed`):
//   created → initialized → configuring → launching → running ⇄ stopped → closed
//
// Untrusted-input posture (a launch config is UNTRUSTED EXECUTABLE INPUT):
//   - program/cwd are resolved to absolute paths and must EXIST (stat, not string checks);
//   - program/cwd must stay inside the workspace or an explicitly granted root;
//   - args are argv-array elements only — never a shell string — and are additionally
//     rejected when they contain shell metacharacters, NUL, or absurd length;
//   - env VALUES are NEVER taken from the config: only NAMES may be listed, and values
//     are read from the operator's scrubbed environment at launch time;
//   - attach mode requires a loopback host and never names a program (nothing executes).
//
// Cleanup: close() terminates the debuggee when supported, disconnects, then escalates
// SIGTERM(group) → grace → SIGKILL(group) against the adapter child and WAITS until the
// exit is observed under a hard timeout. A session never resolves 'closed' with an
// unreaped child outstanding, and every waiter dies with the session.

import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { redactString } from '../../util/redact.js';

/**
 * Adapter stderr is UNTRUSTED display data. Real adapter failures (module-load
 * errors, stack traces) print absolute paths as a matter of course, and a
 * hostile adapter can print anything. The invariant is the same one frames
 * enforce: NO absolute path — workspace, home or otherwise — ever surfaces.
 * Anything path-shaped is masked whole, then the shared credential redaction
 * runs. Over-redaction (e.g. a URL losing its path part) is the fail-safe
 * direction; the diagnostic text itself survives.
 */
function redactStderr(text: string): string {
  const out = text.replace(/(?:[A-Za-z]:[\\/]|[\\]{2}|\/~?|\/)\S*/g, '[path]');
  return redactString(out);
}
import { inspect } from 'node:util';
import { insideProject } from '../formatter.js';
import { scrubbedEnv } from '../../util/safeEnv.js';
import {
  dapEvaluateDigest,
  dapGateRefusal,
  dapLaunchDigest,
  createDapGate,
  type DapApprovalPrompt,
  type DapGate,
} from './gating.js';
import { DapPeer, DapProtocolError, type DapCommand } from './protocol.js';
import type { DapAdapterSpec } from './adapters.js';

// ── bounds ─────────────────────────────────────────────────────────────────────

export const MAX_STACK_FRAMES = 16;
export const MAX_VARIABLES = 64;
export const MAX_BPS_PER_FILE = 16;
export const MAX_LAUNCH_ARGS = 16;
export const MAX_ARG_CHARS = 256;
export const MAX_EVALUATE_CHARS = 200;
export const DAP_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DAP_TERMINATE_GRACE_MS = 2_000;
export const DAP_REAP_TIMEOUT_MS = 5_000;
/** Hard cap on stop records kept in memory (forensics only). */
const MAX_STOP_RECORDS = 32;

export class DapSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DapSessionError';
  }
}

export type DapSessionState =
  | 'created' | 'initialized' | 'configuring' | 'launching' | 'running' | 'stopped' | 'closed';

// ── capabilities registry ──────────────────────────────────────────────────────

/**
 * The capability flags this client branches on, parsed from the initialize response body.
 * NOTE the spec spelling of the terminateDebuggee flag is `supportTerminateDebuggee` (no
 * 's'); some adapters ship the 'supports…' variant — both are read so neither dialect
 * hides the capability. Everything else stays in `raw`, untrusted.
 */
export interface DapCapabilities {
  supportsConfigurationDoneRequest: boolean;
  supportsTerminateRequest: boolean;
  supportsCancelRequest: boolean;
  supportsTerminateDebuggee: boolean;
  supportsDelayedStackTraceLoading: boolean;
  /** Raw capability flags exactly as the adapter sent them (never trusted beyond accessors). */
  raw: Readonly<Record<string, unknown>>;
}

export function parseDapCapabilities(body: unknown): DapCapabilities {
  const raw: Record<string, unknown> =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const flag = (name: string): boolean => raw[name] === true;
  return {
    supportsConfigurationDoneRequest: flag('supportsConfigurationDoneRequest'),
    supportsTerminateRequest: flag('supportsTerminateRequest'),
    supportsCancelRequest: flag('supportsCancelRequest'),
    supportsTerminateDebuggee: flag('supportTerminateDebuggee') || flag('supportsTerminateDebuggee'),
    supportsDelayedStackTraceLoading: flag('supportsDelayedStackTraceLoading'),
    raw: Object.freeze({ ...raw }),
  };
}

// ── untrusted launch configuration ─────────────────────────────────────────────

export interface DapLaunchRequestNormalized {
  adapterId: string;
  mode: 'launch' | 'attach';
  /** Launch only: absolute, existence-verified debuggee program. */
  program?: string;
  /** Launch only: absolute, existence-verified debuggee cwd. */
  cwd?: string;
  /** Launch only: validated argv tail. */
  args: string[];
  /** Env var NAMES whose scrubbed values the debuggee may receive. */
  envKeys: string[];
  /** Attach only: loopback port of the debug server. */
  port?: number;
}

/** Characters that make an argument unsafe near any exec path (defense in depth). */
const SHELL_META_RE = /[;&|`$><\\\n\r]/;
/** Attach is loopback-only: an untrusted config must never name an external host. */
const LOOPBACK_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;

export interface ValidateLaunchOptions {
  /** Roots (in addition to the workspace) the program/cwd may live in. */
  additionalRoots?: string[];
  /** Does this path exist and is it a file? (default: real fs — injectable for tests) */
  isFile?: (abs: string) => boolean;
  /** Does this path exist and is it a directory? (default: real fs — injectable for tests) */
  isDir?: (abs: string) => boolean;
}

function rejectsInside(root: string, abs: string, extraRoots: string[]): boolean {
  if (insideProject(root, abs)) return false;
  return !extraRoots.some((r) => insideProject(r, abs));
}

/**
 * Validate UNTRUSTED launch/attach input. Returns the normalized config or a rejection.
 * Every check fails closed with a specific message; nothing here executes anything.
 */
export function validateLaunchConfig(
  workspaceRoot: string,
  raw: unknown,
  opts: ValidateLaunchOptions = {},
): { ok: true; config: DapLaunchRequestNormalized } | { ok: false; error: string } {
  const isFile = opts.isFile ?? ((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  const isDir = opts.isDir ?? ((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  const extraRoots = opts.additionalRoots ?? [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Launch configuration must be a JSON object.' };
  }
  const o = raw as Record<string, unknown>;
  const mode = o.mode;
  if (mode !== 'launch' && mode !== 'attach') {
    return { ok: false, error: "Launch configuration requires mode 'launch' or 'attach'." };
  }
  const adapterId = o.adapterId;
  if (typeof adapterId !== 'string' || adapterId === '') {
    return { ok: false, error: 'Launch configuration requires an adapterId.' };
  }

  // Arguments: an argv ARRAY only, and never a shell string.
  const rawArgs = o.args ?? [];
  if (!Array.isArray(rawArgs)) return { ok: false, error: 'Launch args must be an array of strings.' };
  if (rawArgs.length > MAX_LAUNCH_ARGS) {
    return { ok: false, error: `Launch args exceed the ${MAX_LAUNCH_ARGS}-argument cap.` };
  }
  const args: string[] = [];
  for (const a of rawArgs) {
    if (typeof a !== 'string') return { ok: false, error: 'Launch args must be strings.' };
    if (a.includes('\0')) return { ok: false, error: `Launch arg contains a NUL byte: ${inspect(a)}` };
    if (a.length > MAX_ARG_CHARS) {
      return { ok: false, error: `Launch arg exceeds ${MAX_ARG_CHARS} characters.` };
    }
    if (SHELL_META_RE.test(a)) {
      // Defense in depth: args travel as an argv array (no shell is ever involved), but a
      // metacharacter-bearing arg reaching any exec path is rejected outright.
      return { ok: false, error: `Launch arg contains shell metacharacters: ${inspect(a)}` };
    }
    args.push(a);
  }

  // Env: NAMES only — values are read from the scrubbed environment at launch time.
  const rawEnvKeys = o.envKeys ?? [];
  if (!Array.isArray(rawEnvKeys)) return { ok: false, error: 'envKeys must be an array of strings.' };
  const envKeys: string[] = [];
  for (const k of rawEnvKeys) {
    if (typeof k !== 'string' || k === '' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      return { ok: false, error: `Invalid env key name: ${inspect(k)}` };
    }
    envKeys.push(k);
  }

  if (mode === 'attach') {
    const port = o.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: 'Attach configuration requires a port (integer 1–65535).' };
    }
    const host = o.host ?? '127.0.0.1';
    if (typeof host !== 'string' || !LOOPBACK_RE.test(host)) {
      return { ok: false, error: 'Attach host must be loopback (localhost/127.0.0.1/::1).' };
    }
    if (typeof o.program === 'string' && o.program !== '') {
      return { ok: false, error: 'Attach configuration must not name a program (attach never executes anything).' };
    }
    return { ok: true, config: { adapterId, mode, args, envKeys, port } };
  }

  // Launch: program must be an existing file inside an allowed root.
  const program = o.program;
  if (typeof program !== 'string' || program === '') {
    return { ok: false, error: 'Launch configuration requires a program path.' };
  }
  if (program.includes('\0')) {
    return { ok: false, error: `Program path contains a NUL byte: ${inspect(program)}` };
  }
  const programAbs = resolvePath(workspaceRoot, program);
  if (!isFile(programAbs)) {
    return { ok: false, error: `Launch program does not exist or is not a file: ${programAbs}` };
  }
  if (rejectsInside(workspaceRoot, programAbs, extraRoots)) {
    return { ok: false, error: `Launch program must stay inside the workspace: ${programAbs}` };
  }
  const cwdRaw = typeof o.cwd === 'string' && o.cwd !== '' ? o.cwd : '.';
  const cwdAbs = resolvePath(workspaceRoot, cwdRaw);
  if (!isDir(cwdAbs)) {
    return { ok: false, error: `Launch cwd does not exist or is not a directory: ${cwdAbs}` };
  }
  if (rejectsInside(workspaceRoot, cwdAbs, extraRoots)) {
    return { ok: false, error: `Launch cwd must stay inside the workspace: ${cwdAbs}` };
  }

  return { ok: true, config: { adapterId, mode, program: programAbs, cwd: cwdAbs, args, envKeys } };
}

/**
 * The env the debuggee receives: PATH only, plus the approved key names' values
 * copied from the scrubbed base. The base is NEVER spread wholesale — an
 * operator who approves zero env keys gets a debuggee with no secrets at all.
 */
export function debuggeeEnv(envKeys: string[], base: NodeJS.ProcessEnv = scrubbedEnv()): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: base.PATH ?? '' };
  for (const k of envKeys) {
    const v = base[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// ── transport ─────────────────────────────────────────────────────────────────

export interface DapTransportHandlers {
  onData(bytes: Buffer): void;
  onStderr(text: string): void;
  onExit(code: number | null, signal: string | null): void;
  onError(message: string): void;
}

export interface DapTransport {
  write(bytes: Buffer): void;
  attach(handlers: DapTransportHandlers): void;
  /** Escalating termination; resolves when the child is reaped (or the hard timeout passes). */
  terminate(): Promise<{ reaped: boolean; code: number | null; signal: string | null }>;
  /** Real child pid when the transport owns a process; null for in-memory fakes. */
  pid(): number | null;
}

export interface ProcessTransportOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the real spawn (tests NEVER spawn a real adapter). */
  spawnImpl?: (command: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }) => ChildProcess;
}

/**
 * The production transport: one stdio adapter child per session, in its own process group
 * (so group signals reach adapter-spawned helpers), unref'd so plumbing never keeps a run
 * alive, scrubbed env only. Termination escalates SIGTERM(group) → grace → SIGKILL(group)
 * and resolves only when the exit is observed (reaped) or the hard timeout passes.
 */
export function createProcessTransport(spec: DapAdapterSpec, opts: ProcessTransportOptions = {}): DapTransport {
  let child: ChildProcess | null = null;
  let handlers: DapTransportHandlers | null = null;
  let stderrTail = '';
  let exited: { code: number | null; signal: string | null } | null = null;
  let exitWaiters: Array<(v: { code: number | null; signal: string | null }) => void> = [];

  const spawnIt = opts.spawnImpl ?? ((command, args, o) =>
    spawn(command, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }));

  const killGroup = (sig: 'SIGTERM' | 'SIGKILL'): void => {
    if (!child || typeof child.pid !== 'number') return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch { /* already gone */ }
  };

  return {
    write(bytes) {
      try {
        child?.stdin?.write(bytes);
      } catch { /* EPIPE after death — the exit handler owns the failure */ }
    },

    attach(h) {
      handlers = h;
      child = spawnIt(spec.command, spec.args, { cwd: opts.cwd, env: opts.env ?? scrubbedEnv() });
      child.unref();
      child.stdout?.on('data', (d: Buffer) => handlers?.onData(d));
      child.stderr?.on('data', (d: Buffer) => {
        stderrTail = (stderrTail + d.toString()).slice(-2048);
        handlers?.onStderr(d.toString());
      });
      child.on('error', (e: Error) => handlers?.onError(e.message));
      child.on('exit', (code, signal) => {
        exited = { code: code ?? null, signal: signal ?? null };
        const waiters = exitWaiters;
        exitWaiters = [];
        for (const w of waiters) w(exited);
        handlers?.onExit(exited.code, exited.signal);
      });
    },

    async terminate() {
      if (!child) return { reaped: true, code: null, signal: null };
      if (exited) return { reaped: true, code: exited.code, signal: exited.signal };
      killGroup('SIGTERM');
      const grace = setTimeout(() => killGroup('SIGKILL'), DAP_TERMINATE_GRACE_MS);
      grace.unref();
      const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        if (exited) { resolve(exited); return; }
        const timer = setTimeout(() => resolve({ code: null, signal: 'timeout' }), DAP_REAP_TIMEOUT_MS);
        timer.unref();
        exitWaiters.push((v) => { clearTimeout(timer); resolve(v); });
      });
      clearTimeout(grace);
      return { reaped: exited !== null, code: outcome.code, signal: outcome.signal };
    },

    pid() {
      return child && typeof child.pid === 'number' ? child.pid : null;
    },
  };
}

// ── session ────────────────────────────────────────────────────────────────────

export interface DapSessionOptions {
  workspaceRoot: string;
  /** Additional roots the debuggee may live in (mirror of the shell jail's add-dirs). */
  additionalRoots?: string[];
  /** The PRESENT adapter spec (from adapters.ts — absent adapters never get here). */
  adapter: DapAdapterSpec;
  sessionId: string;
  /** The operator-approval prompt (UI). Tests inject a decider. */
  prompt: DapApprovalPrompt;
  /** Test seam: replaces the real process transport. */
  transportFactory?: (spec: DapAdapterSpec, opts: ProcessTransportOptions) => DapTransport;
  /** Test seam: replaces fs probes in launch validation. */
  isFile?: (abs: string) => boolean;
  isDir?: (abs: string) => boolean;
  /** Deadline for the initialize/initialized handshake. */
  handshakeTimeoutMs?: number;
}

export interface DapStopRecord {
  reason: string;
  description: string;
  at: number;
  threadId?: number;
}

export interface DapSessionSummary {
  state: DapSessionState;
  adapterId: string;
  pid: number | null;
  terminated: boolean;
  stoppedEvents: number;
  stderrTail: string;
}

const CLIENT_CAPABILITIES = Object.freeze({
  adapterID: 'shadow',
  columnsStartAt1: true,
  linesStartAt1: true,
  pathFormat: 'path',
});

export class DapSession {
  private state: DapSessionState = 'created';
  private peer: DapPeer | null = null;
  private transport: DapTransport | null = null;
  private capabilities: DapCapabilities | null = null;
  private readonly gate: DapGate = null as unknown as DapGate;
  private stderrTail = '';
  private terminatedEvent = false;
  private stoppedEvents: DapStopRecord[] = [];
  private stopWaiters: Array<(r: DapStopRecord) => void> = [];
  private initWaiters: Array<(v: boolean) => void> = [];
  private closing = false;

  constructor(private readonly opts: DapSessionOptions) {
    this.gate = createDapGate(opts.sessionId, opts.prompt);
  }

  // ── approvals ──────────────────────────────────────────────────────────────

  /**
   * Ask the operator to approve this EXACT launch configuration. Validation first: the
   * operator only ever sees a config that already passed untrusted-input validation, and
   * the digest is computed over the SAME normalized shape that consumption checks later.
   */
  async requestLaunchApproval(raw: unknown): Promise<void> {
    const config = this.validateLaunch(raw);
    await this.gate.requestLaunchApproval({
      adapterId: config.adapterId,
      mode: config.mode,
      program: config.program ?? `attach:${String(config.port ?? '')}`,
      cwd: config.cwd ?? '(none)',
      args: config.args,
      envKeys: config.envKeys,
      ...(config.port !== undefined ? { attachPort: config.port } : {}),
    });
  }

  /** Ask the operator to approve evaluating one EXACT expression in one EXACT frame. */
  async requestEvaluateApproval(expression: string, frameId: number): Promise<void> {
    await this.gate.requestEvaluateApproval(expression, frameId, 'repl');
  }

  getState(): DapSessionState {
    return this.state;
  }

  summary(): DapSessionSummary {
    return {
      state: this.state,
      adapterId: this.opts.adapter.id,
      pid: this.transport?.pid() ?? null,
      terminated: this.terminatedEvent,
      stoppedEvents: this.stoppedEvents.length,
      stderrTail: redactStderr(this.stderrTail.trim()),
    };
  }

  capabilitiesRegistry(): DapCapabilities | null {
    return this.capabilities;
  }

  /** Bounded forensics: recent stop records, oldest dropped past the cap. */
  recentStops(): readonly DapStopRecord[] {
    return Object.freeze([...this.stoppedEvents]);
  }

  /** For inspection.ts: the peer's live request set (telemetry only, never policy). */
  pendingCommands(): readonly string[] {
    return this.peer?.pendingCommands() ?? [];
  }

  /**
   * Launch or attach the debuggee. Ordering enforced: consume the launch approval FIRST
   * (a refusal happens before any process exists) → initialize → launch request sent and
   * kept pending → adapter `initialized` event → initial breakpoints → configurationDone →
   * launch response → running. Nothing runs without a consumed, digest-bound approval.
   */
  async launch(
    raw: unknown,
    initial: { breakpoints?: Array<{ path: string; lines: number[] }> } = {},
  ): Promise<void> {
    if (this.state !== 'created') throw new DapSessionError(`Session already ${this.state}.`);
    const config = this.validateLaunch(raw);

    // GATE 1 — launch/attach. Consume the approval BEFORE any process exists.
    const digest = this.launchDigest(config);
    if (!this.gate.consume('launch', digest)) throw new DapSessionError(dapGateRefusal('launch'));

    const transportFactory = this.opts.transportFactory ?? createProcessTransport;
    this.transport = transportFactory(this.opts.adapter, {
      cwd: this.opts.workspaceRoot,
      env: scrubbedEnv(),
    });
    const transport = this.transport;
    this.peer = new DapPeer((bytes) => transport.write(bytes), {
      onEvent: (name, body) => this.handleEvent(name, body),
      onRequest: async () => {
        // Reverse requests are REFUSED: runInTerminal/startDebugging would let an adapter
        // spawn processes outside our gate — never.
        throw new DapSessionError('Shadow does not serve adapter reverse requests (no terminals, no subprocesses).');
      },
      onProtocolError: (error) => {
        this.stderrTail += `\n[dap-protocol] ${error.kind}: ${error.message}`;
        void this.close(new DapProtocolError(error.kind, error.message)).catch(() => {});
      },
      onWriteError: (message) => { this.stderrTail += `\n[dap-write] ${message}`; },
    });
    transport.attach({
      onData: (bytes) => this.peer?.feed(bytes),
      onStderr: (text) => { this.stderrTail = (this.stderrTail + text).slice(-2048); },
      onExit: () => { void this.close(new DapSessionError('The debug adapter exited.')).catch(() => {}); },
      onError: (message) => {
        this.stderrTail += `\n[dap-spawn] ${message}`;
        void this.close(new DapSessionError(`Cannot start the debug adapter: ${message}`)).catch(() => {});
      },
    });

    // initialize → capabilities registry. A hung or refused initialize must
    // never leave the session wedged in `created`/`initialized` with a live
    // transport — close first, then surface the honest refusal.
    let capabilitiesBody: unknown;
    try {
      capabilitiesBody = await this.send('initialize', CLIENT_CAPABILITIES, { privileged: true });
    } catch (cause) {
      await this.close(null);
      throw cause;
    }
    this.capabilities = parseDapCapabilities(capabilitiesBody);
    this.state = 'initialized';

    // The launch request goes out now and STAYS PENDING until configurationDone.
    // Its rejection is suppressed until awaited below: if the adapter refuses the
    // launch (or the request is cancelled at close), that rejection must be
    // re-raised AFTER cleanup, never surfaced as an unhandled rejection while the
    // session is still mid-handshake.
    const launchPromise = this.send(config.mode, this.launchArguments(config), { privileged: true });
    void launchPromise.catch(() => {});
    this.state = 'configuring';

    // The adapter's `initialized` event is what unlocks configuration.
    const ready = await this.waitForInitialized(this.opts.handshakeTimeoutMs ?? DAP_HANDSHAKE_TIMEOUT_MS);
    if (!ready) {
      await this.close(null);
      throw new DapSessionError('Adapter never reported readiness (no initialized event).');
    }

    for (const bp of initial.breakpoints ?? []) {
      try {
        await this.applyBreakpoints(bp.path, bp.lines);
      } catch (cause) {
        // NEVER wedge the session open in `configuring` with a live adapter
        // child when initial breakpoints fail — close first, then rethrow.
        await this.close(null);
        throw cause;
      }
    }

    try {
      await this.send('configurationDone', undefined, { privileged: true });
    } catch (cause) {
      // An adapter that refuses configurationDone must not leave a live child
      // either — same cleanup-then-rethrow discipline as the paths above.
      await this.close(null);
      throw cause;
    }
    this.state = 'launching';
    try {
      await launchPromise;
    } catch (cause) {
      // The adapter refused or the request was cancelled mid-handshake: the
      // session must NEVER be left wedged open in `launching` with a live
      // transport — clean everything up, then surface the honest refusal.
      await this.close(null);
      throw cause;
    }
    this.state = 'running';
  }

  /** Hard stop: terminate the debuggee, disconnect, kill and REAP the adapter. Idempotent. */
  async disconnect(): Promise<void> {
    await this.close(null);
  }

  private async close(cause: Error | null): Promise<void> {
    if (this.state === 'closed' || this.closing) {
      if (cause) throw cause;
      return;
    }
    this.closing = true;
    this.state = 'closed';

    // Release every waiter: nobody may hang on a dead session.
    const stopWaiters = this.stopWaiters;
    this.stopWaiters = [];
    const initWaiters = this.initWaiters;
    this.initWaiters = [];
    this.peer?.cancelPending('session closed');

    // Tell the adapter the party is over (best effort, bounded).
    if (this.peer && !this.peer.dead()) {
      try {
        if (this.capabilities?.supportsTerminateRequest) {
          await this.peer.request('terminate', { terminateDebuggee: true }, { signal: AbortSignal.timeout(1_500) });
        }
        await this.peer.request('disconnect', { terminateDebuggee: true }, { signal: AbortSignal.timeout(1_500) });
      } catch { /* an adapter that is already gone or refuses is fine — the kill is next */ }
    }

    // Reap the transport's child under a hard timeout, whatever the adapter said.
    const outcome = this.transport
      ? await this.transport.terminate()
      : { reaped: true, code: null, signal: null };
    if (!outcome.reaped) {
      this.stderrTail += `\n[dap-cleanup] adapter child NOT confirmed reaped (pid ${String(this.transport?.pid())})`;
    }
    this.transport = null;
    this.peer = null;
    for (const w of initWaiters) w(false);
    stopWaiters.splice(0, stopWaiters.length);
    if (cause) throw cause;
  }

  // ── gate enforcement ─────────────────────────────────────────────────────────

  private validateLaunch(raw: unknown): DapLaunchRequestNormalized {
    const v = validateLaunchConfig(this.opts.workspaceRoot, raw, {
      additionalRoots: this.opts.additionalRoots ?? [],
      isFile: this.opts.isFile,
      isDir: this.opts.isDir,
    });
    if (!v.ok) throw new DapSessionError(`Untrusted launch configuration rejected: ${v.error}`);
    if (v.config.adapterId !== this.opts.adapter.id) {
      throw new DapSessionError(
        `Launch configuration names adapter '${v.config.adapterId}' but this session runs '${this.opts.adapter.id}'.`,
      );
    }
    return v.config;
  }

  private launchDigest(config: DapLaunchRequestNormalized): string {
    return dapLaunchDigest({
      adapterId: config.adapterId,
      mode: config.mode,
      program: config.program ?? `attach:${String(config.port ?? '')}`,
      cwd: config.cwd ?? '(none)',
      args: config.args,
      envKeys: config.envKeys,
      ...(config.port !== undefined ? { attachPort: config.port } : {}),
    });
  }

  private launchArguments(config: DapLaunchRequestNormalized): Record<string, unknown> {
    if (config.mode === 'attach') {
      return { port: config.port, host: '127.0.0.1' };
    }
    return {
      program: config.program,
      cwd: config.cwd,
      args: config.args,
      env: debuggeeEnv(config.envKeys),
      console: 'internalConsole',
      internalConsoleOptions: 'neverOpen',
    };
  }

  // ── wire discipline ─────────────────────────────────────────────────────────

  private async send(
    command: DapCommand,
    args?: unknown,
    opts: { signal?: AbortSignal; privileged?: boolean } = {},
  ): Promise<unknown> {
    const peer = this.peer;
    if (!peer) throw new DapSessionError('DAP session has no transport.');
    if (!opts.privileged) this.assertWireState(command);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.opts.handshakeTimeoutMs ?? DAP_HANDSHAKE_TIMEOUT_MS);
    try {
      return await peer.request(command, args, { signal: opts.signal ?? deadline.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** State policy for every non-handshake command. */
  private assertWireState(command: DapCommand): void {
    if (this.state === 'closed') throw new DapSessionError('DAP session is closed.');
    if (this.state === 'created' || this.state === 'initialized' || this.state === 'configuring' || this.state === 'launching') {
      throw new DapSessionError(`'${command}' is not allowed before the debuggee exists (state: ${this.state}).`);
    }
    if (STOPPED_ONLY.has(command) && this.state !== 'stopped') {
      throw new DapSessionError(`'${command}' requires a stopped debuggee (state: ${this.state}).`);
    }
  }

  private async applyBreakpoints(path: string, lines: number[]): Promise<void> {
    if (lines.length > MAX_BPS_PER_FILE) {
      throw new DapSessionError(`At most ${MAX_BPS_PER_FILE} breakpoints per file.`);
    }
    await this.send('setBreakpoints', {
      path: resolvePath(this.opts.workspaceRoot, path),
      lines,
    }, { privileged: true });
  }

  // ── events ──────────────────────────────────────────────────────────────────

  private handleEvent(name: string, body: unknown): void {
    if (name === 'initialized') {
      const waiters = this.initWaiters;
      this.initWaiters = [];
      for (const w of waiters) w(true);
      return;
    }
    if (name === 'stopped') {
      const b = (typeof body === 'object' && body !== null ? body : {}) as {
        reason?: unknown; description?: unknown; threadId?: unknown;
      };
      const record: DapStopRecord = {
        reason: typeof b.reason === 'string' ? b.reason : 'unknown',
        description: typeof b.description === 'string' ? b.description : '',
        at: Date.now(),
      };
      if (typeof b.threadId === 'number') record.threadId = b.threadId;
      this.stoppedEvents.push(record);
      if (this.stoppedEvents.length > MAX_STOP_RECORDS) this.stoppedEvents.shift();
      this.state = 'stopped';
      const waiters = this.stopWaiters;
      this.stopWaiters = [];
      for (const w of waiters) w(record);
      return;
    }
    if (name === 'continued') {
      if (this.state === 'stopped') this.state = 'running';
      return;
    }
    if (name === 'terminated' || name === 'exited') {
      this.terminatedEvent = true;
      if (name === 'terminated') {
        void this.close(new DapSessionError('The debug session terminated.')).catch(() => {});
      }
      return;
    }
    // output/breakpoint/thread/module events: recorded as stderr forensics only.
  }

  private waitForInitialized(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.initWaiters.push((v) => { clearTimeout(timer); resolve(v); });
    });
  }

  // ── inspection surface (inspection.ts re-checks state on every call) ────────

  async request(command: DapCommand, args?: unknown): Promise<unknown> {
    return this.send(command, args);
  }

  /** GATE 2 — evaluate. Separate approval per expression, bound to its frame. */
  async evaluate(expression: string, frameId: number): Promise<unknown> {
    if (typeof expression !== 'string' || expression === '') {
      throw new DapSessionError('Evaluate requires a non-empty expression.');
    }
    if (expression.length > MAX_EVALUATE_CHARS) {
      throw new DapSessionError(`Expression exceeds ${MAX_EVALUATE_CHARS} characters.`);
    }
    // Wire state first: the single-use approval is NEVER consumed for a command
    // that cannot legally run (a running debuggee), and the operator is never
    // prompted for something the wire state already forbids.
    const peer = this.peer;
    if (!peer) throw new DapSessionError('DAP session has no transport.');
    this.assertWireState('evaluate');
    const digest = dapEvaluateDigest(expression, frameId);
    if (!this.gate.consume('evaluate', digest)) throw new DapSessionError(dapGateRefusal('evaluate'));
    return this.send('evaluate', { expression, frameId, context: 'repl' });
  }
}

/** Commands legal only while the debuggee is stopped. */
const STOPPED_ONLY: ReadonlySet<DapCommand> = new Set<DapCommand>([
  'stackTrace', 'scopes', 'variables', 'evaluate',
]);
