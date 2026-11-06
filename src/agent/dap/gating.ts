// DAP gate model (mission m-10). Two SEPARATE gates with SEPARATE approval digests:
//
//   LAUNCH/ATTACH — process creation is THE privileged act. The approval binds to the
//     SHA-256 digest of the EXACT normalized configuration (adapter id, mode, program,
//     cwd, args, env key names) — the mutation-journal design (src/tools/mutation.ts):
//     an approval for one config is never an approval for another, and a reused approval
//     fails closed against a changed config.
//
//   EVALUATE — expression evaluation executes ARBITRARY CODE inside the debuggee. It is
//     gated SEPARATELY, per expression: approving a launch never approves evaluation, and
//     approving one expression never approves another (each expression has its own digest,
//     bound to its frame).
//
// Fail-closed in every direction:
//   - no approval record → refusal;
//   - an approval whose digest does not match the presented configuration → REFUSAL;
//   - an approval of the other kind → refusal (kinds never cross);
//   - an approval from another session → refusal;
//   - an approval already consumed → refusal (single-use, nonce-like).
//
// The operator prompt is injected as a callback: this module never renders UI and never
// decides on its own. It computes digests, records decisions, and enforces binding.

import { createHash } from 'node:crypto';

/** The two separately-gated acts. */
export type DapGateKind = 'launch' | 'evaluate';

/** A normalized, validated launch/attach configuration (session.ts validates before this). */
export interface DapLaunchConfig {
  /** Adapter id resolved from the registry ('js-debug' | 'debugpy'). */
  adapterId: string;
  /** 'launch' or 'attach' — both are the privileged act and both bind the same way. */
  mode: 'launch' | 'attach';
  /** Absolute, existence-verified debuggee program path. */
  program: string;
  /** Absolute, existence-verified debuggee working directory. */
  cwd: string;
  /** Debuggee argv (validated: no shell metacharacters, no NUL, bounded). */
  args: string[];
  /** Env var NAMES the config requests (never values — no secret ever enters a digest). */
  envKeys: string[];
  /** Attach only: the loopback port of the debug server — the attach target is privileged. */
  attachPort?: number;
}

/** What the operator is shown and approves. */
export interface DapApprovalRequest {
  kind: DapGateKind;
  /** Human-auditable statement of exactly what will run / execute. */
  description: string;
  /** The digest this approval binds to. */
  digest: string;
}

/** A recorded approval — digest-bound, session-bound, single-use. */
export interface DapApprovalRecord {
  kind: DapGateKind;
  digest: string;
  sessionId: string;
  used: boolean;
}

export class DapGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DapGateError';
  }
}

/**
 * Stable digest of a normalized launch configuration. Canonical field order (JSON.stringify of
 * a fixed-shape object) so serialization accidents cannot change what the operator approved.
 */
export function dapLaunchDigest(config: DapLaunchConfig): string {
  const canonical = JSON.stringify({
    adapterId: config.adapterId,
    mode: config.mode,
    program: config.program,
    cwd: config.cwd,
    args: config.args,
    envKeys: [...config.envKeys].sort(),
    attachPort: config.attachPort,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Digest of one exact expression in one exact frame context. */
export function dapEvaluateDigest(expression: string, frameId: number): string {
  return createHash('sha256').update(JSON.stringify({ expression, frameId })).digest('hex');
}

/** The operator prompt: resolve true ONLY on explicit approval; false/throw means denial. */
export type DapApprovalPrompt = (request: DapApprovalRequest) => Promise<boolean>;

export interface DapGate {
  /** Ask the operator to approve this exact launch configuration. */
  requestLaunchApproval(config: DapLaunchConfig): Promise<DapApprovalRequest>;
  /** Ask the operator to approve this exact expression in this exact frame. */
  requestEvaluateApproval(expression: string, frameId: number, context: string): Promise<DapApprovalRequest>;
  /**
   * Consume the approval for a privileged act at the moment of the act. Returns the record or
   * null — null is a REFUSAL and the caller must not proceed. Consumption is what makes an
   * approval single-use: a spent record never authorizes anything again.
   */
  consume(kind: DapGateKind, digest: string): DapApprovalRecord | null;
}

/**
 * The approval store. One instance per debug session: records cannot cross sessions because
 * the session id is stamped at creation and checked at consume time.
 */
export function createDapGate(sessionId: string, prompt: DapApprovalPrompt): DapGate {
  const records: DapApprovalRecord[] = [];

  const grant = (request: DapApprovalRequest): DapApprovalRecord => {
    const record: DapApprovalRecord = { kind: request.kind, digest: request.digest, sessionId, used: false };
    records.push(record);
    return record;
  };

  return {
    async requestLaunchApproval(config) {
      const digest = dapLaunchDigest(config);
      const target = config.mode === 'attach'
        ? `attach to port ${String(config.attachPort)} on loopback`
        : `run '${config.program}${config.args.length > 0 ? ` ${config.args.join(' ')}` : ''}' in '${config.cwd}'`;
      const request: DapApprovalRequest = {
        kind: 'launch',
        description:
          `DAP ${config.mode}: ${target} via the '${config.adapterId}' debug adapter` +
          `${config.envKeys.length > 0 ? ` with env: ${config.envKeys.join(', ')}` : ''}`,
        digest,
      };
      const approved = await prompt(request);
      if (!approved) throw new DapGateError(`Operator did not approve the DAP ${config.mode}.`);
      grant(request);
      return request;
    },

    async requestEvaluateApproval(expression, frameId, context) {
      const digest = dapEvaluateDigest(expression, frameId);
      const request: DapApprovalRequest = {
        kind: 'evaluate',
        description: `DAP evaluate (${context}, frame ${frameId}): execute the expression ${JSON.stringify(expression)} inside the debuggee`,
        digest,
      };
      const approved = await prompt(request);
      if (!approved) throw new DapGateError('Operator did not approve the DAP expression evaluation.');
      grant(request);
      return request;
    },

    consume(kind, digest) {
      const record = records.find(
        (r) => r.kind === kind && r.digest === digest && !r.used && r.sessionId === sessionId,
      );
      if (!record) return null;
      record.used = true; // single-use: consumed at the moment of the act, never re-granted
      return record;
    },
  };
}

/**
 * The exact refusal text for an unconsumable act — one spelling everywhere so tests and
 * operators see the same contract.
 */
export function dapGateRefusal(kind: DapGateKind): string {
  return kind === 'launch'
    ? 'DAP launch/attach refused: no valid approval binds to this exact configuration.'
    : 'DAP evaluate refused: no valid approval binds to this exact expression.';
}
