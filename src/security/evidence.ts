import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { resolveWithin } from '../safety/workspaceJail.js';
import { redactString } from '../util/redact.js';
import type { ProjectCheckStore } from '../checks/store.js';

const text = z.string().max(16000);
export const findingInputSchema = z.object({
  title: z.string().min(1).max(500), description: text.default(''), rule: z.string().max(500).default('manual'),
  source: z.string().max(500).default('operator'), path: z.string().max(2000).default(''),
  line: z.number().int().min(1).optional(), severity: z.enum(['error', 'warning', 'note', 'none']).default('warning'),
}).strict();
export type FindingInput = z.infer<typeof findingInputSchema>;
export type FindingStatus = 'open' | 'triaged' | 'remediated' | 'verified' | 'accepted';
export interface FindingEvent { at: string; kind: string; note: string; evidence?: { path: string; sha256: string; bytes: number }; checkId?: string }
export interface SecurityFinding extends FindingInput { id: string; fingerprint: string; status: FindingStatus; createdAt: string; updatedAt: string; occurrences: number; history: FindingEvent[] }
export interface FindingRetest { id: string; passed: boolean; command: string; recordedAt: number; scope: string }

/** Only live host-recorded results can advance verification. Workspace JSON is inspectable
 * historical evidence, not authority to manufacture a passing retest. File edits and profile
 * changes invalidate current results through ProjectCheckStore.snapshot(). */
