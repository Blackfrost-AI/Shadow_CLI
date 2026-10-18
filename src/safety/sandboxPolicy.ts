/**
 * Sandbox mode policy — the single home for "how confined is this session?".
 *
 * Adapted from DeepSeek Harness (`deepseek-ai/deepseek-harness`), MIT License,
 * `packages/sandbox/sandbox/src/escalation.ts` and `sandbox-policy/src/index.ts`.
 * Copyright (c) DeepSeek. See THIRD_PARTY_NOTICES.md.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this, Shadow had no name for its own confinement level: `sandbox: 'auto' | 'off'`
 * described whether to *try* wrapping, and everything else was implicit in whichever profile
 * string a given call site happened to build. That made the safe default unstateable — you cannot
 * default to "read-only" when "read-only" is not a value. `dsh` gets this right and it is most of
 * why their sandbox is trustworthy: there is exactly one policy object, every confined capability
 * reads it, and the fail-safe mode is a real value rather than an absence.
 *
 * THE LADDER (strictly widening, no gaps)
 *   read-only         no writes anywhere; /dev/null still writable so ordinary redirection works
 *   workspace-write   writes confined to the workspace root (+ private tmp)
 *   danger-full-access  no filesystem confinement — an explicit, recorded waiver
 *
 * `read-only` is the fail-safe default. A caller that wants a writable agent opts in explicitly,
 * which means "the agent could write to my repo" is always a decision someone made on purpose.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Strictly widening. Index in this array IS the privilege level — do not reorder. */
export const SANDBOX_MODES: readonly SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;

/**
 * The interactive default.
 *
 * Shadow's existing contract is already "the workspace is the trust boundary" — the filesystem
 * jail confines writes to the workspace root. `workspace-write` states that contract as a value
 * instead of leaving it implicit in a profile string. It is NOT a widening: an agent could already
 * write inside its workspace before this file existed.
 */
export const DEFAULT_SANDBOX_MODE: SandboxMode = 'workspace-write';

/**
 * The default for code we did not write and cannot audit — detonation, sample execution, anything
 * that runs untrusted bytes. Zero write capability, so a sample that tries to persist is stopped by
 * the kernel rather than by a deny-list someone had to remember to write.
 */
export const UNTRUSTED_SANDBOX_MODE: SandboxMode = 'read-only';

export function sandboxLevel(mode: SandboxMode): number {
  const i = SANDBOX_MODES.indexOf(mode);
  // Unknown mode must never silently rank as most privileged.
  return i === -1 ? 0 : i;
}

export function isSandboxMode(v: unknown): v is SandboxMode {
  return typeof v === 'string' && (SANDBOX_MODES as readonly string[]).includes(v);
}

/**
 * One strictly wider mode, or null at the top.
 *
 * The escalation ladder deliberately moves ONE rung at a time so an approval prompt can always
 * state a bounded delta ("allow writes to this workspace") rather than an unbounded one
 * ("allow everything"). `dsh` does the same, and it is the difference between a prompt a human
 * can actually evaluate and one they click through.
 */
export function nextSandboxMode(mode: SandboxMode): SandboxMode | null {
  const i = SANDBOX_MODES.indexOf(mode);
  if (i === -1) return SANDBOX_MODES[1] ?? null;
  return SANDBOX_MODES[i + 1] ?? null;
}

export interface SandboxPolicy {
  mode: SandboxMode;
  /** Absolute workspace root — the write target for `workspace-write`. */
  workspaceRoot: string;
  /** Absolute paths writable in addition to the mode's own set. */
  extraWritableRoots: readonly string[];
  /** Whether the sandboxed process may reach the network. */
  allowNetwork: boolean;
  /**
   * Invert the profile to `(deny default)` and allow only what execution needs.
   *
   * This is the read side of containment, and it is the actual P1: a deny-list of secret paths
   * fails open on the file nobody thought of, which for a defender detonating real ransomware is
   * the whole ballgame. Set for untrusted execution only — a normal agent session needs broad
   * reads to do its job.
   */
  readConfined: boolean;
}

export interface SandboxPolicyInput {
  mode?: unknown;
  workspaceRoot?: string;
  extraWritableRoots?: readonly unknown[];
  allowNetwork?: boolean;
  readConfined?: boolean;
}

/**
 * Resolve a policy from untrusted input. Unknown modes fall back to the fail-safe default rather
 * than throwing: a typo in a config file must not silently grant `danger-full-access`, and it must
 * not brick the session either.
 */
export function resolveSandboxPolicy(input: SandboxPolicyInput = {}): SandboxPolicy {
  const mode = isSandboxMode(input.mode) ? input.mode : DEFAULT_SANDBOX_MODE;
  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const extraWritableRoots = (input.extraWritableRoots ?? [])
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => resolve(p));
  return {
    mode,
    workspaceRoot,
    extraWritableRoots,
    allowNetwork: input.allowNetwork === true,
    // Read confinement is only meaningful below full access: `danger-full-access` is an explicit
    // waiver, so silently confining reads there would contradict the mode the operator chose.
    readConfined: input.readConfined === true && mode !== 'danger-full-access',
  };
}

/** Policy for running untrusted bytes: no writes, reads fenced, no network unless asked. */
export function untrustedSandboxPolicy(
  input: Omit<SandboxPolicyInput, 'mode' | 'readConfined'> = {},
): SandboxPolicy {
  return resolveSandboxPolicy({ ...input, mode: UNTRUSTED_SANDBOX_MODE, readConfined: true });
}

/**
 * The definitive writable set for a mode.
 *
 * `read-only` still allows `/dev/null` (and `/dev/stdout`, `/dev/stderr`) because a shell that
 * cannot write to /dev/null breaks on ordinary `cmd 2>/dev/null` — a sandbox that fails on
 * harmless commands teaches people to disable it. It grants no real write capability.
 */
export function writableRoots(policy: SandboxPolicy): string[] {
  switch (policy.mode) {
    case 'read-only':
      return ['/dev/null', '/dev/stdout', '/dev/stderr'];
    case 'workspace-write':
      return [policy.workspaceRoot, ...policy.extraWritableRoots, '/dev/null', '/dev/stdout', '/dev/stderr'];
    case 'danger-full-access':
      return ['/'];
  }
}

/** Private scratch for a confined run — never the shared `/tmp`. */
export function sandboxScratchDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.shadow', 'tmp');
}

/** Human-readable summary for doctor output and the runtime-context snapshot. */
export function describeSandboxPolicy(policy: SandboxPolicy): string {
  const reads = policy.readConfined ? ', reads fenced to runtime paths' : '';
  switch (policy.mode) {
    case 'read-only':
      return `read-only (no writes; workspace ${policy.workspaceRoot} is NOT writable${reads})`;
    case 'workspace-write':
      return (
        `workspace-write (writes confined to ${policy.workspaceRoot}` +
        (policy.extraWritableRoots.length ? ` + ${policy.extraWritableRoots.join(', ')}` : '') +
        `${reads})`
      );
    case 'danger-full-access':
      return 'danger-full-access (NO filesystem confinement — explicit waiver)';
  }
}

/** Where the per-user default config lives, for error messages that tell people how to change it. */
export function sandboxConfigHint(): string {
  return join(homedir(), '.shadow', 'config.json');
}