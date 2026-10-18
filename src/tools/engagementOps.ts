// engagementOps.ts — Phase 2 redteam doctrine tool (engagement_ops).
//
// The F3EAD loop made durable: doctrine lives in ../security/engagement.ts as a
// pure state machine; this tool persists engagement records under
// .shadow/security/ (same directory and permissions class as the findings
// ledger) and exposes start/log/advance/close/report/status operations. Every
// action must name its F3EAD phase and carry an ATT&CK tactic/technique tag;
// the store refuses any transition the pure core rejects. Reports render the
// honest coverage picture, including zero-action phases.

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveWithin } from '../safety/workspaceJail.js';
import { redactString } from '../util/redact.js';
import {
  F3EAD_PHASES,
  type Engagement,
  type F3EADPhase,
  advancePhase,
  closeEngagement,
  engagementReport,
  logAction,
  startEngagement,
  validateActionPhase,
  validateEngagementSpec,
} from '../security/engagement.js';
import { fail, ok, type Tool } from './types.js';

const SCHEMA_VERSION = 1;
const MAX_OUTPUT_CHARS = 24000;
const NOTE = z.string().max(4000);

const schema = z
  .object({
    action: z.enum(['start', 'log', 'advance', 'close', 'report', 'status', 'show']),
    id: z.string().max(200).optional(),
    objective: z.string().max(500).optional(),
    scope: z.string().max(1000).optional(),
    successCriteria: z.string().max(500).optional(),
    phase: z.enum(F3EAD_PHASES).optional(),
    title: z.string().max(500).optional(),
    note: NOTE.optional(),
    tactic: z.string().max(16).optional(),
    techniques: z.array(z.string().max(16)).max(50).optional(),
    status: z.enum(['complete', 'aborted']).optional(),
  })
  .strict();

const persistedActionSchema = z.object({
  at: z.string().datetime(),
  phase: z.enum(F3EAD_PHASES),
  title: z.string().max(500),
  note: z.string().max(4000),
  tactic: z.string().max(16),
  techniques: z.array(z.string().max(16)).max(50),
});

const persistedEngagementSchema = z.object({
  id: z.string().min(1).max(200),
  objective: z.string().min(1).max(500),
  scope: z.string().max(1000),
  successCriteria: z.string().min(1).max(500),
  status: z.enum(['planning', 'active', 'complete', 'aborted']),
  phaseIndex: z
    .number()
    .int()
    .min(0)
    .max(F3EAD_PHASES.length - 1),
  actions: z.array(persistedActionSchema).max(100_000),
  startedAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
});

/** Persistent engagement records. Schema v1: one table, JSON bodies keyed by id. */
export class EngagementStore {
  private db: DatabaseSync;
  constructor(private readonly workspace: string) {
    const dir = resolveWithin(workspace, '.shadow/security');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = resolveWithin(workspace, '.shadow/security/engagements.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error('Engagement database is newer than this Shadow version.');
    }
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS engagements (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=1;',
    );
    for (const suffix of ['-wal', '-shm']) {
      try {
        chmodSync(path + suffix, 0o600);
      } catch {
        /* lazily created */
      }
    }
  }
  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private parse(data: string): Engagement {
    return persistedEngagementSchema.parse(JSON.parse(data)) as Engagement;
  }

  list(): { id: string; status: string; phase: string; objective: string }[] {
    const rows = this.db.prepare('SELECT id,data FROM engagements ORDER BY id').all() as {
      id: string;
      data: string;
    }[];
    return rows.map((row) => {
      const e = this.parse(row.data);
      if (e.id !== row.id) throw new Error(`Engagement row ${row.id} contains mismatched id ${e.id}.`);
      return {
        id: e.id,
        status: e.status,
        phase: F3EAD_PHASES[e.phaseIndex] ?? '?',
        objective: e.objective,
      };
    });
  }
  get(id: string): Engagement {
    const row = this.db.prepare('SELECT data FROM engagements WHERE id=?').get(id) as
      | { data: string }
      | undefined;
    if (!row) throw new Error(`Unknown engagement: ${id}`);
    const engagement = this.parse(row.data);
    if (engagement.id !== id) throw new Error(`Engagement row ${id} contains mismatched id ${engagement.id}.`);
    return engagement;
  }
  private save(engagement: Engagement): void {
    const data = JSON.stringify(persistedEngagementSchema.parse(engagement));
    const result = this.db
      .prepare('UPDATE engagements SET data=? WHERE id=?')
      .run(data, engagement.id);
    if (result.changes !== 1) throw new Error(`Unknown engagement: ${engagement.id}`);
  }

