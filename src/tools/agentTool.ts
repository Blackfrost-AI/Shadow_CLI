import { z } from 'zod';
import { AgentLoop } from '../agent/loop.js';
import type { LoopDeps } from '../agent/loop.js';
import { Context } from '../agent/context.js';
import { Budget } from '../agent/budget.js';
import type { PriceTable } from '../agent/budget.js';
import type { AutonomyLevel } from '../safety/permissions.js';
import type { Tool } from './types.js';
import { ok, fail } from './types.js';
import { resolveAgentDef } from '../agent/defs.js';
import { ToolRegistry } from './registry.js';
import { createWorktree, removeWorktree } from './worktree.js';
import { runHookPhase } from '../hooks/runner.js';

const inputSchema = z.object({
  prompt: z.string().min(1).describe('Task for the sub-agent.'),
  description: z.string().optional().describe('Short description of what the sub-agent will do.'),
  subagent_type: z.string().optional().describe('Agent type hint (general-purpose default).'),
  // Claude parity fields (wired: isolation worktree + run_in_background with task-notification delivery)
  isolation: z.enum(['none', 'worktree']).optional(),
  run_in_background: z.boolean().optional(),
});

export interface AgentToolDeps {
  /** Per-invocation loop deps. MUST carry the session's live gate (not auto-approve) so a
   *  sub-agent is bound by the same permission posture as the main loop. */
  makeLoopDeps: () => LoopDeps;
  /** The session's CURRENT autonomy at invocation time — a sub-agent inherits it, never escalates. */
  getAutonomy: () => AutonomyLevel;
  contextBudget: number;
  triggerRatio: number;
  keepLastTurns: number;
  maxIterations: number;
  priceTable: PriceTable;
}

/** Claude Agent tool parity — isolated sub-loop with fresh context, returns final answer.
 * Supports isolation:'worktree' (real git worktree or fallback dir for sub workspaceRoot).
 * run_in_background accepted in schema; impl in bg step.
 */
