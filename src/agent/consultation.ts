import { randomUUID } from 'node:crypto';
import { Context } from './context.js';
import { Budget } from './budget.js';
import type { ApprovalGate } from './approval.js';
import type { ShadowConfig } from '../config.js';
import type { Tool, ToolContext } from '../tools/types.js';
import type { AgentToolData, AgentToolInput } from '../tools/agentTool.js';
import type { ModelProfileIdentity, ModelProfileResolver } from './modelProfiles.js';
import type { SessionLog } from '../state/session.js';
import { redactString } from '../util/redact.js';
import { visitControlRecords } from '../state/controlJournal.js';
import { hydrateContext, serializeContext, type ContextSnapshotData } from '../state/snapshot.js';

export interface ConsultationSummary {
  id: string;
  title: string;
  profile?: string;
  status: 'ready' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  turns: number;
  taskId?: string;
  interrupted?: boolean;
}

export interface ConsultationRuntime {
  signal: AbortSignal;
  gate: ApprovalGate;
  parentBudget?: Budget;
  parentId?: string;
  /** Explicitly prepared durable retry to claim instead of creating a fresh job. */
  jobId?: string;
}

export interface ConsultationRequest {
  prompt: string;
  profile?: string;
  title?: string;
  /** Explicit material chosen by the caller, not implicit access to the lead's conversation. */
  scopedContext?: string;
}

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  path: string;
  line?: number;
  title: string;
  evidence: string;
}

export interface ConsultationResult extends ConsultationSummary {
  answer: string;
  ok: boolean;
  usage: { inputTokens: number; outputTokens: number; costUSD?: number; costKnown: boolean };
  findings?: ReviewFinding[];
  /** A parseable model report is still an opinion, never a successful test run. */
  verification: 'unverified';
}

interface RecordState {
  summary: ConsultationSummary;
  context: Context;
  budget: Budget;
  controller?: AbortController;
  gate?: ApprovalGate;
  model?: string;
  claimed?: boolean;
  usageIncomplete?: boolean;
}

/** Parse explicit review JSON without turning malformed or missing evidence into a pass. */
export function parseReviewFindings(answer: string): ReviewFinding[] | undefined {
  const fence = answer.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  try {
    const parsed: unknown = JSON.parse(fence?.[1] ?? answer);
    const findings = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed as { findings?: unknown }).findings : undefined;
    if (!Array.isArray(findings) || findings.length > 100) return undefined;
    const valid = findings.every((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as Partial<ReviewFinding>;
      return ['critical', 'high', 'medium', 'low', 'info'].includes(item.severity ?? '')
        && typeof item.path === 'string' && item.path.length > 0
        && typeof item.title === 'string' && item.title.length > 0
        && typeof item.evidence === 'string' && item.evidence.length > 0
        && (item.line === undefined || (Number.isInteger(item.line) && item.line > 0));
    });
    return valid ? findings.map((item: ReviewFinding) => ({
      severity: item.severity, path: redactString(item.path).slice(0, 500), line: item.line,
      title: redactString(item.title).slice(0, 300), evidence: redactString(item.evidence).slice(0, 4000),
    })) : undefined;
  } catch { return undefined; }
}

/** Read-only conversations use the native agent runner, its admission gate, permissions and jobs. */
export class ConsultationService {
  private records = new Map<string, RecordState>();
  private logPath = '';

  constructor(private options: {
    cfg: ShadowConfig;
    profiles: ModelProfileResolver;
    agent: () => Tool<AgentToolInput, AgentToolData>;
    workspaceRoot: string;
    additionalRoots?: string[];
    sessionLog: () => SessionLog;
  }) {}

  profiles(): ModelProfileIdentity[] { return this.options.profiles.list(); }
  list(): ConsultationSummary[] { this.syncSession(); return [...this.records.values()].map((record) => ({ ...record.summary })); }

  /** Resume/fork changes data ownership, never starts an unfinished worker. */
  adopt(log: SessionLog, sourcePath?: string): void {
    for (const record of this.records.values()) record.controller?.abort();
    this.records.clear();
    this.logPath = log.path;
    this.restore(sourcePath ?? log.path, new Set());
    if (sourcePath) {
      // Freeze the selected lineage. Later appends to the source must never leak into this resume.
      log.record({ kind: 'consultation_reset', version: 1 });
      for (const record of this.records.values()) this.persist(record, log);
    }
  }

  private syncSession(): void {
    const log = this.options.sessionLog();
    if (log.path !== this.logPath) this.adopt(log);
  }

