import type { ToolCall, StopReason } from '../provider/provider.js';
import type { ToolResult, ToolRisk } from '../tools/types.js';
import type { AutonomyLevel } from '../safety/permissions.js';
import type { TodoItem } from './todo.js';
import type { PlanSnapshot } from './planMode.js';
import type { ApprovalKind, UserQuestion } from './approval.js';

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
  | { type: 'tool_start'; call: ToolCall; risk: ToolRisk; subagent?: string }
  | { type: 'tool_end'; call: ToolCall; result: ToolResult; subagent?: string }
  | { type: 'tool_denied'; call: ToolCall; reason: string; subagent?: string }
  // inputTokens/outputTokens/costUSD are TURN-CUMULATIVE (Budget.snapshot) — the HUD contract.
  // The optional fields are THIS provider request's numbers, added for the web console's
  // per-turn metrics footer + trajectory: cacheRead/Write split, time-to-first-token, and the
  // raw per-request counts (iterInput includes cache reads/writes where the provider reports
  // them — mirror the `recordActualTokens` sum in loop.ts). All optional so older emitters and
  // tests that only assert the four legacy fields stay valid.
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      costUSD: number;
      contextPct: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      ttftMs?: number;
      iterInputTokens?: number;
      iterOutputTokens?: number;
    }
  | { type: 'latency'; ms: number }
  | { type: 'compaction'; trigger: 'auto' | 'manual'; degraded?: boolean } // earlier turns summarized to reclaim context (surfaced for TUI + eval verification); degraded: the summarizer FAILED and context was reclaimed by local truncation only (F04-11)
  | { type: 'autonomy'; level: AutonomyLevel }
  | { type: 'todo'; items: TodoItem[] }
  | { type: 'plan_mode'; plan: PlanSnapshot }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  // Diagnostic channel (F04-06): machine-readable loop internals (e.g. the healer dropping a
  // duplicate tool_result). Renderers ignore it by default; the session log persists it.
  | { type: 'debug'; code: string; message: string }
  | { type: 'error'; message: string }
  | { type: 'stop'; reason: StopReasonExt; finalAnswer: string }
  | { type: 'shell_output'; callId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'shell_pid'; pid: number | null; warn: string | null } // active run_shell child + interrupt warning
  | { type: 'model_fallback'; from: string; to: string; reason: string }
  | { type: 'task_notification'; taskId: string; answer: string; fromSubagent?: string } // bg agent result delivered as user-role message (Claude parity)
  | { type: 'bg_agent_launched'; taskId: string; prompt: string; subagentType?: string } // launch metadata recorded to main ctx for snapshot/recovery
  // A finished sub-agent's TOTAL spend, emitted once by the `agent` tool. Sub-agents run on their
  // own Budget, so their per-turn `usage` events must NOT reach the parent HUD (see SubagentBus);
  // this carries the one number the session cost readout genuinely needs. `taskId` + token counts
  // let the HUD attribute the spend to the exact agent panel row (not just the type).
  | { type: 'subagent_usage'; costUSD: number; subagent?: string; taskId?: string; inputTokens?: number; outputTokens?: number }
  // Sub-agent visibility (BUG 3). Emitted by the `agent` tool directly on the PARENT bus so the
  // TUI/REPL can surface what delegated agents are doing WITHOUT folding them into the parent's
  // single live-tool row. `subagent_start`/`subagent_end` bracket a sub-agent's run; live activity
  // arrives on the forwarded `tool_start`/`tool_end` events, which the SubagentBus tags with the
  // same `subagent` taskId so the UI can route them to the sub-agent panel instead of the parent.
  // F06-10: the session concurrency semaphore can delay a sub-agent's admission. A delayed agent
  // is announced with `queued: true`, then RE-announced with `queued: false` once a slot frees —
  // re-registration is safe because nothing has run yet (counters are still zero at admission).
  | { type: 'subagent_start'; taskId: string; subagentType: string; description?: string; background?: boolean; queued?: boolean }
  | { type: 'subagent_end'; taskId: string; ok: boolean; subagentType?: string }
  // A REQUEST (UI → running bg agent) to cancel a background sub-agent by taskId, or all when
  // taskId is '*'. Emitted on the parent bus; the bg `agent` tool run listens for its own taskId and
  // aborts its sub-loop. Completes the F10-02 story: bg agents were visible but uncancellable.
  | { type: 'cancel_subagent'; taskId: string }
  // --- approvals over HTTP (the web console's decision channel) -----------------------
  // A gated action announces itself as `approval_request` and is PARKED on the session
  // (registry.pendingApprovals) until the browser answers via
  // POST /api/sessions/:id/approvals/:approvalId — or the turn's abort settles it as cancelled.
  // The wire copy is DISPLAY-SAFE by construction: `argHint` is a short redacted digest of the
  // call's input (command/path/query/url), never the raw `call.input`; the executor still sees
  // the full input. `preview` (the gate's own diff/preview text) and `questions` (user_question)
  // round out what the UI needs to render the strip. Mirrors dsh's approval/requested frame.
  | {
      type: 'approval_request';
      id: string;
      kind: ApprovalKind;
      tool: string;
      risk: ToolRisk;
      reason: string;
      preview: string;
      argHint?: string;
      acknowledgeOnly?: boolean;
      questions?: UserQuestion[];
    }
  // Terminal state for every request above, emitted to ALL subscribers (every open tab) so a
  // strip answered in one tab closes in the others. `cancelled` = the turn was interrupted or the
  // session closed while the ask was pending.
  | { type: 'approval_resolved'; id: string; outcome: 'approved' | 'session' | 'denied' | 'cancelled' | 'answered' }

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
  // F04-11: a sub-agent's degraded compaction (and its loop-guard warnings) must reach the
  // operator, not die on a bus nobody renders. Findings are rare operator-facing warnings —
  // forwarding them cannot spam the way streamed deltas would.
  'finding',
] as const);

/**
 * A bus for a sub-agent loop: local subscribers see everything, the parent sees only the whitelist.
 * When constructed with `meta`, forwarded tool events are tagged with `subagent: <taskId>` so the
 * parent UI can tell a delegated agent's tool activity from the parent's own (BUG 3) — the UI routes
 * tagged events to the sub-agent panel instead of the parent's single live-tool row.
 */
export class SubagentBus extends EventBus {
  constructor(
    private readonly parent: EventBus,
    private readonly forward: ReadonlySet<LoopEvent['type']> = SUBAGENT_FORWARDED_EVENTS,
    private readonly meta: { subagent: string } | null = null,
  ) {
    super();
  }

  override emit(e: LoopEvent): void {
    super.emit(e);
    if (this.forward.has(e.type)) {
      if (
        this.meta &&
        (e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'tool_denied' || e.type === 'finding')
      ) {
        this.parent.emit({ ...e, subagent: this.meta.subagent } as LoopEvent);
      } else {
        this.parent.emit(e);
      }
    }
  }
}