  start(input: { objective?: string; scope?: string; successCriteria?: string }): Engagement {
    const spec = validateEngagementSpec({
      objective: redactString(input.objective ?? ''),
      scope: redactString(input.scope ?? ''),
      successCriteria: redactString(input.successCriteria ?? ''),
    });
    const engagement = { ...startEngagement(spec), id: `engagement_${randomUUID()}` };
    const data = JSON.stringify(persistedEngagementSchema.parse(engagement));
    this.db
      .prepare('INSERT INTO engagements(id,data) VALUES (?,?)')
      .run(engagement.id, data);
    return engagement;
  }

  log(
    id: string,
    action: {
      phase: F3EADPhase;
      title?: string;
      note?: string;
      tactic: string;
      techniques?: string[];
    },
  ): Engagement {
    validateActionPhase({
      phase: action.phase,
      tactic: action.tactic,
      techniques: action.techniques ?? [],
    });
    return this.transaction(() => {
      const current = this.get(id);
      const next = logAction(current, {
        phase: action.phase,
        title: redactString(action.title ?? ''),
        note: redactString(action.note ?? ''),
        tactic: action.tactic,
        techniques: action.techniques,
      });
      this.save(next);
      return next;
    });
  }

  advance(id: string): Engagement {
    return this.transaction(() => {
      const next = advancePhase(this.get(id));
      this.save(next);
      return next;
    });
  }

  closeEngagement(id: string, status: 'complete' | 'aborted'): Engagement {
    return this.transaction(() => {
      const next = closeEngagement(this.get(id), status);
      this.save(next);
      return next;
    });
  }
}

export type EngagementOpsInput = z.infer<typeof schema>;

export const engagementOps: Tool<EngagementOpsInput> = {
  name: 'engagement_ops',
  risk: 'write',
  deferred: true,
  searchAliases: [
    'engagement', 'redteam', 'red team', 'pentest', 'penetration', 'offensive',
    'operation', 'campaign', 'f3ead', 'find', 'fix', 'finish', 'exploit', 'finish',
    'track', 'tracking', 'status', 'authorization', 'scope', 'rules of engagement',
    'objective', 'task', 'phase', 'kill chain', 'attack', 'surface', 'mitre', 'tactic',
    'technique', 'adversary', 'threat actor',
  ],
  inputSchema: schema,
  description:
    'Run an offensive engagement under F3EAD targeting doctrine (Find → Fix → Finish → Exploit → Analyze → Disseminate). Start requires an objective and success criteria. Every logged action declares its phase and carries an ATT&CK tactic/technique tag; phases advance only after the current phase has logged actions, and the final report shows per-phase and per-tactic coverage including gaps. Persistence and reporting only — this tool never touches targets, executes commands, or sends data.',
  async run(input, ctx) {
    const require = (value: string | undefined, name: string): string => {
      if (!value) throw new Error(`${input.action} requires ${name}.`);
      return value;
    };
    // Even opening the store can create a database/WAL, and report writes an artifact.
    // Honor the write-tool dry-run contract before constructing any persistence layer.
    if (ctx.dryRun) {
      return ok(
        'engagement_ops',
        'write',
        0,
        `Dry run: would ${input.action} an engagement record.`,
      );
    }
    let store: EngagementStore | undefined;
    try {
      ctx.signal?.throwIfAborted();
      store = new EngagementStore(ctx.workspaceRoot);
      let data: unknown;
      switch (input.action) {
        case 'start': {
          data = store.start({
            objective: input.objective,
            scope: input.scope,
            successCriteria: input.successCriteria,
          });
          break;
        }
        case 'log': {
          data = store.log(require(input.id, 'id'), {
            phase: require(input.phase, 'phase') as F3EADPhase,
            title: input.title,
            note: input.note,
            tactic: require(input.tactic, 'tactic'),
            techniques: input.techniques,
          });
          break;
        }
        case 'advance': {
          data = store.advance(require(input.id, 'id'));
          break;
        }
        case 'close': {
          data = store.closeEngagement(
            require(input.id, 'id'),
            require(input.status, 'status (complete|aborted)') as 'complete' | 'aborted',
          );
          break;
        }
        case 'report': {
          const engagement = store.get(require(input.id, 'id'));
          const text = engagementReport(engagement);
          const dir = resolveWithin(ctx.workspaceRoot, '.shadow/security/reports');
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const path = resolveWithin(
            ctx.workspaceRoot,
            `.shadow/security/reports/engagement-${randomUUID()}.md`,
          );
          writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
          data = { path, preview: text.slice(0, MAX_OUTPUT_CHARS) };
          break;
        }
        case 'status': {
          data = { engagements: store.list() };
          break;
        }
        case 'show': {
          data = store.get(require(input.id, 'id'));
          break;
        }
      }
      return ok(
        'engagement_ops',
        'write',
        0,
        JSON.stringify(data, null, 2).slice(0, MAX_OUTPUT_CHARS),
        data,
      );
    } catch (error) {
      return fail('engagement_ops', 'write', 0, 'engagement_error', (error as Error).message);
    } finally {
      store?.close();
    }
  },
};
