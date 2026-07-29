import type { ToolCall, StopReason } from '../provider/provider.js';
import type { ToolResult, ToolRisk } from '../tools/types.js';
import type { AutonomyLevel } from '../safety/permissions.js';
import type { TodoItem } from './todo.js';
import type { PlanSnapshot } from './planMode.js';

/**
 * Typed events the loop emits. The UI (Ink) and the plain REPL both subscribe;
 * the loop itself never imports any UI code — this seam keeps it headless/testable.
 */
export type LoopEvent =
  | { type: 'mode'; mode: 'thinking' | 'acting' | 'idle' }
  // The user's own turn. Emitted by the SUBMIT sites (tui.tsx, index.ts), not by the loop —
  // the loop receives a Message, not a keystroke, and by then the text is already history.
  // Exists so a non-terminal renderer (the `--web` mirror) can show the question as well as
  // the answer; the TUI and headless renderers ignore it because they echo input locally.
  | { type: 'user'; text: string }
  | { type: 'text'; delta: string } // streamed assistant answer
  | { type: 'thinking'; delta: string } // streamed extended-reasoning text
  | { type: 'reasoning_done'; text: string } // committed collapsible reasoning block
  | { type: 'assistant_done'; text: string } // a full assistant turn committed
  | { type: 'finding'; title: string; body: string; severity?: 'info' | 'warn' | 'error' }
  | { type: 'tool_start'; call: ToolCall; risk: ToolRisk }
  | { type: 'tool_end'; call: ToolCall; result: ToolResult }
  | { type: 'tool_denied'; call: ToolCall; reason: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUSD: number; contextPct: number }
  | { type: 'latency'; ms: number }
  | { type: 'compaction'; trigger: 'auto' | 'manual' } // earlier turns summarized to reclaim context (surfaced for TUI + eval verification)
  | { type: 'autonomy'; level: AutonomyLevel }
  | { type: 'todo'; items: TodoItem[] }
  | { type: 'plan_mode'; plan: PlanSnapshot }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  | { type: 'error'; message: string }
  | { type: 'stop'; reason: StopReasonExt; finalAnswer: string }
  | { type: 'shell_output'; callId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'shell_pid'; pid: number | null; warn: string | null } // active run_shell child + interrupt warning
  | { type: 'model_fallback'; from: string; to: string; reason: string }
  | { type: 'task_notification'; taskId: string; answer: string; fromSubagent?: string } // bg agent result delivered as user-role message (Claude parity)
  | { type: 'bg_agent_launched'; taskId: string; prompt: string; subagentType?: string } // launch metadata recorded to main ctx for snapshot/recovery
  // A finished sub-agent's TOTAL spend, emitted once by the `agent` tool. Sub-agents run on their
  // own Budget, so their per-turn `usage` events must NOT reach the parent HUD (see SubagentBus);
  // this carries the one number the session cost readout genuinely needs.
  | { type: 'subagent_usage'; costUSD: number; subagent?: string }

export type StopReasonExt =
  | StopReason
  | 'max_iterations'
  | 'budget'
  | 'interrupted'
  | 'fatal_tool_error'
  | 'provider_error';

export type LoopListener = (e: LoopEvent) => void;

export class EventBus {
  private readonly listeners = new Set<LoopListener>();

  on(fn: LoopListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: LoopEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a listener must never break the loop
      }
    }
  }
}

/**
 * Events a sub-agent is allowed to put on the PARENT bus.
 *
 * Sub-agents were handed `base.bus` directly, so every event they emitted was indistinguishable
 * from the parent's own. Three verified defects fell out of that one wiring:
 *   - `text`/`assistant_done` streamed the sub-agent's answer into the parent transcript, where it
 *     rendered up to three times (live stream, commit, and again in the tool result);
 *   - `usage` overwrote the HUD with the SUB-AGENT's context percentage mid-tool, and reset the
 *     parent's per-turn cost baseline, so `/cost` reported nonsense;
 *   - `stop`/`mode` made the parent look finished while it was still working.
 *
 * The whitelist is what a user genuinely wants to see from a sub-agent: what it is DOING (tools),
 * whether it failed, and its result when it completes.
 */
export const SUBAGENT_FORWARDED_EVENTS: ReadonlySet<LoopEvent['type']> = new Set([
  'tool_start',
  'tool_end',
  'tool_denied',
  'task_notification',
  'subagent_usage',
  'error',
] as const);

/**
 * A bus for a sub-agent loop: local subscribers see everything, the parent sees only the whitelist.
 */
export class SubagentBus extends EventBus {
  constructor(
    private readonly parent: EventBus,
    private readonly forward: ReadonlySet<LoopEvent['type']> = SUBAGENT_FORWARDED_EVENTS,
  ) {
    super();
  }

  override emit(e: LoopEvent): void {
    super.emit(e);
    if (this.forward.has(e.type)) this.parent.emit(e);
  }
}
