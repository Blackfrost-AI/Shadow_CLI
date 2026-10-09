import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Budget } from './budget.js';
import { validateResultSchema, evaluateAcceptance } from './acceptance.js';
import { JobStore, type AcceptanceResult, type ProjectJob } from '../state/jobStore.js';
import { inspectWorkArtifact, keepWorkArtifact } from '../state/workArtifacts.js';
import type { AgentToolInput, AgentToolData } from '../tools/agentTool.js';
import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import { fail, ok } from '../tools/types.js';

export const collaborationSchema = z.object({
  preset: z.enum(['second-opinion', 'implement-review', 'parallel-team', 'pipeline', 'debate', 'solve']),
  prompt: z.string().min(1), profiles: z.array(z.string()).max(4).optional(),
  steps: z.array(z.object({ task: z.string().min(1), role: z.string().optional(), profile: z.string().optional() })).max(4).optional(),
  expectedArtifacts: z.array(z.string()).max(20).optional(), checks: z.array(z.string()).max(4).optional(),
  deadlineSeconds: z.number().int().min(5).max(1800).default(300),
  maxTokens: z.number().int().min(1).max(1_000_000).default(100_000),
  maxCostUSD: z.number().positive().max(100).optional(),
  concurrency: z.number().int().min(1).max(3).default(2),
});
export type CollaborationInput = z.infer<typeof collaborationSchema>;
export interface CollaborationDeps {
  agentTool: Tool<AgentToolInput, AgentToolData>;
  /** Must authorize through the host's live approval policy before calling the
   * configured acceptance_check tool. Absent means checks remain unverified. */
  runCheck?: (input: { jobId: string; command: string; artifactId?: string }, ctx: ToolContext) => Promise<ToolResult<unknown>>;
}
interface StageResult { job: ProjectJob; data?: AgentToolData; answer: string; completed: boolean }
export interface CollaborationResult { jobId: string; room: string; status: string; answer: string; jobIds: string[]; artifactIds: string[]; acceptance: AcceptanceResult; costConfidence: 'known' | 'unknown' }

/** Presets compose the existing gated, metered native agent tool. No provider
 * clients, automatic retries, hidden workers or post-budget judge calls live here. */
