/**
 * PKCE (RFC 7636) + state primitives for the opt-in OAuth flow. Pure, no network.
 * Both Codex (auth.openai.com) and Grok (accounts.x.ai) assert a code_verifier of
 * 43–128 chars and use the S256 challenge method.
 */
import { randomBytes, createHash } from 'node:crypto';

/** base64url without padding (the only encoding OAuth PKCE accepts). */
export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * Fresh PKCE pair. 64 random bytes → an 86-char base64url verifier, comfortably
 * inside the RFC's 43–128 window; challenge = base64url(sha256(verifier)).
 */
export function createPkce(): Pkce {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** Opaque anti-CSRF `state` for the authorization request. */
export function randomState(): string {
  return base64url(randomBytes(32));
}
