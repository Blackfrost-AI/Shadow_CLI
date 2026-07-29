import { buildLoopDeps } from '../agent/loopDeps.js';
import { AgentLoop } from '../agent/loop.js';
import { Budget } from '../agent/budget.js';
import { makeDenylist } from '../safety/denylist.js';
import { WebDenyGate } from './webGate.js';
import type { LoopDeps } from '../agent/loop.js';
import type { ShadowConfig } from '../config.js';
import type { ToolCall } from '../provider/provider.js';
import type { JailCapability, TurnRunner, WebSession } from './registry.js';
import { resolveJail } from './projects.js';

/**
 * Assemble the LoopDeps for one web turn. THE JAIL ENFORCEMENT POINT: workspaceRoot /
 * additionalRoots come from the frozen JailCapability — never session.displayPath (trap #4/#5).
 * buildLoopDeps → LoopDeps.workspaceRoot → ToolContext → resolveWithin in every file tool.
 * Exported so a test can assert on THESE options (asserting on createAgentSession's proves
 * nothing — it discards the jail).
 */
export function buildTurnDeps(session: WebSession): LoopDeps {
  const agent = session.agent;
  const jail = session.jail;
  if (!agent || !jail) throw new Error('runTurn called before the session was built');

  const budget = new Budget(
    {
      maxIterations: agent.cfg.maxIterations,
      maxTotalTokens: agent.cfg.budget.maxTotalTokens,
      maxCostUSD: agent.cfg.budget.maxCostUSD,
      maxWallClockSec: agent.cfg.budget.maxWallClockSec,
    },
    agent.cfg.model,
    agent.cfg.priceTable,
    Date.now(),
  );

  return buildLoopDeps({
    cfg: agent.cfg,
    provider: agent.provider,
    registry: agent.registry,
    // Q1 default: fail-closed. run_shell/network at auto-edit deny immediately with a finding.
    gate: new WebDenyGate(session.bus),
    bus: session.bus,
    budget,
    context: agent.context,
    // The registry sets session.abort before calling us; interrupt aborts the turn through it.
    signal: session.abort?.signal ?? new AbortController().signal,
    model: agent.cfg.model,
    system: agent.system,
    // THE enforcement point — the pinned jail root, not the display path.
    workspaceRoot: jail.workspaceRoot,
    additionalRoots: [...jail.additionalRoots],
    forceConfirm: makeWebForceConfirm(agent.cfg),
    todoList: agent.todoList,
    planMode: agent.planMode,
    streamShell: true,
    sessionLog: agent.sessionLog,
    resolveFallback: async (entry) => {
      const activated = await agent.activateModel(entry);
      agent.provider = activated.provider;
      return activated;
    },
  });
}

/**
 * The real `TurnRunner`: record the user's turn, assemble deps (the jail enforcement above), and
 * run one loop. The run lock is held by the registry around this call.
 */
export function makeTurnRunner(resolve: (root: string) => JailCapability = resolveJail): TurnRunner {
  return async (session: WebSession, prompt: string) => {
    const agent = session.agent;
    if (!agent) throw new Error('runTurn called before the session was built');

    // E1 — RE-RESOLVE the jail from the allowlist on EVERY turn.
    //
    // `session.jail` was written once, by the builder, and every later turn read the frozen copy.
    // So removing a project made its card disappear and returned 200 while the still-open session
    // kept reading and writing that directory at auto-edit. `projects.ts` and `api/projects.ts`
    // both document the opposite ("never once at session-create", "revocation ALWAYS succeeds").
    // resolveJail throws when the path is no longer allowlisted; that propagates into
    // registry.drive()'s catch, which marks the session errored and emits a terminal frame.
    session.jail = resolve(session.displayPath);

    // Record the user's turn on the shared context and the wire (the browser echoes it).
    agent.context.append({ role: 'user', content: [{ type: 'text', text: prompt }] });
    session.bus.emit({ type: 'user', text: prompt });

    const deps = buildTurnDeps(session);
    await new AgentLoop(deps, session.autonomy()).run();
  };
}

/** Catastrophic-command guard: forces confirmation (→ WebDenyGate → deny) for denylisted shell
 *  commands regardless of autonomy. Independent of the autonomy level (loop.ts). */
function makeWebForceConfirm(cfg: ShadowConfig): (call: ToolCall, risk: string) => string | null {
  const denylist = makeDenylist(cfg.denylistExtra);
  return (call) => {
    if (call.name !== 'run_shell') return null;
    const input = call.input as { command?: unknown } | undefined;
    const command = typeof input?.command === 'string' ? input.command : '';
    const why = denylist(command);
    return why ? `denylisted: ${why}` : null;
  };
}
