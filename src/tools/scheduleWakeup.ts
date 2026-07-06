import { z } from 'zod';
import type { WakeupScheduler } from '../agent/wakeup.js';
import type { Tool } from './types.js';
import { ok } from './types.js';

const inputSchema = z.object({
  delay_seconds: z
    .number()
    .int()
    .positive()
    .max(86_400)
    .describe('Seconds until the wakeup fires. Prefer 300+ when idle; under 300 keeps prompt cache warm.'),
  reason: z.string().min(1).describe('Short scheduling reason shown to the user.'),
  task: z.string().min(1).describe('Task prompt to run when the wakeup fires.'),
});

export function makeScheduleWakeupTool(
  scheduler: WakeupScheduler,
  onFire: (task: string, reason: string) => void,
): Tool<z.infer<typeof inputSchema>, { id: string; at: number }> {
  return {
    name: 'schedule_wakeup',
    description:
      'Schedule a future task to run in this session after delay_seconds. Use for /loop dynamic pacing or ' +
      'long-poll waits — not for polling background work the harness already tracks.',
    risk: 'read',
    inputSchema,
    async run(input) {
      const job = scheduler.schedule(input.delay_seconds, input.reason, input.task, onFire);
      return ok('schedule_wakeup', 'read', 0, `Wakeup scheduled in ${input.delay_seconds}s: ${input.reason}`, {
        id: job.id,
        at: job.at,
      });
    },
  };
}
