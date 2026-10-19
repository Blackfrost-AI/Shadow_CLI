/**
 * Session provenance — the immutable record of WHAT produced a session.
 *
 * Why this exists: session logs record events, but historically nothing recorded the
 * (model, provider, harness, version) triple that generated them. A transcript you cannot
 * attribute is not reproducible, not comparable, and not usable as training data — you cannot
 * say which model produced a positive example, or ablate two runs that differ only by model.
 *
 * Two invariants:
 *
 *  1. The session header is written ONCE, at session start, and never rewritten. It captures
 *     the environment as it stood when the session opened.
 *  2. The model is captured PER TURN, not just per session. A mid-session `/model` switch
 *     would otherwise produce a corpus that silently blends two models together with no way to
 *     tell them apart. Every `usage` record carries the model that produced it.
 *
 * Everything here is deliberately cheap and side-effect free: `captureProvenance()` is called
 * once on the hot path at startup, and `turnModel()` is a plain field read.
 */
import { readVersion } from '../version.js';
import { execFileSync } from 'node:child_process';

/** Bumped when the provenance record's shape changes, so readers can migrate. */
export const PROVENANCE_SCHEMA = 1;

export interface HarnessProvenance {
  /** Names of the tool modules active for this session (sorted, stable). */
  tools?: string[];
  /** Approval posture, e.g. 'ask' | 'never' | 'yolo'. */
  approvalMode?: string;
  /** Sandbox backend in use, e.g. 'bwrap' | 'seatbelt' | 'none'. */
  sandbox?: string;
  /** Prompt module names + content hashes, so a prompt change is visible in the record. */
  promptModules?: Record<string, string>;
}

export interface Provenance {
  kind: 'provenance';
  schema: number;
  ts: string;
  /** Shadow version that wrote this session. */
  shadowVersion: string;
  /** Model id at session start. Per-turn model lives on each usage record. */
  model?: string;
  provider?: string;
  /**
   * Endpoint HOST only — never the full URL. A URL can carry a path token, and this record
   * is written to disk and may be exported. `https://api.example.com/v1` → `api.example.com`.
   */
  endpointHost?: string;
  harness?: HarnessProvenance;
  workspace?: { gitCommit?: string; dirty?: boolean };
  sessionId?: string;
  /** Platform triple, for filtering corpora by host. */
  platform?: string;
}

/**
 * Strip a base URL down to its host. Anything that is not a parseable URL yields undefined
 * rather than leaking a raw string that might contain credentials.
 */
export function endpointHostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).host || undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort git commit + dirty flag. Never throws, never blocks startup. */
function gitState(cwd: string): { gitCommit?: string; dirty?: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
    let dirty: boolean | undefined;
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
      });
      dirty = status.trim().length > 0;
    } catch {
      /* dirty is optional */
    }
    return commit ? { gitCommit: commit, ...(dirty === undefined ? {} : { dirty }) } : {};
  } catch {
    return {};
  }
}

export interface CaptureInput {
  model?: string;
  provider?: string;
  baseUrl?: string;
  cwd?: string;
  sessionId?: string;
  harness?: HarnessProvenance;
}

/**
 * Build the provenance record for a new session. Pure apart from the two `execFileSync` git
 * probes, both of which are time-boxed and swallow every error.
 */
export function captureProvenance(input: CaptureInput = {}): Provenance {
  const record: Provenance = {
    kind: 'provenance',
    schema: PROVENANCE_SCHEMA,
    ts: new Date().toISOString(),
    shadowVersion: readVersion(),
  };
  if (input.model) record.model = input.model;
  if (input.provider) record.provider = input.provider;
  const host = endpointHostOf(input.baseUrl);
  if (host) record.endpointHost = host;
  if (input.sessionId) record.sessionId = input.sessionId;
  if (input.harness) record.harness = input.harness;
  if (input.cwd) {
    const g = gitState(input.cwd);
    if (g.gitCommit) record.workspace = g;
  }
  record.platform = `${process.platform}-${process.arch}`;
  return record;
}

/**
 * Read provenance back out of a parsed session file. Returns the first `provenance` record, or
 * undefined for sessions written before this feature existed (a real and common case — every
 * log on disk today predates it, so callers must handle absence rather than assume).
 */
export function provenanceOf(records: Array<Record<string, unknown>>): Provenance | undefined {
  for (const r of records) {
    if (r && r.kind === 'provenance') return r as unknown as Provenance;
  }
  return undefined;
}