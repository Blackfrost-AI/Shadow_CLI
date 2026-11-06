/**
 * m-7 approval binding: every approval decision is bound to (request id, sha256 of the
 * EXACT params it approved), single-use. This is the mechanical anti-spoofing core:
 *
 * - `seal(requestId, params)` computes the digest of the APPROVED request and stores it under
 *   that request id — an approval is only ever recorded against its own (id, content).
 * - `authorize(requestId, presentedDigest, params)` demands equality on BOTH the request id
 *   and the content digest, and burns the seal. An approval recorded for request A therefore
 *   CANNOT authorize request B: B's params hash to a different digest than A's seal, so the
 *   equality check fails closed with `approval does not match request`.
 * - The seal is single-use: replaying the same approval response a second time finds no seal.
 *
 * Wire integration (policy mode only — see cli.ts): every outbound `session/request_permission`
 * ask carries `_meta.approvalDigest` = the digest of the ask's own params; the editor's response
 * MUST echo it. A non-echoing or mismatched response fails closed to `undefined`, which the
 * permission gate resolves to `deny`. Editors that do not echo cannot approve anything on this
 * wire (documented compatibility limitation).
 */
import { timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256Hex } from './jsonrpc.js';

/** The specific refusal the mission pins — every failure names it. */
export const APPROVAL_MISMATCH = 'approval does not match request';

export type Authorization =
  | { ok: true }
  | { ok: false; reason: string };

export class ApprovalBinding {
  private readonly seals = new Map<string, string>();

  /** Digest of the exact params (canonical, key-order independent). */
  digestOf(params: unknown): string {
    return sha256Hex(canonicalJson(params));
  }

  /** Record an approval under ITS OWN request id — never under another request's. */
  seal(requestId: string, params: unknown): string {
    const digest = this.digestOf(params);
    this.seals.set(String(requestId), digest);
    return digest;
  }

  /** Drop a seal without authorizing (used when an ask never got an answer). */
  unseal(requestId: string): void {
    this.seals.delete(String(requestId));
  }

  /**
   * The single gate every execution passes: (request id, digest) equality against the seal,
   * plus digest equality against the CURRENT params. Single-use — the seal burns either way.
   */
  authorize(requestId: string, presentedDigest: unknown, params: unknown): Authorization {
    const id = String(requestId);
    const expected = this.seals.get(id);
    this.seals.delete(id); // single-use: one decision per seal, success or failure
    if (expected === undefined) {
      return { ok: false, reason: `no approval recorded for request ${id}` };
    }
    if (typeof presentedDigest !== 'string' || !this.sameDigest(presentedDigest, expected)) {
      return { ok: false, reason: APPROVAL_MISMATCH };
    }
    if (this.digestOf(params) !== expected) {
      // The presented approval was minted for DIFFERENT content: spoofing fails closed.
      return { ok: false, reason: APPROVAL_MISMATCH };
    }
    return { ok: true };
  }

  /** Pull the echo out of a permission response: `_meta.approvalDigest`. */
  echoOf(result: unknown): unknown {
    const meta = (result as { _meta?: { approvalDigest?: unknown } } | undefined)?._meta;
    return meta?.approvalDigest;
  }

  private sameDigest(a: string, b: string): boolean {
    if (a.length !== 64 || b.length !== 64) return false;
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  }
}
