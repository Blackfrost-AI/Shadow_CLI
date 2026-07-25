import type { EventBus } from './events.js';
import type { Context } from './context.js';

/** Text form of a background sub-agent's completion, as the model sees it. */
export function formatTaskNotification(e: { taskId?: string; fromSubagent?: string; answer?: string }): string {
  return `<task-notification task_id="${e.taskId}"${e.fromSubagent ? ` subagent="${e.fromSubagent}"` : ''}>\n${e.answer || ''}\n</task-notification>`;
}

/**
 * Notifications waiting to be folded into the next user turn.
 *
 * They used to be `append`ed to the LIVE context the moment they arrived. A background sub-agent
 * finishes whenever it finishes — including in the window between the assistant's tool_use being
 * committed and its tool_result being appended, which is the longest part of any turn. That
 * produced `[assistant tool_use][user text][user tool_results]`: the Anthropic adapter coalesces
 * the two user turns and so violates tool_results-first ordering, OpenAI rejects it outright, and
 * a mid-history orphan was unrepairable — every subsequent turn 400'd with no way out but /clear.
 *
 * Buffering costs nothing: the notification is for the MODEL, and the model does not read the
 * context until the next request is built.
 */
export interface PendingNotifications {
  /** Take everything buffered so far, clearing the buffer. */
  drain(): string[];
  /** How many are waiting (tests / diagnostics). */
  size(): number;
}

export function attachBgAgentDelivery(bus: EventBus, mainContext: Context): PendingNotifications {
  const pending: string[] = [];
  bus.on((e: any) => {
    if (e.type === 'task_notification') {
      pending.push(formatTaskNotification(e));
    }
    if (e.type === 'bg_agent_launched') {
      // Bookkeeping only — appends no message, so it stays inline.
      const tasks = (mainContext as any)._subAgentTasks || ((mainContext as any)._subAgentTasks = []);
      tasks.push({ taskId: e.taskId, prompt: e.prompt, subagentType: e.subagentType, ts: new Date().toISOString() });
    }
  });
  return {
    drain: () => pending.splice(0, pending.length),
    size: () => pending.length,
  };
}