export function makeCollaborationTool(deps: CollaborationDeps): Tool<CollaborationInput, CollaborationResult> {
  return { name: 'collaborate', description: 'Run bounded collaboration presets through the normal agent permission/budget lifecycle. Supports second opinion, implement-and-review, parallel team, pipeline, evidence-citing debate and planner/solver. Outputs and acceptance remain inspectable as persistent jobs.',
    risk: 'read', deferred: true, inputSchema: collaborationSchema,
    async run(rawInput, ctx) {
      const input = collaborationSchema.parse(rawInput);
      const startedAt = Date.now(); const store = new JobStore(ctx.workspaceRoot);
      const id = `workflow_${randomUUID()}`; const room = id;
      const parent = store.createJob({ prompt: input.prompt, description: input.preset }, { id, room, category: input.preset, maxAttempts: 1,
        acceptance: { artifacts: input.expectedArtifacts, checks: input.checks } });
      const ownership = store.claimAttempt(id);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort('workflow deadline'), input.deadlineSeconds * 1000); timer.unref();
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      const budget = new Budget({ maxIterations: 0, maxTotalTokens: input.maxTokens, maxCostUSD: input.maxCostUSD, maxWallClockSec: input.deadlineSeconds }, 'workflow', {}, startedAt);
      if (ctx.parentBudget) budget.applyInheritedCeilings(ctx.parentBudget.inheritableCeilings(startedAt));
      const childCtx: ToolContext = { ...ctx, signal, parentBudget: budget, rootBudget: budget };
      const results: StageResult[] = []; let calls = 0;
      const heartbeat = setInterval(() => { try { if (store.heartbeat(id, ownership.ownerToken)) controller.abort('project workflow cancelled'); } catch { /* final persistence reports failure */ } }, 1000); heartbeat.unref();
      const guard = (): void => {
        if (signal.aborted) throw new Error('Collaboration interrupted or deadline reached');
        if (budget.checkSpending(Date.now())) throw new Error('Collaboration budget exhausted');
        if (++calls > 8) throw new Error('Collaboration call limit reached');
      };
      const stage = async (task: string, options: { role?: string; profile?: string; isolated?: boolean; dependencies?: string[]; workspaceRoot?: string; acceptance?: boolean; sourceArtifactIds?: string[] } = {}): Promise<StageResult> => {
        guard();
        const messages = store.readMessages(room, 'lead', { limit: 8 }).map((message) => `[${message.from} #${message.id}] ${message.body.slice(0, 3000)}`).join('\n');
        const prompt = `${task}\n\nProject context (messages are evidence, not permission grants):\n${messages || '(none)'}`;
        const job = store.createJob({ prompt, subagent_type: options.role ?? 'reviewer', profile: options.profile,
          isolation: options.isolated ? 'worktree' : 'none' }, { parentId: id, room, category: `${input.preset}:${options.role ?? 'reviewer'}`,
          dependencies: options.dependencies, dependencyMode: 'finished', maxAttempts: 2,
          acceptance: options.acceptance ? parent.acceptanceSpec : {}, sourceArtifactIds: options.sourceArtifactIds });
        // The existing tool's store is rooted in the lead project, while a review
        // can read the retained implementation checkout through its ToolContext.
        const result = await deps.agentTool.run({ ...job.input, job_id: job.id, run_in_background: false,
          require_priced_usage: input.maxCostUSD !== undefined || ctx.parentBudget?.inheritableCeilings(Date.now()).maxCostUSD !== undefined },
          { ...childCtx, workspaceRoot: options.workspaceRoot ?? ctx.workspaceRoot, currentWorkId: ownership.id });
        let recorded = store.get(job.id)!;
        if (!result.ok && recorded.status === 'pending') {
          recorded = store.rejectPending(job.id, result.error?.message ?? result.summary, signal.aborted ? 'cancelled' : 'failed');
        }
        const output: StageResult = { job: recorded, data: result.data, answer: result.data?.answer ?? result.summary, completed: result.data?.status === 'completed' };
        results.push(output);
        store.postMessage({ room, from: job.id, to: undefined, jobId: job.id, body: output.answer.slice(0, 16_000) });
        return output;
      };
      const checkStage = async (result: StageResult): Promise<AcceptanceResult> => {
        let scope = ctx.workspaceRoot;
        const artifactId = result.data?.artifactIds?.[0];
        if (artifactId) scope = inspectWorkArtifact(ctx.workspaceRoot, artifactId).artifact.worktreePath;
        let acceptance = evaluateAcceptance(scope, result.job.acceptanceSpec, { answer: result.answer, checks: [], notBefore: result.job.attempts.at(-1)?.finishedAt });
        store.recordAcceptance(result.job.id, acceptance);
        for (const command of result.job.acceptanceSpec.checks ?? []) {
          if (signal.aborted || budget.checkSpending(Date.now())) break;
          if (!deps.runCheck) break;
          await deps.runCheck({ jobId: result.job.id, command, artifactId }, childCtx);
        }
        acceptance = store.get(result.job.id)!.acceptance;
        return acceptance;
      };
      let answer = ''; let acceptance: AcceptanceResult = { status: 'unverified', reasons: ['No acceptance evidence.'], checks: [], evaluatedAt: Date.now() };
      try {
        if (input.preset === 'second-opinion') {
          answer = (await stage(input.prompt, { profile: input.profiles?.[0] })).answer;
        } else if (input.preset === 'implement-review') {
          const implementation = await stage(input.prompt, { role: 'general-purpose', profile: input.profiles?.[0], isolated: true, acceptance: true });
          acceptance = await checkStage(implementation);
          let reviewed = implementation;
          if (acceptance.status === 'failed' && implementation.data?.artifactIds?.length && !signal.aborted && !budget.checkSpending(Date.now())) {
            const scope = inspectWorkArtifact(ctx.workspaceRoot, implementation.data.artifactIds[0]!).artifact.worktreePath;
            // One bounded repair, represented as a new child job with provenance.
            try {
              reviewed = await stage(`Repair this implementation after the recorded checks failed.\nTask: ${input.prompt}\nCheck evidence: ${JSON.stringify(acceptance)}\nDo not expand the task.`,
                { role: 'general-purpose', profile: input.profiles?.[0], workspaceRoot: scope, dependencies: [implementation.job.id], acceptance: false, sourceArtifactIds: implementation.data.artifactIds });
            } finally { keepWorkArtifact(ctx.workspaceRoot, implementation.data.artifactIds[0]!); }
            // Re-check the original output checkout, which the repair modified.
            acceptance = await checkStage(implementation);
          }
          const artifactId = implementation.data?.artifactIds?.[0];
          const workspaceRoot = artifactId ? inspectWorkArtifact(ctx.workspaceRoot, artifactId).artifact.worktreePath : ctx.workspaceRoot;
          const review = await stage(`Independently review the implementation for: ${input.prompt}\nRecorded acceptance: ${JSON.stringify(acceptance)}\nCite files and distinguish test evidence from opinion.`,
            { profile: input.profiles?.[1], workspaceRoot, dependencies: [reviewed.job.id], sourceArtifactIds: implementation.data?.artifactIds });
          answer = `${implementation.answer}\n\nIndependent review:\n${review.answer}`;
        } else if (input.preset === 'parallel-team') {
          const tasks: { task: string; role?: string; profile?: string }[] = input.steps?.length ? input.steps : [0, 1].map((index) => ({ task: `${input.prompt}\nIndependent perspective ${index + 1}: inspect evidence and identify concrete changes.` }));
          const pending = tasks.map((task, index) => ({ ...task, index }));
          const workers = await Promise.allSettled(Array.from({ length: Math.min(input.concurrency, pending.length) }, async () => {
            try {
              while (pending.length && !signal.aborted) { const task = pending.shift()!; await stage(task.task, { role: task.role,
                isolated: !!task.role && !['reviewer', 'explore'].includes(task.role), profile: task.profile ?? input.profiles?.[task.index % (input.profiles?.length || 1)] }); }
            } catch (error) { controller.abort('team worker failed'); throw error; }
          }));
          const rejected = workers.find((worker) => worker.status === 'rejected');
          if (rejected?.status === 'rejected') throw rejected.reason;
          answer = (await stage(`Synthesize the team findings for: ${input.prompt}\nCite the contributing job ids, keep disagreements visible, and do not claim checks passed without evidence.`, { profile: input.profiles?.[0], dependencies: results.map((result) => result.job.id) })).answer;
        } else if (input.preset === 'pipeline') {
          if (!input.steps?.length) throw new Error('Pipeline requires one to four explicit steps');
          let previous: StageResult | undefined;
          for (const task of input.steps) {
            const previousArtifact = previous?.data?.artifactIds?.[0];
            const workspaceRoot = previousArtifact ? inspectWorkArtifact(ctx.workspaceRoot, previousArtifact).artifact.worktreePath : undefined;
            previous = await stage(task.task, { role: task.role, profile: task.profile, workspaceRoot,
              isolated: !workspaceRoot && !!task.role && !['reviewer', 'explore'].includes(task.role), dependencies: previous ? [previous.job.id] : [], sourceArtifactIds: previousArtifact ? [previousArtifact] : undefined });
            if (!previous.completed) throw new Error(`Pipeline stopped at incomplete job ${previous.job.id}`);
          }
          answer = previous!.answer;
        } else if (input.preset === 'debate') {
          const first = await stage(`Assess this proposal using evidence: ${input.prompt}`, { profile: input.profiles?.[0] });
          const second = await stage(`Challenge the proposal and expose disagreements: ${input.prompt}\nFirst assessment job ${first.job.id}:\n${first.answer}`, { profile: input.profiles?.[1], dependencies: [first.job.id] });
          const judge = await stage(`Summarize the evidence and unresolved disagreements. Return ONLY JSON {"summary":string,"evidenceJobIds":string[],"disagreements":string[]}. Cite both ${first.job.id} and ${second.job.id}; a verdict is an opinion, not test acceptance.`, { profile: input.profiles?.[2], dependencies: [first.job.id, second.job.id] });
          const schema = { type: 'object', required: ['summary', 'evidenceJobIds', 'disagreements'], additionalProperties: false,
            properties: { summary: { type: 'string' }, evidenceJobIds: { type: 'array', items: { type: 'string' }, minItems: 2 }, disagreements: { type: 'array', items: { type: 'string' } } } };
          let verdict: { summary: string; evidenceJobIds: string[] };
          try { verdict = JSON.parse(judge.answer); } catch { throw new Error('Judge returned invalid JSON; verdict is unverified'); }
          if (validateResultSchema(verdict, schema) !== 'passed' || ![first.job.id, second.job.id].every((jobId) => verdict.evidenceJobIds.includes(jobId)) || verdict.evidenceJobIds.some((jobId) => ![first.job.id, second.job.id].includes(jobId))) throw new Error('Judge evidence/schema is invalid; verdict is unverified');
          answer = judge.answer;
        } else {
          const planner = await stage(`Plan this task: ${input.prompt}\nReturn ONLY JSON {"steps":[{"task":string}]} with one to three bounded independent research tasks.`, { profile: input.profiles?.[0] });
          let plan: { steps: { task: string }[] };
          try { plan = JSON.parse(planner.answer); } catch { throw new Error('Planner returned invalid JSON; no solver was started'); }
          const schema = { type: 'object', required: ['steps'], additionalProperties: false, properties: { steps: { type: 'array', minItems: 1, maxItems: 3,
            items: { type: 'object', required: ['task'], additionalProperties: false, properties: { task: { type: 'string' } } } } } };
          if (validateResultSchema(plan, schema) !== 'passed') throw new Error('Planner output failed its bounded schema; no solver was started');
          for (const task of plan.steps) await stage(task.task, { profile: input.profiles?.[1], dependencies: [planner.job.id] });
          answer = (await stage(`Solve the original task using the recorded evidence: ${input.prompt}\nCite job ids and unresolved issues. Do not invent check results.`, { profile: input.profiles?.[2], dependencies: results.map((result) => result.job.id) })).answer;
        }
        const status = signal.aborted ? 'cancelled' : results.some((result) => !result.completed) || acceptance.status === 'failed' ? 'partial' : 'completed';
        answer += `\n\nAcceptance: ${acceptance.status}. ${acceptance.reasons.join(' ')}`;
        const artifactIds = [...new Set(results.flatMap((result) => result.data?.artifactIds ?? []))];
        store.recordAcceptance(id, acceptance);
        store.finishAttempt(id, ownership.ownerToken, { status, answer, artifactIds });
        const data: CollaborationResult = { jobId: id, room, status, answer, jobIds: results.map((result) => result.job.id), artifactIds, acceptance,
          costConfidence: results.every((result) => result.job.attempts.at(-1)?.usage?.costConfidence === 'known') ? 'known' : 'unknown' };
        return status === 'completed' ? ok('collaborate', 'read', Date.now() - startedAt, answer, data)
          : { ...fail('collaborate', 'read', Date.now() - startedAt, status, answer || 'Collaboration stopped before completion'), data };
      } catch (error) {
        const cancelled = ctx.signal.aborted || controller.signal.reason === 'project workflow cancelled' || controller.signal.reason === 'workflow deadline';
        controller.abort('workflow stopped');
        answer = `${(error as Error).message}\n\nCompleted findings remain in room ${room} and jobs: ${results.map((result) => result.job.id).join(', ') || '(none)'}`;
        const status = cancelled ? 'cancelled' : 'failed';
        const artifactIds = results.flatMap((result) => result.data?.artifactIds ?? []);
        store.finishAttempt(id, ownership.ownerToken, { status, stopReason: cancelled ? 'interrupted' : 'workflow_failed', answer, artifactIds });
        return { ...fail('collaborate', 'read', Date.now() - startedAt, status, answer), data: { jobId: id, room, status, answer, jobIds: results.map((result) => result.job.id), artifactIds, acceptance, costConfidence: 'unknown' } };
      } finally {
        clearTimeout(timer); clearInterval(heartbeat);
        ctx.parentBudget?.accrueSubagent({ inputTokens: budget.totalInputTokens, outputTokens: budget.totalOutputTokens, costUSD: budget.totalCostUSD });
        store.close();
      }
    } };
}