  private restore(path: string, seen: Set<string>): void {
    if (seen.has(path) || seen.size >= 8) return;
    seen.add(path);
    visitControlRecords(path, ['consultation_snapshot', 'consultation_reset', 'resumed_from'], (event) => {
      if (event.kind === 'consultation_reset') { this.records.clear(); return; }
      if (event.kind === 'resumed_from' && typeof event.path === 'string') {
        this.records.clear();
        this.restore(event.path, seen);
        return;
      }
      const raw = event.data as { version?: number; summary?: ConsultationSummary; context?: ContextSnapshotData; model?: string; usageIncomplete?: boolean;
        spent?: { inputTokens: number; outputTokens: number; costUSD: number }; remaining?: { maxTotalTokens?: number; maxCostUSD?: number; maxWallClockSec?: number } } | undefined;
      if (raw?.version !== 1 || !raw.summary || typeof raw.summary.id !== 'string' || !raw.summary.id.startsWith('consult_')
        || typeof raw.summary.title !== 'string' || !raw.context || !Array.isArray(raw.context.messages)) return;
      try {
        const cfg = this.options.cfg;
        const spent = raw.spent ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
        const remaining = raw.remaining ?? {};
        const valid = [spent.inputTokens, spent.outputTokens, spent.costUSD, ...Object.values(remaining)].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
        if (!valid) return;
        const tighter = (a: number | undefined, b: number | undefined): number | undefined => a === undefined ? b : b === undefined ? a : Math.min(a, b);
        const budget = new Budget({ maxIterations: 0,
          maxTotalTokens: tighter(cfg.budget.maxTotalTokens, remaining.maxTotalTokens === undefined ? undefined : remaining.maxTotalTokens + spent.inputTokens + spent.outputTokens),
          maxCostUSD: tighter(cfg.budget.maxCostUSD, remaining.maxCostUSD === undefined ? undefined : remaining.maxCostUSD + spent.costUSD),
          maxWallClockSec: tighter(cfg.budget.maxWallClockSec, remaining.maxWallClockSec),
        }, raw.model ?? cfg.model, cfg.priceTable, Date.now());
        budget.accrueSubagent(spent);
        const interrupted = raw.summary.status === 'running';
        this.records.set(raw.summary.id, {
          summary: { ...raw.summary, ...(interrupted ? { status: 'ready', interrupted: true } : {}) },
          model: raw.model, budget, usageIncomplete: interrupted || raw.usageIncomplete === true,
          context: hydrateContext(raw.context, { contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
        });
      } catch { /* malformed historical context stays unavailable */ }
    });
  }

  private persist(record: RecordState, log = this.options.sessionLog()): void {
    log.record({ kind: 'consultation_snapshot', data: { version: 1, summary: record.summary, model: record.model, usageIncomplete: record.usageIncomplete,
      context: serializeContext(record.context),
      spent: { inputTokens: record.budget.totalInputTokens, outputTokens: record.budget.totalOutputTokens, costUSD: record.budget.totalCostUSD },
      remaining: record.budget.inheritableCeilings(Date.now()),
    } });
  }

  /** Only an admitted service request can supply a continuation to the agent tool. */
  continuation(id: string): { context: Context; profile?: string; gate?: ApprovalGate } | undefined {
    const record = this.records.get(id);
    if (!record?.controller || record.claimed) return undefined;
    record.claimed = true;
    return { context: record.context, profile: record.summary.profile, gate: record.gate };
  }

  cancel(id: string): boolean {
    const record = this.records.get(id);
    if (!record?.controller) return false;
    record.controller.abort();
    return true;
  }

  async start(request: ConsultationRequest, runtime: ConsultationRuntime): Promise<ConsultationResult> {
    this.syncSession();
    if (!request.prompt.trim()) throw new Error('A consultation needs a question.');
    const cfg = this.options.cfg;
    const id = `consult_${randomUUID().slice(0, 12)}`;
    const record: RecordState = {
      summary: { id, title: (request.title ?? request.prompt).trim().slice(0, 120), profile: request.profile ?? this.options.profiles.currentSelection(), status: 'ready', turns: 0 },
      context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
      budget: new Budget({ maxIterations: 0, ...cfg.budget, maxWallClockSec: cfg.budget.maxWallClockSec ?? 1800 }, cfg.model, cfg.priceTable, Date.now()),
    };
    this.records.set(id, record);
    const scoped = request.scopedContext?.trim();
    const prompt = scoped ? `${request.prompt}\n\nUser-selected review material:\n${scoped.slice(0, 64_000)}${scoped.length > 64_000 ? '\n[Selected material truncated at 64,000 characters]' : ''}` : request.prompt;
    return this.run(record, prompt, runtime);
  }

  async followUp(id: string, prompt: string, runtime: ConsultationRuntime): Promise<ConsultationResult> {
    this.syncSession();
    const record = this.records.get(id);
    if (!record) throw new Error(`Consultation ${id} is unavailable in this session. Start a new consultation.`);
    if (!prompt.trim()) throw new Error('A follow-up needs a question.');
    if (record.controller) throw new Error('This consultation is already running. Cancel it or wait for its answer.');
    return this.run(record, prompt, runtime);
  }

  private async run(record: RecordState, prompt: string, runtime: ConsultationRuntime): Promise<ConsultationResult> {
    runtime.signal.throwIfAborted();
    const remaining = record.budget.inheritableCeilings(Date.now());
    const callerRemaining = runtime.parentBudget?.inheritableCeilings(Date.now());
    if (record.usageIncomplete && [remaining.maxTotalTokens, remaining.maxCostUSD, callerRemaining?.maxTotalTokens, callerRemaining?.maxCostUSD].some((value) => value !== undefined)) {
      throw new Error('This interrupted consultation has unrecorded usage, so its hard token or dollar allowance cannot be verified. Start a new consultation with an explicit new budget.');
    }
    record.controller = new AbortController();
    record.gate = runtime.gate;
    record.summary.status = 'running';
    record.summary.interrupted = false;
    record.summary.turns++;
    const log = this.options.sessionLog();
    this.persist(record, log);
    const unwatch = log.onContextSnapshot(record.context, () => this.persist(record, log));
    // One invocation budget inherits BOTH the consultation's remaining allowance and the
    // caller's. The native agent accrues into it; finally rolls that exact spend up once.
    const invocation = new Budget({ maxIterations: 0 }, record.model ?? this.options.cfg.model, this.options.cfg.priceTable, Date.now());
    invocation.applyInheritedCeilings(record.budget.inheritableCeilings(Date.now()));
    if (runtime.parentBudget) invocation.applyInheritedCeilings(runtime.parentBudget.inheritableCeilings(Date.now()));
    const toolContext: ToolContext = {
      workspaceRoot: this.options.workspaceRoot, additionalRoots: this.options.additionalRoots,
      signal: AbortSignal.any([runtime.signal, record.controller.signal]), log: () => {}, dryRun: false,
      maxToolResultChars: this.options.cfg.maxToolResultChars,
      parentBudget: invocation, rootBudget: invocation, currentWorkId: runtime.parentId,
    };
    try {
      const result = await this.options.agent().run({
        prompt, description: `${record.summary.title} · ${record.summary.id}`,
        profile: record.summary.profile, consultation_id: record.summary.id, subagent_type: 'reviewer',
        job_id: runtime.jobId,
        require_priced_usage: this.options.cfg.budget.maxCostUSD !== undefined || runtime.parentBudget?.inheritableCeilings(Date.now()).maxCostUSD !== undefined,
      }, toolContext);
      const status = result.data?.status;
      record.summary.status = toolContext.signal.aborted ? 'cancelled'
        : status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled' ? status
          : result.ok ? 'completed' : 'failed';
      record.summary.taskId = result.data?.taskId;
      record.model = result.data?.model ?? record.model;
      const answer = result.data?.answer || result.summary || 'Consultation ended without a recorded answer.';
      const findings = parseReviewFindings(answer);
      const costKnown = !record.usageIncomplete && !!record.model && !!this.options.cfg.priceTable[record.model];
      const resultValue: ConsultationResult = {
        ...record.summary, answer, ok: record.summary.status === 'completed', verification: 'unverified', findings,
        usage: { inputTokens: record.budget.totalInputTokens + invocation.totalInputTokens,
          outputTokens: record.budget.totalOutputTokens + invocation.totalOutputTokens,
          ...(costKnown ? { costUSD: record.budget.totalCostUSD + invocation.totalCostUSD } : {}), costKnown },
      };
      this.options.sessionLog().record({ kind: 'consultation_result', consultation: resultValue });
      return resultValue;
    } catch (error) {
      record.summary.status = toolContext.signal.aborted ? 'cancelled' : 'failed';
      throw error;
    } finally {
      unwatch();
      const usage = { inputTokens: invocation.totalInputTokens, outputTokens: invocation.totalOutputTokens, costUSD: invocation.totalCostUSD };
      record.budget.accrueSubagent(usage);
      runtime.parentBudget?.accrueSubagent(usage);
      record.controller = undefined;
      record.gate = undefined;
      record.claimed = false;
      this.persist(record, log);
    }
  }
}