export function currentFindingRetest(store: ProjectCheckStore, checkId: string): FindingRetest {
  const current = store.snapshot().find((entry) => entry.latest?.id === checkId);
  if (!current?.latest || current.status === 'not_run') {
    throw new Error('Retest requires a current check executed in this Shadow session after the latest changes. Run /checks again; historical or imported result files cannot verify a finding.');
  }
  return { id: current.latest.id, passed: current.status === 'passed' && current.latest.exitCode === 0,
    command: current.latest.command, recordedAt: Date.parse(current.latest.recordedAt), scope: store.workspaceRoot };
}
function clean(value: string): string { return redactString(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ''); }
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function markdown(value: string): string { return clean(value).replace(/([\\`*_{}[\]<>#|])/g, '\\$1'); }

/** Local findings, histories and scope. A finding is a recorded claim until a
 * separately executed check provides evidence; importing a scanner result is not a retest. */
export class EvidenceStore {
  private db: DatabaseSync;
  constructor(readonly workspace: string) {
    const dir = resolveWithin(workspace, '.shadow/security'); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = resolveWithin(workspace, '.shadow/security/findings.sqlite');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) { this.db.close(); throw new Error('Security evidence database is newer than this Shadow version.'); }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;');
    for (const suffix of ['-wal', '-shm']) { try { chmodSync(path + suffix, 0o600); } catch { /* lazily created */ } }
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(): SecurityFinding[] {
    return (this.db.prepare('SELECT data FROM findings ORDER BY id').all() as { data: string }[]).map((row) => JSON.parse(row.data) as SecurityFinding);
  }
  get(id: string): SecurityFinding {
    const row = this.db.prepare('SELECT data FROM findings WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new Error(`Unknown finding: ${id}`); return JSON.parse(row.data) as SecurityFinding;
  }
  private save(finding: SecurityFinding): SecurityFinding {
    finding.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE findings SET data=? WHERE id=?').run(JSON.stringify(finding), finding.id); return finding;
  }
  scope(value?: string): string {
    if (value !== undefined) { if (value.length > 16000) throw new Error('Scope is too long.'); this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('scope', clean(value)); }
    return (this.db.prepare('SELECT value FROM settings WHERE key=?').get('scope') as { value: string } | undefined)?.value ?? 'No assessment scope recorded.';
  }
  importFindings(inputs: FindingInput[]): { added: number; duplicates: number; ids: string[] } {
    if (inputs.length > 5000) throw new Error('Import is limited to 5,000 findings.');
    const parsed = inputs.map((input) => findingInputSchema.parse(input));
    return this.transaction(() => {
      let added = 0; let duplicates = 0; const ids: string[] = [];
      for (const raw of parsed) {
        const input = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? clean(value) : value])) as FindingInput;
        const fingerprint = digest(JSON.stringify([input.source, input.rule, input.path, input.line ?? 0, input.title]));
        const old = this.db.prepare('SELECT data FROM findings WHERE fingerprint=?').get(fingerprint) as { data: string } | undefined;
        if (old) {
          const finding = JSON.parse(old.data) as SecurityFinding; finding.occurrences++;
          // A repeated scanner result after verification reopens the issue instead of hiding it.
          if (finding.status === 'verified') finding.status = 'open';
          finding.history.push({ at: new Date().toISOString(), kind: 'observed-again', note: 'The same finding was imported again. Existing notes and evidence are retained.' });
          this.save(finding); duplicates++; ids.push(finding.id); continue;
        }
        const now = new Date().toISOString();
        const finding: SecurityFinding = { ...input, id: `finding_${randomUUID()}`, fingerprint, status: 'open', createdAt: now, updatedAt: now, occurrences: 1,
          history: [{ at: now, kind: 'imported', note: 'Recorded observation/claim; not independently verified by Shadow.' }] };
        this.db.prepare('INSERT INTO findings(id,fingerprint,data) VALUES (?,?,?)').run(finding.id, fingerprint, JSON.stringify(finding)); added++; ids.push(finding.id);
      }
      return { added, duplicates, ids };
    });
  }
  update(id: string, status: Exclude<FindingStatus, 'verified'>, note: string): SecurityFinding {
    if (!['open', 'triaged', 'remediated', 'accepted'].includes(status)) throw new Error('Verified status requires a recorded check.');
    if (!note.trim() || note.length > 16000) throw new Error('Supply a note (up to 16,000 characters).');
    return this.transaction(() => { const finding = this.get(id); finding.status = status; finding.history.push({ at: new Date().toISOString(), kind: status, note: clean(note) }); return this.save(finding); });
  }
  attach(id: string, relativePath: string, note: string): SecurityFinding {
    this.get(id);
    const source = resolveWithin(this.workspace, relativePath);
    if (!statSync(source).isFile() || statSync(source).size > 2 * 1024 * 1024) throw new Error('Evidence must be a local file under 2 MiB.');
    const raw = readFileSync(source); if (raw.includes(0)) throw new Error('Attach text evidence; binary artifacts are not copied into reports.');
    const bytes = Buffer.from(clean(raw.toString('utf8')));
    const path = `.shadow/security/evidence/${randomUUID()}.txt`;
    mkdirSync(resolveWithin(this.workspace, '.shadow/security/evidence'), { recursive: true, mode: 0o700 });
    writeFileSync(resolveWithin(this.workspace, path), bytes, { flag: 'wx', mode: 0o600 });
    return this.transaction(() => { const finding = this.get(id); finding.history.push({ at: new Date().toISOString(), kind: 'evidence', note: clean(note || relativePath), evidence: { path, sha256: digest(bytes), bytes: bytes.length } }); return this.save(finding); });
  }
  /** Only the host resolves an actual recorded check; model-supplied booleans are never accepted by the tool API. */
  retest(id: string, check: FindingRetest): SecurityFinding {
    if (realpathSync(check.scope) !== realpathSync(this.workspace)) throw new Error('A retest must run in this finding workspace.');
    return this.transaction(() => {
      const finding = this.get(id);
      if (!Number.isFinite(check.recordedAt) || check.recordedAt < Date.parse(finding.updatedAt)) throw new Error('Run the check after the latest finding update before attaching a retest.');
      finding.status = check.passed ? 'verified' : 'open';
      finding.history.push({ at: new Date().toISOString(), kind: 'retest', checkId: check.id,
        note: clean(`${check.passed ? 'Passed' : 'Failed'} configured check: ${check.command}. Scope: ${check.scope}. Check passage is evidence, not proof that every vulnerability is absent.`) });
      return this.save(finding);
    });
  }
  importFile(relativePath: string): { added: number; duplicates: number; ids: string[] } {
    const path = resolveWithin(this.workspace, relativePath);
    if (!statSync(path).isFile() || statSync(path).size > 5 * 1024 * 1024) throw new Error('Import must be a JSON/SARIF file under 5 MiB.');
    return this.importFindings(parseFindingImport(JSON.parse(readFileSync(path, 'utf8'))));
  }
  report(): string {
    return `# Security findings\n\nGenerated: ${new Date().toISOString()}\n\nScope: ${markdown(this.scope())}\n\nStatus reflects recorded observations and checks. Accepted risk is an operator disposition. Verified means the linked check passed; it is not a blanket security certification. Evidence bodies and raw transcripts are excluded.\n\n` +
      this.list().map((f) => `## ${markdown(f.title)}\n\nID: ${f.id}\n\n${f.severity} · ${f.status} · ${f.occurrences} observation(s)\n\nSource: ${markdown(f.source)} / ${markdown(f.rule)}\n\nLocation: ${markdown(f.path || '(not specified)')}${f.line ? ':' + f.line : ''}\n\n${markdown(f.description)}\n\n` +
        f.history.map((e) => `- ${e.at} — ${e.kind}: ${markdown(e.note)}${e.checkId ? ` (check ${markdown(e.checkId)})` : ''}${e.evidence ? ` (evidence ${e.evidence.path}, SHA-256 ${e.evidence.sha256})` : ''}`).join('\n')).join('\n\n');
  }
  exportReport(): string {
    mkdirSync(resolveWithin(this.workspace, '.shadow/security/reports'), { recursive: true, mode: 0o700 });
    const path = resolveWithin(this.workspace, `.shadow/security/reports/${randomUUID()}.md`);
    writeFileSync(path, this.report(), { flag: 'wx', mode: 0o600 }); return path;
  }
}

export function parseFindingImport(value: unknown): FindingInput[] {
  if (Array.isArray(value)) return z.array(findingInputSchema).max(5000).parse(value);
  const sarif = z.object({ version: z.literal('2.1.0'), runs: z.array(z.object({
    tool: z.object({ driver: z.object({ name: z.string().max(500) }) }),
    results: z.array(z.object({ ruleId: z.string().max(500).optional(), level: z.enum(['error', 'warning', 'note', 'none']).optional(),
      message: z.object({ text: text.optional(), markdown: text.optional() }),
      locations: z.array(z.object({ physicalLocation: z.object({ artifactLocation: z.object({ uri: z.string().max(2000) }).optional(), region: z.object({ startLine: z.number().int().min(1) }).optional() }).optional() })).max(100).optional(),
    })).max(5000).default([]),
  })).max(100) }).parse(value);
  const results = sarif.runs.flatMap((run) => run.results.map((result) => {
    const message = result.message.text ?? result.message.markdown ?? 'Scanner finding'; const location = result.locations?.[0]?.physicalLocation;
    return findingInputSchema.parse({ source: run.tool.driver.name, rule: result.ruleId ?? 'unknown', title: message.split('\n')[0]!.slice(0, 500) || 'Scanner finding', description: message,
      severity: result.level ?? 'warning', path: location?.artifactLocation?.uri ?? '', line: location?.region?.startLine });
  }));
  if (results.length > 5000) throw new Error('Import is limited to 5,000 findings.'); return results;
}
