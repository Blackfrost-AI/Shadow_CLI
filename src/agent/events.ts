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
