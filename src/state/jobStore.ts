import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { resolveWithin } from '../safety/workspaceJail.js';

export type JobStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export type AcceptanceStatus = 'passed' | 'failed' | 'unverified';
export interface CheckEvidence {
  command: string; exitCode: number | null; stdout: string; stderr: string;
  timedOut: boolean; aborted: boolean; recordedAt: number;
  workspaceRoot?: string; sourceHash?: string;
}
export interface AcceptanceSpec { artifacts?: string[]; checks?: string[]; resultSchema?: Record<string, unknown> }
export interface AcceptanceResult { status: AcceptanceStatus; reasons: string[]; checks: CheckEvidence[]; evaluatedAt: number }
/** Configuration references only. Never serialize provider clients, headers, API keys or env. */
export interface JobInput {
  prompt: string; description?: string; subagent_type?: string; profile?: string;
  isolation?: 'none' | 'worktree'; priority?: 'low' | 'normal' | 'high';
  conversation_id?: string;
  consultation_id?: string;
}
export interface JobAttempt {
  id: string; number: number; ownerPid: number; ownerToken: string; heartbeatAt: number;
  startedAt: number; finishedAt?: number; status: JobStatus; stopReason?: string;
  answer?: string; artifactIds: string[]; retryOf?: string;
  usage?: { inputTokens: number; outputTokens: number; costUSD?: number; costConfidence: 'known' | 'unknown' };
}
export interface ProjectJob {
  id: string; parentId?: string; room: string; input: JobInput; createdAt: number; updatedAt: number;
  status: JobStatus; dependencies: string[]; dependencyMode: 'accepted' | 'finished';
  acceptanceSpec: AcceptanceSpec; acceptance: AcceptanceResult; attempts: JobAttempt[];
  maxAttempts: number; profile?: string; provider?: string; model?: string;
  fingerprint?: string;
  category: string;
  cancelRequested?: boolean;
  sourceArtifactIds?: string[];
  launchFailures?: { reason: string; recordedAt: number }[];
}
export interface RoomMessage { id: number; room: string; from: string; to?: string; replyTo?: number; body: string; createdAt: number; jobId?: string }

