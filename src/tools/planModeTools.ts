import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { PlanModeState, PlanSnapshot } from '../agent/planMode.js';
import { saveGlobalConfig } from '../state/globalStore.js';
import type { Tool } from './types.js';
import { ok } from './types.js';

export interface PlanData {
  title: string;
  path: string;
  planMode: PlanSnapshot;
}

const planSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
});

const enterSchema = z.object({
  reason: z
    .string()
    .min(1)
    .describe('Why planning is needed — shown to the user when requesting approval to enter plan mode.'),
});

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Claude EnterPlanMode parity — loop gates activation via approval before planMode.enter(). */
export function makeEnterPlanModeTool(planMode: PlanModeState): Tool<z.infer<typeof enterSchema>, { mode: string }> {
  return {
    name: 'enter_plan_mode',
    description:
      'Request to enter plan mode before significant implementation work. Use when the task needs exploration, ' +
      'architectural decisions, multi-file changes, or unclear requirements. The user must approve before ' +
      'plan mode activates. Once active: explore freely, write the plan with plan_write, then call exit_plan_mode ' +
      'for approval before implementation tools run.',
    risk: 'read',
    inputSchema: enterSchema,
    async run(input) {
      if (planMode.active) {
        return ok('enter_plan_mode', 'read', 0, 'Already in plan mode.', { mode: 'planning' });
      }
      return ok('enter_plan_mode', 'read', 0, `Plan mode requested: ${input.reason}`, { mode: 'requested' });
    },
  };
}

export function makePlanWriteTool(planMode: PlanModeState): Tool<{ title: string; body?: string }, PlanData> {
  return {
    name: 'plan_write',
    description: 'Write the current plan to disk and keep exploring until user approval exits plan mode.',
    risk: 'write',
    inputSchema: planSchema,
    async run(input, ctx) {
      const slug = slugify(input.title) || 'plan';
      const path = ctx.dryRun ? `plans/${slug}.md` : resolve(ctx.workspaceRoot, `plans/${slug}.md`);
      if (!ctx.dryRun) {
        mkdirSync(resolve(ctx.workspaceRoot, 'plans'), { recursive: true });
        writeFileSync(path, `${input.body ?? ''}\n`);
      }
      const snapshot = planMode.recordPlan(input.title, path);
      return ok('plan_write', 'write', 1, `Plan written: ${input.title}.`, { title: input.title, path, planMode: snapshot });
    },
  };
}

export function makeExitPlanModeTool(
  planMode: PlanModeState,
  opts: { persist?: boolean } = {},
): Tool<Record<string, never>, PlanSnapshot> {
  return {
    name: 'exit_plan_mode',
    description: 'Request user approval for the current plan and exit plan mode after approval so implementation tools can run.',
    risk: 'read',
    inputSchema: z.object({}),
    async run(_input, ctx) {
      const snapshot = ctx?.dryRun ? planMode.snapshot() : planMode.exit();
      if (!ctx?.dryRun && opts.persist !== false) await saveGlobalConfig({ planMode: false });
      return ok('exit_plan_mode', 'read', 1, 'Plan mode exited. Implementation tools are now available.', snapshot);
    },
  };
}