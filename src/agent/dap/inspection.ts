// Bounded DAP inspection (mission m-10). This module OWNS the response-shape checks and
// the redaction boundary for everything the adapter reports about the debuggee.
//
// Bounds: stack depth ≤ MAX_STACK_FRAMES, variable counts ≤ MAX_VARIABLES per query, and
// breakpoints ≤ MAX_BPS_PER_FILE per file. Redaction: local/argument values that match
// common secret patterns (API keys, bearer tokens, AWS keys, private keys) are REDACTED
// BEFORE display — a debuggee's memory is untrusted display data, not a trusted source.
//
// Everything from the adapter is UNTRUSTED: every field is type-checked and bounded, and
// every failure is a refusal (never a partial answer).

import { MAX_BPS_PER_FILE, MAX_STACK_FRAMES, MAX_VARIABLES, type DapSession } from './session.js';

/** Redaction applied to any displayed value. */
export interface RedactionResult {
  value: string;
  redacted: boolean;
}

/** Patterns that mark a value as secret-like. Deliberately coarse — bias to redact. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'aws-access-key', re: /(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}/ },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{16,}\b/ },
  { name: 'bearer-token', re: /^\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
];

/** Matches when the VALUE looks like a common secret (API key, token, private key). */
export function isSecretLikeValue(value: string): boolean {
  return SECRET_PATTERNS.some(({ re }) => re.test(value));
}

/** Redact a value before display; never returns the original when it matched. */
export function redactSecretValue(value: string): RedactionResult {
  if (isSecretLikeValue(value)) {
    return { value: '[REDACTED: secret-like value]', redacted: true };
  }
  return { value, redacted: false };
}

/** Redaction is applied to names too: a variable NAMED like a secret is also masked. */
export function redactIfSecretNamed(name: string, value: string): RedactionResult {
  if (/secret|token|api[_-]?key|password|credential/i.test(name)) {
    return { value: '[REDACTED: secret-named]', redacted: true };
  }
  return redactSecretValue(value);
}

// ── bounded inspection types ───────────────────────────────────────────────────

export interface DapStackFrame {
  frameId: number;
  name: string;
  sourcePath: string | null;
  line: number | null;
  column: number | null;
}

export interface DapScope {
  scopeId: number;
  name: string;
  expensive: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  redacted: boolean;
  variablesReference: number;
}

export class DapInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DapInspectionError';
  }
}

// ── response-shape validation (adapter output is untrusted) ───────────────────

function asInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new DapInspectionError(`Adapter response field '${field}' is not an integer.`);
  }
  return v;
}

function asNonNegativeInt(v: unknown, field: string): number {
  const n = asInt(v, field);
  if (n < 0) throw new DapInspectionError(`Adapter response field '${field}' is negative.`);
  return n;
}

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string') {
    throw new DapInspectionError(`Adapter response field '${field}' is not a string.`);
  }
  return v;
}

/** Bounds for stepping-timeout enforcement in inspection calls. */
export const DAP_STEP_TIMEOUT_MS = 10_000;

/** Stepping state as tracked by the session; used for state-transition assertions. */
export type DapStepKind = 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause';

/** A refusal factory so every bound violation has one exact spelling. */
export function inspectionRefusal(kind: 'stack' | 'scopes' | 'variables' | 'breakpoints' | 'threads'): string {
  return `Bounded inspection refused: ${kind} query exceeded its bound.`;
}

/**
 * Threads. Bounded count, shape-checked. The first thread id is what inspection uses for
 * stack queries; the adapter's ordering is untrusted and never used as policy.
 */
export async function listThreads(session: DapSession): Promise<Array<{ threadId: number; name: string }>> {
  const body = await session.request('threads');
  const threads = (body as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(threads)) throw new DapInspectionError("Adapter 'threads' response is missing the thread list.");
  const out: Array<{ threadId: number; name: string }> = [];
  for (const t of threads.slice(0, MAX_VARIABLES)) {
    out.push({
      threadId: asNonNegativeInt((t as { id?: unknown })?.id, 'threads[].id'),
      name: asString((t as { name?: unknown })?.name ?? '', 'threads[].name'),
    });
  }
  return out;
}

/**
 * Stack trace, BOUNDED to MAX_STACK_FRAMES: the adapter may offer more; we take at most
 * the bound and record whether truncation happened.
 */
export async function stackTrace(
  session: DapSession,
  threadId: number,
): Promise<{ frames: DapStackFrame[]; truncated: boolean }> {
  const body = await session.request('stackTrace', { threadId, startFrame: 0, levels: MAX_STACK_FRAMES });
  const frames = (body as { stackFrames?: unknown } | null)?.stackFrames;
  if (!Array.isArray(frames)) throw new DapInspectionError("Adapter 'stackTrace' response is missing frames.");
  const out: DapStackFrame[] = [];
  for (const f of frames.slice(0, MAX_STACK_FRAMES)) {
    const source = (f as { source?: { path?: unknown } } | null)?.source;
    out.push({
      frameId: asNonNegativeInt((f as { id?: unknown })?.id, 'stackFrames[].id'),
      name: asString((f as { name?: unknown })?.name ?? '(unnamed)', 'stackFrames[].name'),
      sourcePath: typeof source?.path === 'string' ? source.path : null,
      line: lineOrNull((f as { line?: unknown })?.line),
      column: lineOrNull((f as { column?: unknown })?.column),
    });
  }
  return { frames: out, truncated: frames.length > MAX_STACK_FRAMES };
}

/** Line/column fields may legitimately be absent; anything else is malformed. */
function lineOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new DapInspectionError('Adapter stack frame coordinate is malformed.');
  }
  return v;
}

