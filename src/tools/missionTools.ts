// mission_update — the lead agent's only write into MissionState. Risk 'read': it
// mutates harness state, never the workspace. The nestedAgent guard is mandatory:
// the tool registry is shared into sub-agent loops, and a delegate marking tasks done
// would clobber the lead's view of its own mission (the TodoList-clobber class).

import { z } from 'zod';
import type { MissionSnapshot, MissionState, MissionTaskStatus } from '../agent/mission.js';
import type { Tool } from './types.js';
import { ok } from './types.js';

const TASK_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'delegated'] as const;

const missionUpdateSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).describe('Task id from the mission block, e.g. "m-2".'),
        status: z.enum(TASK_STATUSES),
        detail: z.string().optional().describe('One-line outcome/evidence for this status change.'),
      }),
    )
    .optional()
    .describe('Task status patches. Unknown ids are ignored; statuses replace, detail updates.'),
  phase: z
    .enum(['executing', 'verifying', 'done', 'failed'])
    .optional()
    .describe('Advance the mission phase. `planning` is set by plan approval and cannot be re-entered.'),
});

export interface MissionUpdateData {
  updated: boolean;
  mission: MissionSnapshot;
}

function summaryLine(snap: MissionSnapshot): string {
  const done = snap.tasks.filter((t) => t.status === 'done').length;
  const total = snap.tasks.length;
  const counts = total > 0 ? ` · ${done}/${total} done` : '';
  return `Mission ${snap.phase}${counts}`;
}

export function makeMissionUpdateTool(mission: MissionState): Tool<z.infer<typeof missionUpdateSchema>, MissionUpdateData> {
  return {
    name: 'mission_update',
    description:
      'Update the active /goal mission: mark task statuses and/or advance the phase (executing → ' +
      'verifying → done|failed). Call it as work completes so the mission stays current; include a ' +
      'short evidence detail for done/failed. Lead agent only — in a sub-agent it is inert.',
    risk: 'read',
    inputSchema: missionUpdateSchema,
    async run(input, ctx) {
      // Sub-agents never see the mission block, but the registry IS shared into their loops —
      // make any stray call a no-op instead of a silent state clobber.
      if (ctx.nestedAgent) {
        return ok('mission_update', 'read', 0, 'Mission is managed by the lead agent — mission_update is inert in sub-agents.', {
          updated: false,
          mission: mission.snapshot(),
        });
      }
      if (!mission.active) {
        return ok('mission_update', 'read', 0, 'No active mission. Start one with /goal <text>.', {
          updated: false,
          mission: mission.snapshot(),
        });
      }
      if (input.tasks && input.tasks.length > 0) {
        mission.updateTasks(input.tasks.map((t) => ({ id: t.id, status: t.status as MissionTaskStatus, detail: t.detail })));
      }
      if (input.phase) mission.setPhase(input.phase);
      const snap = mission.snapshot();
      return ok('mission_update', 'read', 0, `Mission updated. ${summaryLine(snap)}`, { updated: true, mission: snap });
    },
  };
}
