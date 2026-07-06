import type { EventBus } from './events.js';
import type { Context } from './context.js';

/**
 * Attaches the bg agent delivery listeners to the bus.
 * Extracted so tests can drive the exact shipped registration logic without
 * pulling the full index.ts side effects.
 */
export function attachBgAgentDelivery(bus: EventBus, mainContext: Context) {
  bus.on((e: any) => {
    if (e.type === 'task_notification') {
      const notif = `<task-notification task_id="${e.taskId}"${e.fromSubagent ? ` subagent="${e.fromSubagent}"` : ''}>\n${e.answer || ''}\n</task-notification>`;
      mainContext.append({ role: 'user', content: [{ type: 'text', text: notif }] });
    }
    if (e.type === 'bg_agent_launched') {
      const tasks = (mainContext as any)._subAgentTasks || ((mainContext as any)._subAgentTasks = []);
      tasks.push({ taskId: e.taskId, prompt: e.prompt, subagentType: e.subagentType, ts: new Date().toISOString() });
    }
  });
}