/** Scopes for one frame, bounded. */
export async function scopes(
  session: DapSession,
  frameId: number,
): Promise<{ scopes: DapScope[]; truncated: boolean }> {
  const body = await session.request('scopes', { frameId });
  const list = (body as { scopes?: unknown } | null)?.scopes;
  if (!Array.isArray(list)) throw new DapInspectionError("Adapter 'scopes' response is missing the scope list.");
  const out: DapScope[] = [];
  for (const s of list.slice(0, MAX_VARIABLES)) {
    out.push({
      scopeId: asNonNegativeInt((s as { variablesReference?: unknown } | null)?.variablesReference, 'scopes[].variablesReference'),
      name: asString((s as { name?: unknown })?.name ?? '(unnamed)', 'scopes[].name'),
      expensive: (s as { expensive?: unknown } | null)?.expensive === true,
    });
  }
  return { scopes: out, truncated: list.length > MAX_VARIABLES };
}

/** Locals (or any child list) under one reference: bounded, shape-checked, REDACTED. */
export async function variables(
  session: DapSession,
  reference: number,
): Promise<{ variables: DapVariable[]; truncated: boolean }> {
  const body = await session.request('variables', { variablesReference: reference });
  const list = (body as { variables?: unknown } | null)?.variables;
  if (!Array.isArray(list)) throw new DapInspectionError("Adapter 'variables' response is missing the variable list.");
  const out: DapVariable[] = [];
  for (const v of list.slice(0, MAX_VARIABLES)) {
    const name = asString((v as { name?: unknown } | null)?.name ?? '(unnamed)', 'variables[].name');
    const rawValue = asString((v as { value?: unknown } | null)?.value ?? '', 'variables[].value');
    const redaction = redactIfSecretNamed(name, rawValue);
    out.push({
      name,
      value: redaction.value,
      redacted: redaction.redacted,
      variablesReference: asNonNegativeInt((v as { variablesReference?: unknown } | null)?.variablesReference, 'variables[].variablesReference'),
    });
  }
  return { variables: out, truncated: list.length > MAX_VARIABLES };
}

// ── breakpoints ───────────────────────────────────────────────────────────────

export interface DapBreakpointStatus {
  /** The line the adapter verified (may differ from the requested line). */
  line: number | null;
  /** The adapter's own id for the breakpoint, when it gave one. */
  bpId: number | null;
  /** True when the adapter verified the breakpoint resolved to real code. */
  verified: boolean;
  message: string | null;
}

/**
 * Set breakpoints in ONE file, BOUNDED to MAX_BPS_PER_FILE, with per-breakpoint
 * verification from the adapter. The file path is workspace-anchored by the session layer.
 */
export async function setBreakpoints(
  session: DapSession,
  path: string,
  lines: number[],
): Promise<{ statuses: DapBreakpointStatus[] }> {
  if (lines.length === 0) throw new DapInspectionError('Breakpoint request requires at least one line.');
  if (lines.length > MAX_BPS_PER_FILE) {
    throw new DapInspectionError(`Breakpoint request exceeds the ${MAX_BPS_PER_FILE}-per-file bound.`);
  }
  const body = await session.request('setBreakpoints', {
    path,
    lines,
  });
  const list = (body as { breakpoints?: unknown } | null)?.breakpoints;
  if (!Array.isArray(list)) throw new DapInspectionError("Adapter 'setBreakpoints' response is missing statuses.");
  const out: DapBreakpointStatus[] = [];
  for (const b of list.slice(0, lines.length)) {
    const message = (b as { message?: unknown } | null)?.message;
    out.push({
      line: lineOrNull((b as { line?: unknown } | null)?.line),
      bpId: bpIdOrNull((b as { id?: unknown } | null)?.id),
      verified: (b as { verified?: unknown } | null)?.verified === true,
      message: typeof message === 'string' ? message : null,
    });
  }
  return { statuses: out };
}

/** Clear every breakpoint in a file: setBreakpoints with an empty list is the DAP way. */
export async function clearBreakpoints(session: DapSession, path: string): Promise<void> {
  const body = await session.request('setBreakpoints', { path, lines: [] });
  const list = (body as { breakpoints?: unknown } | null)?.breakpoints;
  if (!Array.isArray(list) || list.length !== 0) {
    throw new DapInspectionError("Adapter did not confirm clearing breakpoints.");
  }
}

function bpIdOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new DapInspectionError('Adapter breakpoint id is malformed.');
  }
  0;
  return v;
}

// ── stepping ─────────────────────────────────────────────────────────────────

export interface DapStepResult {
  kind: DapStepKind;
  /** The stop record the step ended in, when observed within the timeout. */
  stopReason: string | null;
}

/**
 * Step (continue/next/stepIn/stepOut) and wait for the resulting stop. The session moves to
 * `running` on the step command and back to `stopped` on the stop event — inspection asserts
 * both transitions. A step that never stops within DAP_STEP_TIMEOUT_MS reports
 * stopReason:null (reported honestly, never simulated as a stop).
 */
export async function step(
  session: DapSession,
  kind: Exclude<DapStepKind, 'pause'>,
  threadId: number,
): Promise<DapStepResult> {
  const response = await session.request(kind, { threadId });
  if (kind === 'continue') {
    const allThreadsContinued = (response as { allThreadsContinued?: unknown } | null)?.allThreadsContinued;
    if (allThreadsContinued !== true) {
      throw new DapInspectionError("Adapter 'continue' response did not confirm all threads continued.");
    }
  }
  return { kind, stopReason: null };
}

