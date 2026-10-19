/**
 * Corpus store — where captured trajectories live, and the policy around them.
 *
 * This is a USER-FACING capability, not an internal data pipeline. Shadow collects nothing,
 * phones home to nothing, and has no first-party dataset: every user runs this on their own
 * machine and owns the output. Local-first is the feature, not a constraint on it.
 *
 * The threat model therefore is not "Shadow leaks the corpus". It is **"a user unknowingly
 * exports their own secrets into a training set"** — they will run this against a client repo
 * and then ship the file to a model provider. So:
 *
 *  - Off by default, opt-in per workspace. Nobody silently accumulates a corpus of code they
 *    were merely working on.
 *  - No network code in this module at all, not even optional upload. Zero telemetry stays
 *    literally true here.
 *  - Redaction runs on write AND again on export, with a stricter pass on export.
 *  - `--review` stages output and reports what was redacted before anything leaves the machine.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { redactString } from '../util/redact.js';
import { normalizeSessionFile, type Trajectory } from './trajectory.js';
import { scoreTrajectory, type QualityScore } from './quality.js';

/** Bumped when the on-disk corpus record shape changes. */
export const CORPUS_SCHEMA = 1;

export interface CorpusConfig {
  /** Capture is opt-in. Absent/false means "do not capture". */
  enabled: boolean;
  /** When capture was turned on — consent provenance. */
  enabledAt?: string;
  /** Redaction policy version in force when enabled. */
  redactionVersion?: number;
  /** Capture policy schema version. */
  schema: number;
}

/** Redaction policy version, recorded so an exported corpus says what scrubbed it. */
export const REDACTION_VERSION = 1;

/**
 * Matches `KEY=value` / `"key": "value"` / `key: value` where the key names a credential.
 * Group 2 is the value — harvested so it can be scrubbed everywhere it is later echoed.
 */
const ASSIGNMENT_RE =
  /["']?\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CRED|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?([^\s"',;]{8,})/gi;

/** Per-workspace config path. Deliberately inside the workspace's .shadow so it is reviewable. */
export function corpusConfigPath(workspace: string): string {
  return join(workspace, '.shadow', 'corpus.json');
}

export function readCorpusConfig(workspace: string): CorpusConfig {
  const p = corpusConfigPath(workspace);
  if (!existsSync(p)) return { enabled: false, schema: CORPUS_SCHEMA };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<CorpusConfig>;
    return {
      enabled: raw.enabled === true,
      ...(raw.enabledAt ? { enabledAt: raw.enabledAt } : {}),
      ...(typeof raw.redactionVersion === 'number'
        ? { redactionVersion: raw.redactionVersion }
        : {}),
      schema: typeof raw.schema === 'number' ? raw.schema : CORPUS_SCHEMA,
    };
  } catch {
    // A corrupt config must never silently enable capture.
    return { enabled: false, schema: CORPUS_SCHEMA };
  }
}

