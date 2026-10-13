import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveWithin } from '../safety/workspaceJail.js';
import { atomicWrite } from '../tools/util.js';
import type { ToolResult } from '../tools/types.js';
import type { RunShellData } from '../tools/runShell.js';
import { redactString } from '../util/redact.js';

const printable = z.string().refine((s) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s), 'Control characters are not allowed.');
export const checkProfileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
  title: printable.pipe(z.string().min(1).max(160)),
  command: printable.pipe(z.string().min(1).max(8000)),
  description: printable.pipe(z.string().max(1000)).optional(),
  timeoutMs: z.number().int().min(1).max(1_800_000).default(60_000),
}).strict();
export const checkProfilesSchema = z.object({
  version: z.literal(1),
  profiles: z.array(checkProfileSchema).max(100).refine((items) => new Set(items.map((p) => p.id)).size === items.length, 'Profile ids must be unique.'),
}).strict();
export type CheckProfile = z.infer<typeof checkProfileSchema>;
export type CheckStatus = 'passed' | 'failed' | 'not_run' | 'blocked' | 'cancelled';
export interface CheckRecord {
  version: 1; id: string; profileId: string; profileHash: string; command: string;
  status: CheckStatus; recordedAt: string; durationMs: number; exitCode: number | null;
  summary: string; stdout: string; stderr: string;
}
const checkRecordSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), profileId: z.string().max(64), profileHash: z.string().regex(/^[a-f0-9]{64}$/),
  command: z.string().max(8000), status: z.enum(['passed', 'failed', 'not_run', 'blocked', 'cancelled']), recordedAt: z.string().datetime(),
  durationMs: z.number().finite().nonnegative(), exitCode: z.number().int().nullable(), summary: z.string().max(4000),
  stdout: z.string().max(16_000), stderr: z.string().max(8000),
}).strict().refine((record) => record.status !== 'passed' || record.exitCode === 0, 'Passed evidence needs exit code 0.');
export interface CheckSelection { profile: CheckProfile; selected: boolean; status: CheckStatus; latest?: CheckRecord; }
export function checkProfileHash(profile: CheckProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

/** Workspace-local declarations are data, never startup commands. Only AgentLoop may execute them.
 * Selection is session state; persisted records are evidence, never permission grants. */
export class ProjectCheckStore {
  private selected = new Set<string>();
  private readonly current = new Map<string, CheckRecord>();
  private invalidated = new Set<string>();
  constructor(readonly workspaceRoot: string) {}

  get profilesPath(): string { return resolveWithin(this.workspaceRoot, '.shadow/checks.json'); }
  profiles(): CheckProfile[] {
    if (!existsSync(this.profilesPath)) return [];
    if (statSync(this.profilesPath).size > 256_000) throw new Error('Check profiles file exceeds 256 KB.');
    return checkProfilesSchema.parse(JSON.parse(readFileSync(this.profilesPath, 'utf8'))).profiles;
  }
  saveProfiles(value: unknown): void {
    const data = checkProfilesSchema.parse(value);
    const path = this.profilesPath;
    mkdirSync(resolveWithin(this.workspaceRoot, '.shadow'), { recursive: true, mode: 0o700 });
    atomicWrite(path, JSON.stringify(data, null, 2) + '\n', 0o600);
  }
  resolve(id: string): CheckProfile {
    const profile = this.profiles().find((p) => p.id === id);
    if (!profile) throw new Error(`Unknown check profile: ${id}`);
    return profile;
  }
  select(ids: string[]): CheckSelection[] {
    const profiles = this.profiles();
    for (const id of ids) if (!profiles.some((p) => p.id === id)) throw new Error(`Unknown check profile: ${id}`);
    this.selected = new Set(ids);
    return this.snapshot();
  }
  shellInput(profile: CheckProfile): { command: string; description: string; timeout_ms: number; run_in_background: false } {
    return { command: profile.command, description: `Check ${profile.id}: ${profile.title}`, timeout_ms: profile.timeoutMs, run_in_background: false };
  }
  /** Admitted mutations make session results unverified until checked again. Historical
   * records remain intact and are labeled with their timestamp, never presented as current proof. */
  invalidate(): void { for (const id of this.current.keys()) this.invalidated.add(id); }
  snapshot(): CheckSelection[] {
    return this.profiles().map((profile) => {
      const record = this.current.get(profile.id);
      const latest = record && record.profileHash === checkProfileHash(profile) ? { ...record } : undefined;
      return { profile, selected: this.selected.has(profile.id), status: latest && !this.invalidated.has(profile.id) ? latest.status : 'not_run', latest };
    });
  }
  record(profile: CheckProfile, result: ToolResult, dryRun = false): CheckRecord {
    const data = result.data as Partial<RunShellData> | undefined;
    const code = result.error?.code;
    const status: CheckStatus = dryRun ? 'not_run' : data?.aborted || code === 'aborted' || code === 'cancelled' ? 'cancelled'
      : result.ok && data?.exitCode === 0 ? 'passed' : code === 'nonzero_exit' || data?.timedOut ? 'failed' : 'blocked';
    const record: CheckRecord = {
      version: 1, id: randomUUID(), profileId: profile.id, profileHash: checkProfileHash(profile),
      command: redactString(profile.command), status, recordedAt: new Date().toISOString(), durationMs: result.meta.durationMs,
      exitCode: typeof data?.exitCode === 'number' ? data.exitCode : null,
      summary: redactString(result.summary).slice(0, 4000), stdout: redactString(data?.stdout ?? '').slice(-16_000), stderr: redactString(data?.stderr ?? '').slice(-8000),
    };
    this.current.set(profile.id, record);
    this.invalidated.delete(profile.id);
    // Save exact bounded local evidence, without overwriting any previous run.
    const dir = resolveWithin(this.workspaceRoot, '.shadow/check-results');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = resolveWithin(this.workspaceRoot, join(dir, `${record.id}.json`));
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { ...record };
  }
  /** Historical output is optional on-demand evidence. It never satisfies this session's checks. */
  history(limit = 30): CheckRecord[] {
    const dir = resolveWithin(this.workspaceRoot, '.shadow/check-results');
    if (!existsSync(dir)) return [];
    const records: CheckRecord[] = [];
    for (const name of readdirSync(dir).filter((n) => /^[a-f0-9-]{36}\.json$/.test(n)).slice(-500)) {
      try {
        const file = resolveWithin(this.workspaceRoot, join(dir, name));
        if (statSync(file).size > 64_000) continue;
        const value = checkRecordSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        records.push(value);
      } catch { /* A corrupt evidence file must not conceal healthy records. */ }
    }
    return records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).slice(0, Math.max(0, Math.min(100, limit)));
  }
  getRun(id: string): CheckRecord | undefined {
    if (!z.string().uuid().safeParse(id).success) return undefined;
    const file = resolveWithin(this.workspaceRoot, `.shadow/check-results/${id}.json`);
    if (!existsSync(file)) return undefined;
    if (statSync(file).size > 64_000) throw new Error('Check evidence exceeds 64 KB.');
    const record = checkRecordSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (record.id !== id) throw new Error('Check evidence identity does not match its file.');
    return record;
  }
}
