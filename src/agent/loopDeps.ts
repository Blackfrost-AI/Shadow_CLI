import type { LoopDeps } from './loop.js';
import type { ShadowConfig } from '../config.js';
import type { Provider, ToolCall } from '../provider/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ApprovalGate } from './approval.js';
import type { EventBus } from './events.js';
import type { Budget } from './budget.js';
import type { Context } from './context.js';
import type { TodoList } from './todo.js';
import type { PlanModeState } from './planMode.js';
import type { SessionLog as SessionLogType } from '../state/session.js';
import { resolveParallelTools } from '../config/familyProfiles.js';

/**
 * The parts of `LoopDeps` that genuinely differ per call site. Everything else is
 * derived from `cfg` and was, until this factory existed, copy-pasted at three sites
 * (the headless CLI run, the TUI turn, and the sub-agent tool) where it had already
 * begun to drift.
 */
export interface LoopDepsInput {
  cfg: ShadowConfig;
  provider: Provider;
  registry: ToolRegistry;
  gate: ApprovalGate;
  bus: EventBus;
  budget: Budget;
  context: Context;
  signal: AbortSignal;
  /**
   * The LIVE model, not `cfg.model` — a `/model` switch changes the family mid-session
   * and `parallelTools` is resolved against whatever is passed here.
   */
  model: string;
  /** Fully composed system prompt (style, standing goal, sub-agent prefix already applied). */
  system: string;
  workspaceRoot: string;
  additionalRoots?: string[];
  forceConfirm?: (call: ToolCall, risk: string) => string | null;
  todoList?: TodoList;
  planMode?: PlanModeState;
  /** TUI streams shell output; headless and sub-agents do not. */
  streamShell: boolean;
  sessionLog?: SessionLogType;
}

/**
 * Assemble `LoopDeps` from the live objects plus config. The cfg-derived fields are
 * identical at every call site by construction, so a new consumer (e.g. the web server)
 * cannot silently miss one.
 */
export function buildLoopDeps(input: LoopDepsInput): LoopDeps {
  const { cfg } = input;
  return {
    provider: input.provider,
    registry: input.registry,
    gate: input.gate,
    bus: input.bus,
    budget: input.budget,
    context: input.context,
    signal: input.signal,
    model: input.model,
    system: input.system,
    workspaceRoot: input.workspaceRoot,
    additionalRoots: input.additionalRoots,
    forceConfirm: input.forceConfirm,
    todoList: input.todoList,
    planMode: input.planMode,
    streamShell: input.streamShell,
    sessionLog: input.sessionLog,

    // --- derived from cfg; identical at every call site ---
    maxOutputTokens: cfg.maxOutputTokens,
    effort: cfg.effort,
    cacheTtl: cfg.cacheTtl,
    fastMode: cfg.fastMode,
    dryRun: cfg.dryRun,
    maxToolResultChars: cfg.maxToolResultChars,
    contextBudget: cfg.contextBudget,
    permissionRules: cfg.permissionRules,
    autoClassifier: cfg.autoClassifier,
    hooks: cfg.hooks,
    models: cfg.models,
    fallbackModel: cfg.fallbackModel,
    // explicit config > family profile > global default, resolved on the live model
    parallelTools: resolveParallelTools(cfg, input.model),
  };
}
