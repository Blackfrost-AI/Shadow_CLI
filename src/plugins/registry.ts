// Optional plugin index (P3-07, G3 clause) — user-configured, OFF by default, untrusted content.
//
// Shadow has NO central plugin catalog: nothing phones home unless the user sets
// `pluginIndexUrl` in ~/.shadow/config.json (global-only — PROJECT_UNTRUSTED_KEYS strips it from
// a project file). When set:
//
//   * `shadow plugin search [query]` fetches the index and prints matching entries.
//   * `shadow plugin add <name>` resolves a name against the index, then clones its URL through
//     the SAME git path as a hand-typed URL (scheme allowlist, scrubbed env, shallow clone).
//
// The index is DATA ONLY — entries are displayed to the human and nothing from them is executed.
// Every string is control-char-stripped and capped before display. If `pluginIndexKey` (an ECDSA
// P-256 public key, PEM) is set, the index body MUST carry a valid detached signature at
// `<indexUrl>.sig` — the same fail-closed pattern the release channel uses for SHASUMS256.txt.
// A signature mismatch, missing signature, or unfetchable sig REFUSES the index entirely.

import { verify as cryptoVerify } from 'node:crypto';
import { shadowFetch } from '../safety/egress.js';
import { displaySafe, assertAllowedGitUrl } from './manager.js';

const INDEX_MAX_BYTES = 1024 * 1024; // a plugin index is a small JSON document
const SIG_MAX_BYTES = 4096; // a detached ECDSA P-256 signature is ~70 bytes DER
const INDEX_MAX_ENTRIES = 200;
const INDEX_TIMEOUT_MS = 30_000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * Read a response body with a HARD byte cap enforced DURING the stream. The index host is
 * untrusted by definition (the signature option exists because it isn't fully trusted), so the
 * body is never buffered whole: a 10 GB response is cut off at the cap instead of OOM-ing the
 * process. Declared Content-Length is checked first as a fast refusal.
 */
async function readBodyCapped(res: Response, cap: number, what: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw new PluginIndexError(`${what} exceeds the byte cap (${cap}) — refused`);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cap) throw new PluginIndexError(`${what} exceeds the byte cap (${cap}) — refused`);
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > cap) {
        await res.body.cancel().catch(() => {});
        throw new PluginIndexError(`${what} exceeds the byte cap (${cap}) — refused`);
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    if (err instanceof PluginIndexError) throw err;
    throw new PluginIndexError(`${what} fetch failed mid-body: ${(err as Error).message}`);
  }
  return Buffer.concat(chunks);
}

export interface IndexEntry {
  name: string;
  description: string;
  url: string;
  version?: string;
}

export interface IndexResult {
  entries: IndexEntry[];
  /** True when a pluginIndexKey was configured AND the detached signature verified. */
  signatureVerified: boolean;
  /** True when a key was configured (so an unverified result is a hard failure upstream). */
  keyConfigured: boolean;
  sourceUrl: string;
}

export class PluginIndexError extends Error {}

/** Validate + normalize one raw index entry; null when it isn't safe to even DISPLAY. */
function coerceEntry(raw: unknown): IndexEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !NAME_RE.test(r.name)) return null;
  if (typeof r.url !== 'string') return null;
  // The URL will later be handed to `git clone` through installPluginFromGit — enforce the
  // scheme allowlist NOW so a hostile index can't even stage an ext::/http: entry for display.
  try {
    assertAllowedGitUrl(r.url);
  } catch {
    return null;
  }
  const entry: IndexEntry = {
    name: r.name,
    description: displaySafe(typeof r.description === 'string' ? r.description : '', 300),
    url: r.url,
  };
  if (typeof r.version === 'string') entry.version = displaySafe(r.version, 64);
  return entry;
}

/** Verify a detached ECDSA-SHA256 signature over the exact index bytes. */
export function verifyIndexSignature(body: Buffer, publicKeyPem: string, sig: Buffer): boolean {
  try {
    return cryptoVerify('sha256', body, publicKeyPem, sig);
  } catch {
    return false; // malformed key/sig is a verification failure, not an exception to surface
  }
}

/**
 * Fetch + validate the configured index. Throws PluginIndexError when no index is configured,
 * the fetch fails, the body is oversized/malformed, or — when a key is configured — the
 * signature does not verify (fail-closed).
 */
export async function fetchPluginIndex(cfg: {
  pluginIndexUrl?: string;
  pluginIndexKey?: string;
}): Promise<IndexResult> {
  const url = cfg.pluginIndexUrl?.trim();
  if (!url) {
    throw new PluginIndexError(
      'no plugin index configured — Shadow ships with NO central catalog (zero telemetry). ' +
        'Set `pluginIndexUrl` (and optionally `pluginIndexKey`, an ECDSA P-256 public key PEM for ' +
        'signature verification) in ~/.shadow/config.json.',
    );
  }
  let res: Response;
  try {
    res = await shadowFetch(
      url,
      { redirect: 'error', signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) },
      { purpose: 'plugin-index', origin: 'user' },
    );
  } catch (err) {
    throw new PluginIndexError(`index fetch failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new PluginIndexError(`index returned HTTP ${res.status}`);
  const body = await readBodyCapped(res, INDEX_MAX_BYTES, 'index');

  const keyConfigured = Boolean(cfg.pluginIndexKey?.trim());
  let signatureVerified = false;
  if (keyConfigured) {
    let sigRes: Response;
    try {
      sigRes = await shadowFetch(
        `${url}.sig`,
        { redirect: 'error', signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) },
        { purpose: 'plugin-index', origin: 'user' },
      );
    } catch (err) {
      throw new PluginIndexError(`index signature fetch failed (fail-closed): ${(err as Error).message}`);
    }
    if (!sigRes.ok) throw new PluginIndexError(`index signature returned HTTP ${sigRes.status} (fail-closed)`);
    const sig = await readBodyCapped(sigRes, SIG_MAX_BYTES, 'index signature (fail-closed)');
    signatureVerified = verifyIndexSignature(body, cfg.pluginIndexKey!.trim(), sig);
    if (!signatureVerified) {
      throw new PluginIndexError(
        'index SIGNATURE DID NOT VERIFY against pluginIndexKey — refusing the index (fail-closed)',
      );
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    throw new PluginIndexError('index is not valid JSON');
  }
  const list = (json as { plugins?: unknown })?.plugins;
  if (!Array.isArray(list)) throw new PluginIndexError('index JSON must be { "plugins": [ … ] }');
  const entries: IndexEntry[] = [];
  for (const raw of list.slice(0, INDEX_MAX_ENTRIES)) {
    const entry = coerceEntry(raw);
    if (entry) entries.push(entry);
  }
  return { entries, signatureVerified, keyConfigured, sourceUrl: url };
}

/** Filter index entries by a case-insensitive substring on name/description. */
export function filterIndex(entries: IndexEntry[], query: string): IndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
  );
}

/** Resolve a plugin NAME against the configured index → its clone URL (or null when unknown). */
export async function resolveIndexUrl(
  name: string,
  cfg: { pluginIndexUrl?: string; pluginIndexKey?: string },
): Promise<string | null> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const { entries } = await fetchPluginIndex(cfg);
  return entries.find((e) => e.name.toLowerCase() === wanted)?.url ?? null;
}