function livePid(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function unverified(reason = 'No acceptance evidence has been recorded.'): AcceptanceResult {
  return { status: 'unverified', reasons: [reason], checks: [], evaluatedAt: Date.now() };
}
function publicInput(input: JobInput): JobInput {
  // Explicit allowlist also protects JS/JSON callers that bypass TypeScript.
  return { prompt: input.prompt.slice(0, 100_000), description: input.description?.slice(0, 1000),
    subagent_type: input.subagent_type, profile: input.profile, isolation: input.isolation,
    priority: input.priority, consultation_id: input.consultation_id ?? input.conversation_id };
}

/** Single-user project coordination. WAL, a busy timeout, and IMMEDIATE transactions
 * serialize writers across Shadow processes. SQLite owns crash recovery and locking;
 * a saved attempt never implies permission to replay its side effects. */
export class JobStore {
  private readonly db: DatabaseSync;
  readonly path: string;

  constructor(workspaceRoot: string) {
    const dir = resolveWithin(workspaceRoot, '.shadow');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = resolveWithin(workspaceRoot, '.shadow/jobs.sqlite');
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) { this.db.close(); throw new Error(`Project job database uses newer schema ${version}; update Shadow before opening it.`); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT, reply_to INTEGER, body TEXT NOT NULL, created_at INTEGER NOT NULL, job_id TEXT);
      CREATE INDEX IF NOT EXISTS message_room ON messages(room,id);
      CREATE TABLE IF NOT EXISTS cursors (room TEXT NOT NULL, reader TEXT NOT NULL, last_id INTEGER NOT NULL, PRIMARY KEY(room,reader));`);
    // v0 was the initial unpublished layout; v1 keeps that layout. Future migrations
    // must be additive and transactional before advancing user_version.
    if (version === 0) this.transaction(() => { this.db.exec('PRAGMA user_version=1'); });
    for (const suffix of ['-wal', '-shm']) { try { chmodSync(this.path + suffix, 0o600); } catch { /* created lazily by SQLite */ } }
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private save(job: ProjectJob): ProjectJob {
    job.updatedAt = Date.now();
    this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id);
    return job;
  }
  get(id: string): ProjectJob | undefined {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as ProjectJob : undefined;
  }
  list(): ProjectJob[] {
    return (this.db.prepare('SELECT data FROM jobs').all() as { data: string }[])
      .map((row) => JSON.parse(row.data) as ProjectJob).sort((a, b) => b.createdAt - a.createdAt);
  }
  findByAttempt(attemptId: string): ProjectJob | undefined { return this.list().find((job) => job.attempts.some((attempt) => attempt.id === attemptId)); }
  setProfileIdentity(id: string, identity: { profile?: string; provider?: string; model?: string; fingerprint?: string }): void {
    this.transaction(() => { const job = this.require(id); if (job.status !== 'pending') throw new Error('Cannot change a running job profile');
      for (const key of ['profile', 'provider', 'model', 'fingerprint'] as const) if (identity[key] !== undefined) job[key] = identity[key];
      this.save(job); });
  }
  private require(id: string): ProjectJob { const job = this.get(id); if (!job) throw new Error(`Unknown job: ${id}`); return job; }
  createJob(input: JobInput, options: {
    id?: string; parentId?: string; room?: string; dependencies?: string[]; dependencyMode?: 'accepted' | 'finished';
    acceptance?: AcceptanceSpec; maxAttempts?: number; profile?: string; provider?: string; model?: string; fingerprint?: string; category?: string; sourceArtifactIds?: string[];
  } = {}): ProjectJob {
    return this.transaction(() => {
      const now = Date.now();
      const job: ProjectJob = { id: options.id ?? `job_${randomUUID()}`, parentId: options.parentId, room: options.room ?? 'project',
        input: publicInput(input), createdAt: now, updatedAt: now, status: 'pending',
        dependencies: [...new Set(options.dependencies ?? [])], dependencyMode: options.dependencyMode ?? 'accepted',
        acceptanceSpec: options.acceptance ?? {}, acceptance: unverified(), attempts: [],
        maxAttempts: Math.max(1, Math.min(4, options.maxAttempts ?? 4)),
        profile: options.profile ?? input.profile, provider: options.provider, model: options.model, fingerprint: options.fingerprint,
        category: options.category ?? input.subagent_type ?? 'general-purpose', sourceArtifactIds: options.sourceArtifactIds };
      for (const dependency of job.dependencies) this.require(dependency);
      this.db.prepare('INSERT INTO jobs(id,data) VALUES (?,?)').run(job.id, JSON.stringify(job));
      this.assertAcyclic(job.id);
      return job;
    });
  }
  private assertAcyclic(id: string, visiting = new Set<string>(), visited = new Set<string>()): void {
    if (visiting.has(id)) throw new Error('Job dependencies form a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of this.require(id).dependencies) this.assertAcyclic(next, visiting, visited);
    visiting.delete(id); visited.add(id);
  }
  setDependencies(id: string, dependencies: string[], mode: 'accepted' | 'finished' = 'accepted'): ProjectJob {
    return this.transaction(() => {
      const job = this.require(id);
      if (job.status !== 'pending') throw new Error('Dependencies can only change before a job starts');
      dependencies.forEach((dependency) => this.require(dependency));
      job.dependencies = [...new Set(dependencies)]; job.dependencyMode = mode; this.save(job);
      this.assertAcyclic(id); return job;
    });
  }
  blockers(jobOrId: ProjectJob | string): string[] {
    const job = typeof jobOrId === 'string' ? this.require(jobOrId) : jobOrId;
    return job.dependencies.filter((id) => {
      const dependency = this.require(id);
      if (job.dependencyMode === 'finished') return dependency.status === 'pending' || dependency.status === 'running';
      return dependency.status !== 'completed' || dependency.acceptance.status !== 'passed';
    });
  }
  claimAttempt(id: string, options: { attemptId?: string; ownerPid?: number; ownerToken?: string } = {}): JobAttempt {
    return this.transaction(() => {
      const job = this.require(id);
      if (job.status !== 'pending') throw new Error(`Job ${id} is ${job.status}; explicit retry is required before another attempt`);
      const blockers = this.blockers(job);
      if (blockers.length) throw new Error(`Job is blocked by: ${blockers.join(', ')}`);
      if (job.attempts.length >= job.maxAttempts) throw new Error('Job attempt limit reached');
      const previous = job.attempts.at(-1);
      const attempt: JobAttempt = { id: options.attemptId ?? `attempt_${randomUUID()}`, number: job.attempts.length + 1,
        ownerPid: options.ownerPid ?? process.pid, ownerToken: options.ownerToken ?? randomUUID(), heartbeatAt: Date.now(),
        startedAt: Date.now(), status: 'running', artifactIds: [], retryOf: previous?.id };
      job.attempts.push(attempt); job.status = 'running'; this.save(job); return attempt;
    });
  }
  heartbeat(id: string, token: string): boolean {
    return this.transaction(() => {
      const job = this.require(id); const attempt = job.attempts.at(-1);
      if (!attempt || attempt.ownerToken !== token || job.status !== 'running') throw new Error('Job ownership changed');
      attempt.heartbeatAt = Date.now(); this.save(job); return !!job.cancelRequested;
    });
  }
  attachArtifacts(id: string, token: string, artifactIds: string[]): void {
    this.transaction(() => {
      const job = this.require(id); const attempt = job.attempts.at(-1);
      if (!attempt || attempt.ownerToken !== token || job.status !== 'running') throw new Error('Job ownership changed');
      attempt.artifactIds = [...new Set([...attempt.artifactIds, ...artifactIds])]; this.save(job);
    });
  }
  /** Record a gate/configuration rejection before any worker claimed ownership.
   * No attempt is invented. A concurrent legitimate claimant is never overwritten. */
  rejectPending(id: string, reason: string, status: 'failed' | 'cancelled' = 'failed'): ProjectJob {
    return this.transaction(() => {
      const job = this.require(id);
      if (job.status !== 'pending') return job;
      job.status = status;
      job.launchFailures = [...(job.launchFailures ?? []), { reason: reason.slice(0, 8000), recordedAt: Date.now() }].slice(-10);
      job.acceptance = unverified(`Worker did not start: ${reason.slice(0, 8000)}`);
      return this.save(job);
    });
  }
  finishAttempt(id: string, token: string, result: { status: Exclude<JobStatus, 'pending' | 'running'>; stopReason?: string; answer?: string; artifactIds?: string[]; usage?: JobAttempt['usage'] }): ProjectJob {
    return this.transaction(() => {
      const job = this.require(id); const attempt = job.attempts.at(-1);
      if (!attempt || attempt.ownerToken !== token || job.status !== 'running') throw new Error('Job ownership changed; stale completion ignored');
      Object.assign(attempt, result, { artifactIds: result.artifactIds ?? attempt.artifactIds, finishedAt: Date.now(), heartbeatAt: Date.now() });
      job.status = result.status; return this.save(job);
    });
  }
  /** Explicit caller action. Does not claim, start, or replay anything. */
  prepareRetry(id: string, followup?: string): ProjectJob {
    return this.transaction(() => {
      const job = this.require(id);
      if (job.status === 'running' || job.status === 'pending') throw new Error('Job already has active or pending work');
      if (job.attempts.length >= job.maxAttempts) throw new Error('Job attempt limit reached');
      job.status = 'pending'; job.acceptance = unverified('A new attempt needs new acceptance evidence.');
      job.cancelRequested = false;
      if (followup?.trim()) job.input.prompt = `${job.input.prompt}\n\nExplicit follow-up:\n${followup}`.slice(-100_000);
      return this.save(job);
    });
  }
  requestCancel(id: string): string[] {
    return this.transaction(() => {
      this.require(id); const ids = new Set([id]); const jobs = this.list();
      for (let changed = true; changed;) {
        changed = false;
        for (const job of jobs) if (job.parentId && ids.has(job.parentId) && !ids.has(job.id)) { ids.add(job.id); changed = true; }
      }
      const requested: string[] = [];
      for (const job of jobs) if (ids.has(job.id) && (job.status === 'running' || job.status === 'pending')) {
        job.cancelRequested = true; if (job.status === 'pending') job.status = 'cancelled';
        this.save(job); requested.push(job.id);
      }
      return requested;
    });
  }
  /** Startup classification only. A heartbeat timeout alone never steals a live
   * process's work; dead owners become interrupted, never auto-restarted. */
  recoverOrphans(): string[] {
    return this.transaction(() => {
      const recovered: string[] = [];
      for (const job of this.list()) {
        const attempt = job.attempts.at(-1);
        if (job.status !== 'running' || !attempt || livePid(attempt.ownerPid)) continue;
        job.status = 'interrupted'; attempt.status = 'interrupted'; attempt.finishedAt = Date.now();
        attempt.stopReason = 'owner_process_exited'; job.acceptance = unverified('Worker exited; inspect artifacts before explicitly retrying.');
        this.save(job); recovered.push(job.id);
      }
      return recovered;
    });
  }
  recordAcceptance(id: string, result: AcceptanceResult): ProjectJob {
    return this.transaction(() => { const job = this.require(id); job.acceptance = result; return this.save(job); });
  }
  profileMeasurements(category: string): { profiles: { profile: string; fingerprint?: string; verified: number; passed: number; medianMs: number; knownCostUSD: number; unknownCostAttempts: number }[]; recommendation?: string; reason: string } {
    const groups = new Map<string, { profile: string; fingerprint?: string; verified: number; passed: number; durations: number[]; cost: number; unknown: number }>();
    for (const job of this.list()) {
      if (job.category !== category || !job.profile || job.status === 'running' || job.status === 'pending') continue;
      const key = `${job.profile}:${job.fingerprint ?? 'unknown-version'}`;
      const group = groups.get(key) ?? { profile: job.profile, fingerprint: job.fingerprint, verified: 0, passed: 0, durations: [], cost: 0, unknown: 0 };
      if (job.acceptance.status !== 'unverified') { group.verified++; if (job.acceptance.status === 'passed' && job.status === 'completed') group.passed++; }
      for (const attempt of job.attempts) {
        if (attempt.finishedAt) group.durations.push(attempt.finishedAt - attempt.startedAt);
        if (attempt.usage?.costConfidence === 'known') group.cost += attempt.usage.costUSD ?? 0;
        else group.unknown++;
      }
      groups.set(key, group);
    }
    const profiles = [...groups.values()].map((group) => ({ profile: group.profile, fingerprint: group.fingerprint, verified: group.verified, passed: group.passed,
      medianMs: group.durations.sort((a, b) => a - b)[Math.floor(group.durations.length / 2)] ?? 0,
      knownCostUSD: group.cost, unknownCostAttempts: group.unknown }));
    const versions = new Map<string, number>();
    for (const profile of profiles) versions.set(profile.profile, (versions.get(profile.profile) ?? 0) + 1);
    const candidates = profiles.filter((profile) => profile.fingerprint && profile.verified >= 5 && versions.get(profile.profile) === 1).sort((a, b) => b.passed / b.verified - a.passed / a.verified || a.medianMs - b.medianMs);
    return candidates.length >= 2
      ? { profiles, recommendation: candidates[0]!.profile, reason: `Local ${category} observations only; each compared profile has at least five verified jobs. This is not a general model ranking.` }
      : { profiles, reason: 'Insufficient comparable evidence: at least two profiles need five verified jobs each in this category with known, unmixed configuration versions.' };
  }
  postMessage(input: Omit<RoomMessage, 'id' | 'createdAt'>): RoomMessage {
    return this.transaction(() => {
      if (!input.room.trim() || !input.from.trim() || !input.body.trim()) throw new Error('Room, sender and body are required');
      if (input.replyTo !== undefined) {
        const parent = this.db.prepare('SELECT room FROM messages WHERE id=?').get(input.replyTo) as { room: string } | undefined;
        if (!parent || parent.room !== input.room) throw new Error('Reply must refer to a message in the same room');
      }
      const createdAt = Date.now();
      const result = this.db.prepare('INSERT INTO messages(room,sender,recipient,reply_to,body,created_at,job_id) VALUES(?,?,?,?,?,?,?)')
        .run(input.room, input.from, input.to ?? null, input.replyTo ?? null, input.body.slice(0, 32_000), createdAt, input.jobId ?? null);
      return { ...input, body: input.body.slice(0, 32_000), id: Number(result.lastInsertRowid), createdAt };
    });
  }
  readMessages(room: string, reader: string, options: { unread?: boolean; limit?: number; after?: number } = {}): RoomMessage[] {
    const cursor = this.db.prepare('SELECT last_id FROM cursors WHERE room=? AND reader=?').get(room, reader) as { last_id: number } | undefined;
    const after = options.after ?? (options.unread ? cursor?.last_id ?? 0 : 0);
    const rows = this.db.prepare('SELECT * FROM messages WHERE room=? AND id>? AND (recipient IS NULL OR recipient=? OR sender=?) ORDER BY id LIMIT ?')
      .all(room, after, reader, reader, Math.max(1, Math.min(100, options.limit ?? 30))) as Record<string, string | number | null>[];
    return rows.map((row) => ({ id: Number(row.id), room: String(row.room), from: String(row.sender), to: row.recipient === null ? undefined : String(row.recipient),
      replyTo: row.reply_to === null ? undefined : Number(row.reply_to), body: String(row.body), createdAt: Number(row.created_at), jobId: row.job_id === null ? undefined : String(row.job_id) }));
  }
  markRead(room: string, reader: string, throughId: number): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT max(id) AS last_id FROM messages WHERE room=? AND (recipient IS NULL OR recipient=? OR sender=?)').get(room, reader, reader) as { last_id: number | null };
      if (throughId > (row.last_id ?? 0)) throw new Error('Read cursor cannot skip messages that do not exist yet');
      this.db.prepare('INSERT INTO cursors(room,reader,last_id) VALUES(?,?,?) ON CONFLICT(room,reader) DO UPDATE SET last_id=max(last_id,excluded.last_id)')
        .run(room, reader, Math.max(0, throughId));
    });
  }
}

/** Classify interrupted work at startup without manufacturing project state in a workspace that
 * has never used collaboration. Opening SQLite creates the database, schema, and `.shadow/`
 * directory, so the absence check must happen before constructing JobStore. Tool calls still use
 * `new JobStore(...)` directly and create the store on first real scheduler use. */
export function recoverOrphanJobsIfPresent(workspaceRoot: string): string[] {
  const path = resolveWithin(workspaceRoot, '.shadow/jobs.sqlite');
  if (!existsSync(path)) return [];
  const store = new JobStore(workspaceRoot);
  try {
    return store.recoverOrphans();
  } finally {
    store.close();
  }
}
