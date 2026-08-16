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
import { SubagentBus } from '../agent/events.js';
import { Semaphore } from '../util/semaphore.js';

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
  /** F06-10: max sub-agents admitted at once (session-level semaphore). Default 4. */
  subagentConcurrency?: number;
}

/** Claude Agent tool parity — isolated sub-loop with fresh context, returns final answer.
 * Supports isolation:'worktree' (real git worktree or fallback dir for sub workspaceRoot).
 * run_in_background accepted in schema; impl in bg step.
 */
export function makeAgentTool(deps: AgentToolDeps): Tool<z.infer<typeof inputSchema>, { answer?: string; taskId?: string; status?: string }> {
  // F06-10: session-level admission gate. makeAgentTool is constructed ONCE per session (index.ts),
  // so a closure-scoped semaphore is exactly session-scoped — it survives /model switches (which
  // rebuild providers, not tools) and bounds ALL sub-agent loops, sync AND background: no more
  // unbounded parallel provider streams when a model fans out a fleet of `agent` calls in one turn.
  const semaphore = new Semaphore(deps.subagentConcurrency ?? 4);
  // P3-09 review fix (nested fan-out width): NESTED `agent` calls bypass the session semaphore —
  // the F06-10 deadlock guard below — but must not be UNBOUNDED in width: one sub-agent emitting
  // N agent calls in a single assistant message used to admit all N at once, each inheriting the
  // enclosing budget's FULL remaining ceilings (multiplicative N× overshoot against the tree's
  // maxCostUSD / maxTotalTokens, caught only after the fact). Each parent budget therefore gets
  // its OWN admission gate capping its concurrent children at the same subagentConcurrency.
  // Deadlock-free by construction: permits in a parent's gate are held only by that parent's
  // children, so a child only ever queues behind its own SIBLINGS — never its own lineage — and
  // queue waits are abortable like the session gate's.
  const nestedGates = new WeakMap<Budget, Semaphore>();
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

      const isBg = !!input.run_in_background;
      // Every sub-agent (sync OR bg) gets a unique taskId. It keys the sub-agent registry the TUI
      // surfaces in the HUD (BUG 3) and tags the forwarded tool events (SubagentBus.meta) so the UI
      // can tell a delegated agent's activity from the parent's own instead of clobbering the
      // parent's single live-tool row.
      const taskId = `agent_${Date.now()}_${Math.random().toString(36).slice(2,8)}${isBg ? '' : '_sync'}`;

      // A sub-agent gets its OWN bus that forwards only a whitelist to the parent. It used to be
      // handed `base.bus`, so its streamed answer, per-turn usage and `stop` were indistinguishable
      // from the parent's — the answer printed up to three times, the HUD flipped to the
      // sub-agent's context %, and /cost went to nonsense. See SUBAGENT_FORWARDED_EVENTS.
      const subBus = new SubagentBus(base.bus, undefined, { subagent: taskId });
      // F10-02 (cancellation half): a BACKGROUND agent outlives its launching turn, so ctx.signal
      // (the turn's signal) can no longer stop it. Give a bg agent its OWN abort, chained under
      // ctx.signal, that a `cancel_subagent` bus request (from /agents kill) can trip.
      const bgAbort = isBg ? new AbortController() : null;
      const loopDeps: LoopDeps = {
        ...base,
        bus: subBus,
        registry,
        context: subContext,
        budget,
        signal: bgAbort ? AbortSignal.any([ctx.signal, bgAbort.signal]) : ctx.signal,
        system: systemPrefix + base.system,
        model: def?.model ?? base.model,
        workspaceRoot: subWorkspaceRoot,
        additionalRoots: base.additionalRoots, // ensure sub-agents inherit jail/sanbox state (full under yolo)
        nestedAgent: true, // F06-10: tools of THIS loop run inside a sub-agent (admission bypass marker)
        // P3-09 (F04-08): thread the delegation tree's ROOT budget down to the sub-loop so a
        // background agent at ANY depth rolls its spend up into the turn/run budget even after
        // intermediate ancestors have finished (a top-level call's parent budget IS the root).
        rootBudget: ctx.rootBudget ?? ctx.parentBudget ?? undefined,
      };
      const loop = new AgentLoop(loopDeps, deps.getAutonomy());

      // F06-10 deadlock guard: a NESTED `agent` call (a sub-agent launching its own sub-agent)
      // bypasses the admission gate. The parent sits parked on this very tool result while still
      // holding ITS permit — if every slot is held by parked ancestors, a queued child would wait
      // behind its own lineage forever (budget checks never fire inside a tool await; headless
      // would simply hang). A parked ancestor is not streaming, so a chain is ONE active provider
      // stream: admitting the child separately would double-count it. Top-level fan-out — the
      // fleet-in-one-turn case the cap exists for — stays fully gated. P3-09 review fix: nested
      // calls no longer bypass the width cap entirely — they go through a per-PARENT gate (see
      // `gate` below) at the same subagentConcurrency, still deadlock-free.
      const nested = ctx.nestedAgent === true;

      // P3-09 (F04-08): the parent Budget — the loop running THIS call, stamped onto the ToolContext
      // as ctx.parentBudget. Before this, a sub-agent's Budget had NO token/cost ceilings at all and
      // its spend never accrued to the parent, so a fleet of sub-agents could burn unbounded cost
      // that the parent's maxCostUSD / maxTotalTokens never saw. Now:
      //   - at ADMISSION the sub-agent inherits the parent's REMAINING ceilings (tokens / cost /
      //     wall-clock); a zero remainder stops it at its first budget check, BEFORE any provider
      //     call — an exhausted parent cannot be spent past;
      //   - on EVERY exit path (done / cancelled / error) the sub-agent's TOTAL spend rolls up into
      //     the parent budget, so the parent's spending checks see the whole delegation tree.
      // Nested calls resolve to the enclosing sub-agent's OWN budget, so accrual chains upward one
      // level at a time and no level is ever counted twice.
      const parentBudget = ctx.parentBudget ?? null;
      // P3-09 review fix (nested fan-out width): the admission gate for THIS call. Top-level calls
      // use the session semaphore; NESTED calls bypass it (the deadlock guard above) but go through
      // a per-PARENT gate keyed by the parent's own budget, so a sub-agent fanning out a fleet of
      // its own is width-capped at subagentConcurrency instead of admitting the whole batch at
      // once. A nested call with no parent budget (test harnesses only) bypasses both gates.
      const gate = nested
        ? parentBudget
          ? nestedGates.get(parentBudget) ?? (() => {
              const g = new Semaphore(deps.subagentConcurrency ?? 4);
              nestedGates.set(parentBudget, g);
              return g;
            })()
          : null
        : semaphore;
      // Applied immediately before the loop runs (after any queue wait + clock restart) so the
      // wall-clock share reflects real remaining time. An axis the parent never configured inherits
      // none — the sub-agent keeps its own iteration cap + 30-minute wall-clock backstop there.
      const inheritCeilings = (): void => {
        if (parentBudget) budget.applyInheritedCeilings(parentBudget.inheritableCeilings(Date.now()));
      };
      // Roll this agent's TOTAL spend (own provider calls + nested sub-agents already rolled up)
      // into `target` — called on EVERY exit path; the spend is real whether the run ended done,
      // cancelled, or in error.
      const accrue = (target: Budget | null): void => {
        target?.accrueSubagent({
          inputTokens: budget.totalInputTokens,
          outputTokens: budget.totalOutputTokens,
          costUSD: budget.totalCostUSD,
        });
      };
      // P3-09 review fix (late-arriving bg spend): a BACKGROUND agent can outlive its immediate
      // parent loop — that is the point of background — so rolling its spend up into the parent
      // budget could land it in a budget that is already dead and never checked again (e.g. the
      // sync agent that spawned it has long since returned). A bg agent's spend instead rolls up
      // into the ROOT budget of the delegation tree — the turn/run budget, stamped as
      // ctx.rootBudget, alive for the whole turn/run. Sync agents keep rolling into their
      // immediate parent: it is alive for their whole run, and its finish-time roll-up carries
      // the combined total onward. No level is ever counted twice: the bg agent's own accrual is
      // its total, and the intermediate parent already accrued WITHOUT it.
      const bgAccrualTarget = ctx.rootBudget ?? parentBudget;

      if (isBg) {
        // record launch metadata via bus to main context (the real persisted one in outer scope); base.context here is throwaway from makeLoopDeps
        base.bus.emit({ type: 'bg_agent_launched' as any, taskId: taskId!, prompt: input.prompt, subagentType: agentType });
        // F06-10: take a permit up front so a fleet of bg launches cannot exceed the cap; when none
        // is free announce as QUEUED — admission then happens INSIDE the fire-and-forget below, so
        // a full semaphore never blocks the launching turn. Nested calls bypass (see `nested`).
        const bgPermit0 = gate ? gate.tryAcquire() : null;
        // surface the sub-agent in the TUI HUD immediately (BUG 3). `background:true` keeps it in
        // the panel after the launching turn ends (F10-02) instead of vanishing with the turn.
        // `queued` only when there IS a gate and no permit — a gateless call (nested with no
        // parent budget) never waits, so it must not announce as queued.
        base.bus.emit({ type: 'subagent_start', taskId, subagentType: agentType, description: input.description, background: true, queued: gate != null && bgPermit0 == null });

        // Listen for a cancel request aimed at THIS agent (taskId or the '*' wildcard). The abort
        // stops the sub-loop at its next boundary; unsubscribed in finally so a completed agent's id
        // can't be re-triggered.
        const offCancel = base.bus.on((e) => {
          if (e.type === 'cancel_subagent' && (e.taskId === taskId || e.taskId === '*')) bgAbort?.abort('cancelled');
        });

        // fire and forget; deliver via bus as task_notification (main context listener will turn into user msg)
        (async () => {
          let permit = bgPermit0;
          try {
            if (gate && !permit) {
              // loopDeps.signal = turn abort OR /agents-kill cancellation — either one must be able
              // to dequeue an agent that never got a slot (a cancelled turn cannot leak a permit).
              permit = await gate.acquire(loopDeps.signal);
              // F06-10: queue wait is not loop time — restart the wall-clock budget at admission.
              budget.restartClock(Date.now());
              // admitted — re-announce with queued cleared (nothing has run yet, so re-registration
              // is safe: the HUD counters for this taskId are still zero).
              base.bus.emit({ type: 'subagent_start', taskId, subagentType: agentType, description: input.description, background: true });
            }
            inheritCeilings(); // P3-09: admission point — parent's remaining ceilings become this agent's
            const res = await loop.run();
            // P3-09: roll the spend up even if the run ended in error/cancel — it was still spent.
            // Bg target: the ROOT budget (see bgAccrualTarget) — this agent can outlive its parent.
            accrue(bgAccrualTarget);
            // A cancelled bg agent returns via stop('interrupted') (it does NOT throw), so report it
            // as cancelled (ok:false) rather than a spurious "done" with a partial answer.
            const cancelled = res.stopReason === 'interrupted';
            // P3-09: a ceiling-stopped agent must not masquerade as a completed one — say what stopped it.
            const budgetStopped = res.stopReason === 'budget' || res.stopReason === 'max_iterations';
            if (base.hooks?.subagent_stop?.length) {
              runHookPhase('subagent_stop', base.hooks.subagent_stop, { workspaceRoot: subWorkspaceRoot, extra: { agentType, taskId, result: cancelled ? 'bg_cancelled' : 'bg_done' } });
            }
            { const snap = budget.snapshot(Date.now()); base.bus.emit({ type: 'subagent_usage', costUSD: budget.currentCostUSD, subagent: agentType, taskId, inputTokens: snap.inputTokens, outputTokens: snap.outputTokens }); }
            base.bus.emit({ type: 'subagent_end', taskId, ok: !cancelled, subagentType: agentType });
            base.bus.emit({
              type: 'task_notification',
              taskId: taskId!,
              answer: cancelled
                ? 'agent cancelled by user'
                : res.finalAnswer || (budgetStopped ? `agent stopped by its ${res.stopReason} ceiling before producing an answer` : ''),
              fromSubagent: agentType,
            });
          } catch (e) {
            accrue(bgAccrualTarget); // P3-09: a thrown run still spent tokens/cost — roll it up.
            if (base.hooks?.subagent_stop?.length) {
              runHookPhase('subagent_stop', base.hooks.subagent_stop, { workspaceRoot: subWorkspaceRoot, extra: { agentType, taskId, error: (e as Error).message } });
            }
            base.bus.emit({ type: 'subagent_end', taskId, ok: false, subagentType: agentType });
            const queuedAbort = (e as Error).message === 'aborted while queued';
            base.bus.emit({ type: 'task_notification', taskId: taskId!, answer: queuedAbort ? 'agent cancelled while waiting for a slot' : `agent bg error: ${(e as Error).message}`, fromSubagent: agentType });
          } finally {
            permit?.();
            offCancel();
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
      // F06-10: admission via the session semaphore. Announce immediately so the HUD shows the
      // agent; when no permit is free, announce as QUEUED and wait. On admission re-announce —
      // safe because nothing has run yet (the HUD counters for this taskId are still zero).
      // Nested calls use the per-parent gate instead of the session semaphore (see `gate` above).
      const permit0 = gate ? gate.tryAcquire() : null;
      // surface the sub-agent in the TUI HUD immediately (BUG 3). `queued` only when there IS a
      // gate and no permit — a gateless call (nested with no parent budget) never waits.
      base.bus.emit({ type: 'subagent_start', taskId, subagentType: agentType, description: input.description, background: false, queued: gate != null && permit0 == null });
      let permit = permit0;
      if (gate && !permit) {
        try {
          permit = await gate.acquire(loopDeps.signal);
          // F06-10: queue wait is not loop time — restart the wall-clock budget at admission.
          budget.restartClock(Date.now());
        } catch {
          // aborted while queued — the agent never ran: no stop hook, but the HUD row and any
          // worktree still need cleanup, and the slot wait must not leak a fail report.
          base.bus.emit({ type: 'subagent_end', taskId, ok: false, subagentType: agentType });
          if (worktreeCleanupPath) {
            try { removeWorktree(ctx.workspaceRoot, worktreeCleanupPath); } catch {}
          }
          return fail('agent', 'read', Date.now() - start, 'aborted', 'Sub-agent aborted while queued.');
        }
        base.bus.emit({ type: 'subagent_start', taskId, subagentType: agentType, description: input.description, background: false });
      }
      try {
        inheritCeilings(); // P3-09: admission point — parent's remaining ceilings become this agent's
        const result = await loop.run();
        // P3-09: roll the spend up even if the run ended in error/cancel — it was still spent.
        // Sync target: the IMMEDIATE parent budget — alive for this agent's whole run, and its own
        // finish-time roll-up carries the combined total onward.
        accrue(parentBudget);
        if (base.hooks?.subagent_stop?.length) {
          runHookPhase('subagent_stop', base.hooks.subagent_stop, { workspaceRoot: subWorkspaceRoot, extra: { agentType, result: 'done' } });
        }
        // The sub-agent's per-turn `usage` events are (correctly) not forwarded, so report its
        // TOTAL spend once — otherwise sub-agent tokens would silently vanish from /cost.
        { const snap = budget.snapshot(Date.now()); base.bus.emit({ type: 'subagent_usage', costUSD: budget.currentCostUSD, subagent: agentType, taskId, inputTokens: snap.inputTokens, outputTokens: snap.outputTokens }); }
        base.bus.emit({ type: 'subagent_end', taskId, ok: true, subagentType: agentType });
        const data = { answer: result.finalAnswer };
        if (worktreeCleanupPath) {
          try { removeWorktree(ctx.workspaceRoot, worktreeCleanupPath); } catch {}
        }
        // P3-09: a ceiling-stopped agent must not masquerade as a completed one — say what stopped it.
        const budgetStopped = result.stopReason === 'budget' || result.stopReason === 'max_iterations';
        return ok(
          'agent',
          'read',
          Date.now() - start,
          result.finalAnswer || (budgetStopped ? `Sub-agent stopped by its ${result.stopReason} ceiling before producing an answer.` : 'Sub-agent completed.'),
          data,
        );
      } catch (e) {
        accrue(parentBudget); // P3-09: a thrown run still spent tokens/cost — roll it up.
        if (base.hooks?.subagent_stop?.length) {
          runHookPhase('subagent_stop', base.hooks.subagent_stop, { workspaceRoot: subWorkspaceRoot, extra: { agentType, error: (e as Error).message } });
        }
        base.bus.emit({ type: 'subagent_end', taskId, ok: false, subagentType: agentType });
        if (worktreeCleanupPath) {
          try { removeWorktree(ctx.workspaceRoot, worktreeCleanupPath); } catch {}
        }
        return fail('agent', 'read', Date.now() - start, 'agent_failed', (e as Error).message);
      } finally {
        permit?.(); // released back to whichever gate admitted this agent; null = gateless bypass
      }
    },
  };
}