export function makeAgentTool(deps: AgentToolDeps): Tool<z.infer<typeof inputSchema>, { answer?: string; taskId?: string; status?: string }> {
  return {
    name: 'agent',
    description:
      'Launch a sub-agent for complex multi-step work in an isolated context. Returns the sub-agent final answer. ' +
      'Use for parallelizable exploration, review, or scale. Do not duplicate work you already delegated. ' +
      'isolation:"worktree" gives the sub-agent its own git worktree (auto-cleaned after). ' +
      'run_in_background:true for long-running; watch <task-notification>. Choose subagent_type like "explore" or "reviewer" (or custom). Follow orchestration rules in your profile.',
    risk: 'read',
    inputSchema,
    async run(input, ctx) {
      const start = Date.now();
      if (ctx.signal.aborted) {
        return fail('agent', 'read', Date.now() - start, 'aborted', 'Sub-agent aborted.');
      }
      const base = deps.makeLoopDeps();
      const agentType = input.subagent_type ?? 'general-purpose';
      const def = resolveAgentDef(agentType, ctx.workspaceRoot);

      let subWorkspaceRoot = ctx.workspaceRoot;
      let worktreeCleanupPath: string | null = null;

      if (input.isolation === 'worktree') {
        const wtId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const wt = createWorktree(ctx.workspaceRoot, wtId);
        subWorkspaceRoot = wt.path;
        worktreeCleanupPath = wt.path;
      }

      const subContext = new Context({
        contextBudget: deps.contextBudget,
        triggerRatio: deps.triggerRatio,
        keepLastTurns: deps.keepLastTurns,
      });
      const systemPrefix = def?.systemPrompt ? `${def.systemPrompt}\n\n` : '';
      subContext.pinTask({ role: 'user', content: [{ type: 'text', text: input.prompt }] });

      // A sub-agent MUST always keep at least one working backstop. `Math.min(deps.maxIterations, 15)`
      // yields 0 when the parent set maxIterations:0 ("unlimited"), which disabled EVERY Budget guard and
      // let a stuck sub-agent burn unbounded API cost. Clamp iterations to ≥1 AND always attach a
      // wall-clock ceiling so a runaway sub-agent can never run forever regardless of the iteration count.
      const maxIter = Math.max(1, def?.maxIterations || Math.min(deps.maxIterations || 15, 15));
      const budget = new Budget(
        { maxIterations: maxIter, maxWallClockSec: 30 * 60 },
        def?.model ?? base.model,
        deps.priceTable,
        Date.now(),
      );

      let registry = base.registry;
      if (def?.tools?.length) {
        const filtered = new ToolRegistry();
        for (const name of def.tools) {
          const tool = base.registry.get(name);
          if (tool) filtered.register(tool);
        }
        registry = filtered;
      }

      const loopDeps: LoopDeps = {
        ...base,
        registry,
        context: subContext,
        budget,
        signal: ctx.signal,
        system: systemPrefix + base.system,
        model: def?.model ?? base.model,
        workspaceRoot: subWorkspaceRoot,
        additionalRoots: base.additionalRoots, // ensure sub-agents inherit jail/sanbox state (full under yolo)
      };
      const loop = new AgentLoop(loopDeps, deps.getAutonomy());

      const isBg = !!input.run_in_background;
      const taskId = isBg ? `agent_${Date.now()}_${Math.random().toString(36).slice(2,8)}` : undefined;

      if (isBg) {
        // record launch metadata via bus to main context (the real persisted one in outer scope); base.context here is throwaway from makeLoopDeps
        base.bus.emit({ type: 'bg_agent_launched' as any, taskId: taskId!, prompt: input.prompt, subagentType: agentType });

        // fire and forget; deliver via bus as task_notification (main context listener will turn into user msg)
        (async () => {
          try {
            const res = await loop.run();
            if (base.hooks?.subagent_stop?.length) {
              runHookPhase('subagent_stop', base.hooks.subagent_stop, { workspaceRoot: subWorkspaceRoot, extra: { agentType, taskId, result: 'bg_done' } });
            }
            base.bus.emit({ type: 'task_notification', taskId: taskId!, answer: res.finalAnswer || '', fromSubagent: agentType });
          } catch (e) {
            if (base.hooks?.subagent_stop?.length) {
              runHookPhase('subagent_stop', base.hooks.subagent_stop, { workspaceRoot: subWorkspaceRoot, extra: { agentType, taskId, error: (e as Error).message } });
            }
            base.bus.emit({ type: 'task_notification', taskId: taskId!, answer: `agent bg error: ${(e as Error).message}`, fromSubagent: agentType });
          } finally {
            if (worktreeCleanupPath) {
              try { removeWorktree(ctx.workspaceRoot, worktreeCleanupPath); } catch {}
            }
          }
        })();
        return ok('agent', 'read', Date.now() - start, `Background agent started as ${taskId}. Results will arrive as task-notification.`, {
          taskId: taskId!,
          status: 'started',
        });
      }

      // sync path (default)
      try {
        const result = await loop.run();
        if (base.hooks?.subagent_stop?.length) {
          runHookPhase('subagent_stop', base.hooks.subagent_stop, { workspaceRoot: subWorkspaceRoot, extra: { agentType, result: 'done' } });
        }
        const data = { answer: result.finalAnswer };
        if (worktreeCleanupPath) {
          try { removeWorktree(ctx.workspaceRoot, worktreeCleanupPath); } catch {}
        }
        return ok('agent', 'read', Date.now() - start, result.finalAnswer || 'Sub-agent completed.', data);
      } catch (e) {
        if (base.hooks?.subagent_stop?.length) {
          runHookPhase('subagent_stop', base.hooks.subagent_stop, { workspaceRoot: subWorkspaceRoot, extra: { agentType, error: (e as Error).message } });
        }
        if (worktreeCleanupPath) {
          try { removeWorktree(ctx.workspaceRoot, worktreeCleanupPath); } catch {}
        }
        return fail('agent', 'read', Date.now() - start, 'agent_failed', (e as Error).message);
      }
    },
  };
}