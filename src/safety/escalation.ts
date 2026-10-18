/**
 * Sandbox escalation — a confined call that failed may ask for exactly one wider mode.
 *
 * Adapted from DeepSeek Harness (`deepseek-ai/deepseek-harness`), MIT License,
 * `packages/sandbox/sandbox/src/escalation.ts`. Copyright (c) DeepSeek.
 * See THIRD_PARTY_NOTICES.md.
 *
 * WHY
 * --
 * Without this, the only way past a sandbox denial is to restart with a wider global setting —
 * which trains people to run wide all the time, and the safe default quietly dies. `dsh` solves it
 * by making escalation a *bounded, recorded, human-gated* event: one rung, one approval, one
 * command. We adopt that shape exactly.
 *
 * THE RULES (all four matter)
 *   1. One rung at a time. `read-only` may ask for `workspace-write`, never for
 *      `danger-full-access` directly — a prompt has to state a delta a human can evaluate.
 *   2. Escalation is never automatic. It is a request, surfaced as a denial the model can act on.
 *   3. Never re-ask for a level already declined. Otherwise a model loops on the prompt and the
 *      human clicks through by reflex, which is worse than no prompt.
 *   4. A denial always says which mode it ran under and what the next rung would grant. A refusal
 *      the model cannot reason about produces flailing, not compliance.
 */

import type { ToolResult } from '../tools/types.js';
import {
  nextSandboxMode,
  sandboxLevel,
  describeSandboxPolicy,
  type SandboxMode,
  type SandboxPolicy,
} from './sandboxPolicy.js';

export interface EscalationRequest {
  /** Mode the call actually ran under. */
  from: SandboxMode;
  /** The single wider mode being requested. */
  to: SandboxMode;
  /** Why the model believes it needs it — shown in the approval prompt. */
  reason: string;
}

export interface EscalationState {
  /** Current mode for the session. */
  mode: SandboxMode;
  /** Levels the human already declined this session — never re-prompted unprompted. */
  declined: ReadonlySet<SandboxMode>;
}

export function createEscalationState(mode: SandboxMode): EscalationState {
  return { mode, declined: new Set() };
}

/** Validate that a request is exactly one rung wider than the current mode. */
export function validateEscalation(
  state: EscalationState,
  req: EscalationRequest,
): { ok: true } | { ok: false; reason: string } {
  if (req.from !== state.mode) {
    return { ok: false, reason: `escalation is from ${req.from}, but the session is running ${state.mode}` };
  }
  const next = nextSandboxMode(state.mode);
  if (!next) {
    return { ok: false, reason: `${state.mode} is already the widest mode — nothing to escalate to` };
  }
  if (req.to !== next) {
    return {
      ok: false,
      reason:
        `escalation must move exactly one rung: ${state.mode} → ${next}. ` +
        `Requested ${state.mode} → ${req.to}, which skips ${sandboxLevel(req.to) - sandboxLevel(state.mode) - 1} ` +
        `level(s) and hides the real cost from the approver.`,
    };
  }
  if (state.declined.has(req.to)) {
    return {
      ok: false,
      reason: `${req.to} was already declined this session — not re-prompting. Ask the operator directly if it is now required.`,
    };
  }
  return { ok: true };
}

export function applyEscalation(state: EscalationState, req: EscalationRequest): EscalationState {
  return { mode: req.to, declined: state.declined };
}

export function recordDecline(state: EscalationState, mode: SandboxMode): EscalationState {
  const declined = new Set(state.declined);
  declined.add(mode);
  return { mode: state.mode, declined };
}

/**
 * Build the denial the model sees when confinement stopped a call.
 *
 * This is the whole UX of the feature: it must tell the model (a) that confinement — not a bug —
 * stopped it, (b) which mode it ran under, (c) the exact next rung available, and (d) how to ask.
 * A bare "operation not permitted" produces guessing; this produces one correct retry.
 */
export function sandboxDenial(
  policy: SandboxPolicy,
  detail: string,
  opts: { declined?: ReadonlySet<SandboxMode> } = {},
): ToolResult<never> {
  const next = nextSandboxMode(policy.mode);
  const canEscalate = next !== null && !opts.declined?.has(next);
  const lines = [
    `Blocked by the sandbox (${policy.mode}): ${detail}`,
    `Effective policy: ${describeSandboxPolicy(policy)}`,
  ];
  if (next && canEscalate) {
    lines.push(
      `This is confinement working as intended, not a failure. If the task genuinely needs it, ` +
        `request escalation to "${next}" — one rung wider — and the operator will be asked to approve it.`,
    );
  } else if (next && opts.declined?.has(next)) {
    lines.push(
      `Escalation to "${next}" was already declined this session; ask the operator before retrying.`,
    );
  } else {
    lines.push('Already running at the widest mode; the operator must widen it explicitly.');
  }
  return {
    ok: false,
    summary: lines.join('\n'),
    error: { code: 'sandbox_denied', message: detail, recoverable: next !== null && canEscalate },
    meta: { tool: 'sandbox', durationMs: 0, risk: 'exec' },
  };
}

/** Detect the shell-level signatures of a confinement denial. */
const DENIAL_PATTERNS = [
  /operation not permitted/i,
  /read-only file system/i,
  /permission denied/i,
  /sandbox-exec: .*deny/i,
  /bwrap: .*denied/i,
  /cannot create .*: Read-only/i,
];

export function looksLikeSandboxDenial(stderrOrOutput: string): boolean {
  return DENIAL_PATTERNS.some((re) => re.test(stderrOrOutput));
}