/**
 * Ops-graph redaction gate (plan §5). Detection reuses the session redaction engine —
 * `redactString` (src/util/redact.ts:103) and `isSecretKey` (:140). No new secret regexes.
 *
 * Fail-closed and unconditional: any string the engine would transform is refused, and any
 * credential-named key with a non-empty value is refused — even an already-masked one.
 * Redacted evidence must be stored under non-credential key names (e.g. `note`, `detail`).
 * A rejected payload is re-phrased by the worker, never bypassed.
 */
import { redactString, isSecretKey } from '../../util/redact.js';
import { MAX_PAYLOAD_BYTES, SecretInPayloadError, OpsError } from './types.js';

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** Deep-walk: every string value must survive redactString unchanged; secret-named keys must be empty. */
export function assertNoSecrets(payload: unknown, path = 'payload'): void {
  if (typeof payload === 'string') {
    if (redactString(payload) !== payload) {
      throw new SecretInPayloadError(`Refusing to store secret material in graph at ${path}. Re-phrase without the credential.`);
    }
    return;
  }
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (isSecretKey(k) && nonEmpty(v)) {
        throw new SecretInPayloadError(`Refusing to store secret material in graph (key "${k}") at ${path}. Use a non-credential key name.`);
      }
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

/** Serialized UTF-8 byte size of a payload. */
export function payloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
}

/** Enforce the 8 KiB per-payload cap (§3). */
export function assertPayloadSize(payload: unknown): void {
  const bytes = payloadBytes(payload);
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new OpsError(`Graph payload is ${bytes} bytes (cap ${MAX_PAYLOAD_BYTES}). Summarize it.`, 'payload_too_large');
  }
}

/** Combined gate for every graph write and enricher result: size first (cheap), then secrets. */
export function gatePayload(payload: unknown): void {
  assertPayloadSize(payload);
  assertNoSecrets(payload);
}

/**
 * Scrubbed child environment (plan §5): PATH, HOME, LANG, TMPDIR only.
 * No provider keys, no credentials, no extension channel. Used by enricher subprocesses.
 */
const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR']);
export function scrubEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (ENV_ALLOWLIST.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}