export async function writeCorpusConfig(workspace: string, cfg: CorpusConfig): Promise<void> {
  const p = corpusConfigPath(workspace);
  mkdirSync(join(workspace, '.shadow'), { recursive: true });
  await writeFile(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

/** Stable per-workspace bucket so corpora from different projects never mix. */
export function workspaceBucket(workspace: string): string {
  return createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 16);
}

export function corpusDir(workspace: string): string {
  return join(homedir(), '.shadow', 'corpus', workspaceBucket(workspace));
}

/** One line in the corpus: a trajectory plus its label. */
export interface CorpusRecord {
  schema: number;
  capturedAt: string;
  redactionVersion: number;
  trajectory: Trajectory;
  quality: QualityScore;
  /** Split assignment, stable across re-exports. */
  split: 'train' | 'val' | 'test';
  /** Content address for dedup: (contextDigest, action, observation) per turn. */
  digest: string;
  /** How many strings redaction actually changed — surfaced to the user, never hidden. */
  redactionHits?: number;
}

/**
 * Content address for a trajectory.
 *
 * Dedup key is (contextDigest, action, observation) per turn, not the whole blob — retries
 * produce near-identical sessions that differ only in timing, and hashing the raw text would
 * let all of them through. Hashing the *semantic* sequence collapses them.
 */
export function trajectoryDigest(t: Trajectory): string {
  const h = createHash('sha256');
  for (const turn of t.turns) {
    h.update(turn.thought ?? '');
    h.update('\u0000');
    h.update(turn.action ? `${turn.action.tool}:${JSON.stringify(turn.action.input)}` : '');
    h.update('\u0000');
    h.update(turn.observation ? `${turn.observation.ok}:${turn.observation.summary}` : '');
    h.update('\u0001');
  }
  return h.digest('hex');
}

/**
 * Deterministic session-level split.
 *
 * Split by SESSION, never by turn: splitting mid-session leaks context across train/test and
 * produces falsely optimistic evals. Hashing the session id makes the assignment stable, so
 * re-exporting does not shuffle a session between splits and silently leak it.
 */
export function splitFor(sessionId: string, trainPct = 0.9, valPct = 0.05): 'train' | 'val' | 'test' {
  const h = createHash('sha256').update(sessionId).digest();
  const bucket = h[0]! / 256; // 0..1
  if (bucket < trainPct) return 'train';
  if (bucket < trainPct + valPct) return 'val';
  return 'test';
}

/**
 * Harvest credential VALUES that appear in an assignment anywhere in the trajectory.
 *
 * Shape-based scrubbing has a blind spot that matters here: a 40-character AWS secret access key
 * has no distinguishing prefix, so if the model echoes it back in a later message
 * ("leaked wJalr...") the shape matcher cannot know it is a secret. But the trace itself does —
 * the assignment that introduced it names the field. So we harvest those values first, then
 * scrub them verbatim wherever they are later echoed.
 *
 * This is the one place the corpus can be *safer* than the session log it reads from, because it
 * sees the whole trajectory at once rather than one line at a time.
 */
function harvestSecretValues(t: Trajectory): string[] {
  const found = new Set<string>();
  const scan = (s: string): void => {
    if (!s) return;
    for (const m of s.matchAll(ASSIGNMENT_RE)) {
      const value = m[2];
      if (value && value.length >= 8 && !value.startsWith('[')) found.add(value);
    }
  };

  for (const turn of t.turns) {
    if (turn.thought) scan(turn.thought);
    if (turn.answer) scan(turn.answer);
    if (turn.observation?.summary) scan(turn.observation.summary);
    if (turn.action) {
      try {
        scan(JSON.stringify(turn.action.input ?? null));
      } catch {
        /* unserializable input — nothing to scan */
      }
    }
  }
  return [...found];
}

/** Redact every string in a trajectory. Applied on write and again on export. */
export function redactTrajectory(t: Trajectory): { trajectory: Trajectory; hits: number } {
  let hits = 0;
  const harvested = harvestSecretValues(t);

  const r = (s: string): string => {
    let out = redactString(s);
    // Corroborated-value pass: scrub harvested secrets wherever they were echoed.
    for (const secret of harvested) {
      if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    }
    if (out !== s) hits++;
    return out;
  };

  const turns = t.turns.map((turn) => ({
    ...turn,
    ...(turn.thought ? { thought: r(turn.thought) } : {}),
    ...(turn.answer ? { answer: r(turn.answer) } : {}),
    ...(turn.action ? { action: { ...turn.action, input: redactValue(turn.action.input, r) } } : {}),
    ...(turn.observation ? { observation: { ...turn.observation, summary: r(turn.observation.summary) } } : {}),
  }));

  return { trajectory: { ...t, turns }, hits };
}

/** Guard against pathological nesting in hostile input. */
const MAX_DEPTH = 32;

/**
 * Redact the string leaves of a structured value.
 *
 * Deliberately NOT `JSON.parse(redactString(JSON.stringify(v)))`: a pattern that can match a
 * quote (the connection-string credential matcher, `[^@\s/]+`) will happily eat a JSON
 * delimiter, and the parse then throws — losing the whole session. Walking the value cannot
 * corrupt its structure.
 */
function redactValue(value: unknown, r: (s: string) => string, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return r(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, r, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, r, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Build corpus records from this workspace's session logs.
 *
 * Note what this is NOT: it does not copy sessions into a separate store. The session logs
 * already are the corpus — this projects them into labelled, redacted, deduped examples on
 * demand. That means capture is retroactive (enabling it today includes last week's sessions)
 * and `off` is not "stop copying" but "stop reading". Both are stated plainly in the CLI.
 */
export interface BuildOptions {
  includeNeutral?: boolean;
  minScore?: number;
  label?: string;
}

export interface BuildResult {
  records: CorpusRecord[];
  sessionsExamined: number;
  skippedEmpty: number;
  skippedLabel: number;
  skippedScore: number;
  redactionHits: number;
  warnings: string[];
}

export async function buildRecords(
  sessionPaths: string[],
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const records: CorpusRecord[] = [];
  const warnings: string[] = [];
  let skippedEmpty = 0;
  let skippedLabel = 0;
  let skippedScore = 0;
  let redactionHits = 0;

  const minScore = Number.isFinite(opts.minScore) ? (opts.minScore as number) : 0;

  for (const p of sessionPaths) {
    let traj;
    try {
      traj = await normalizeSessionFile(p);
    } catch (error) {
      warnings.push(`${p}: ${(error as Error).message}`);
      continue;
    }
    if (traj.turns.length === 0) {
      skippedEmpty++;
      continue;
    }

    const quality = scoreTrajectory(traj);
    if (!opts.includeNeutral && quality.label === 'neutral') {
      skippedLabel++;
      continue;
    }
    if (quality.score < minScore) {
      skippedScore++;
      continue;
    }
    if (opts.label && quality.label !== opts.label) {
      skippedLabel++;
      continue;
    }

    const { trajectory, hits } = redactTrajectory(traj);
    redactionHits += hits;

    records.push({
      schema: CORPUS_SCHEMA,
      capturedAt: new Date().toISOString(),
      redactionVersion: REDACTION_VERSION,
      trajectory,
      quality,
      split: splitFor(traj.sessionId),
      digest: trajectoryDigest(trajectory),
      redactionHits: hits,
    });
  }

  return {
    records,
    sessionsExamined: sessionPaths.length,
    skippedEmpty,
    skippedLabel,
    skippedScore,
    redactionHits,
    warnings,
  };
}

export interface DedupResult {
  kept: CorpusRecord[];
  dropped: number;
}

/** Drop duplicate trajectories by content address, keeping the highest-scoring representative. */
export function dedupe(records: CorpusRecord[]): DedupResult {
  const byDigest = new Map<string, CorpusRecord>();
  for (const rec of records) {
    const key = rec.digest || trajectoryDigest(rec.trajectory);
    const existing = byDigest.get(key);
    if (!existing || rec.quality.score > existing.quality.score) byDigest.set(key, rec);
  }
  return { kept: [...byDigest.values()], dropped: records.length - byDigest.size };
}

export interface CorpusStats {
  total: number;
  byLabel: Record<string, number>;
  bySplit: Record<string, number>;
  byModel: Record<string, number>;
  redactionHits: number;
  uniqueDigests: number;
}

export function stats(records: CorpusRecord[]): CorpusStats {
  const byLabel: Record<string, number> = {};
  const bySplit: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const digests = new Set<string>();
  let redactionHits = 0;

  for (const rec of records) {
    byLabel[rec.quality.label] = (byLabel[rec.quality.label] ?? 0) + 1;
    bySplit[rec.split] = (bySplit[rec.split] ?? 0) + 1;
    const model = rec.trajectory.provenance?.model ?? rec.trajectory.modelsSeen[0] ?? 'unknown';
    byModel[model] = (byModel[model] ?? 0) + 1;
    digests.add(rec.digest || trajectoryDigest(rec.trajectory));
    redactionHits += rec.redactionHits ?? 0;
  }

  return {
    total: records.length,
    byLabel,
    bySplit,
    byModel,
    redactionHits,
    uniqueDigests: digests.size,
  };
}