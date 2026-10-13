import { z } from 'zod';
import type { ProjectCheckStore } from '../checks/store.js';
import { fail, ok, type Tool } from './types.js';

export const projectChecksInputSchema = z.object({
  action: z.enum(['list', 'select', 'status', 'run']),
  ids: z.array(z.string()).max(100).optional().describe('Complete required check selection for this task. Empty clears it.'),
  id: z.string().optional().describe('Exact profile id to execute through run_shell permissions.'),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'run' && !value.id) ctx.addIssue({ code: 'custom', path: ['id'], message: 'run requires id' });
  if (value.action === 'select' && !value.ids) ctx.addIssue({ code: 'custom', path: ['ids'], message: 'select requires ids' });
});

export function makeProjectChecksTool(source: ProjectCheckStore | ((workspaceRoot: string) => ProjectCheckStore)): Tool<z.infer<typeof projectChecksInputSchema>> {
  return {
    name: 'project_checks', risk: 'read', inputSchema: projectChecksInputSchema,
    description: 'List/select reusable local project checks from .shadow/checks.json, inspect results, or run one named profile. Running a profile goes through run_shell permissions, sandbox, hooks and budgets; profile declarations never authorize execution. Select only checks relevant to the current user task. A passed check is timestamped evidence, not proof of all work.',
    async run(input, ctx) {
      if (input.action === 'run') return fail('project_checks', 'exec', 0, 'execution_unavailable', 'Check execution requires the AgentLoop guarded run_shell dispatcher.');
      try {
        const store = typeof source === 'function' ? source(ctx.workspaceRoot) : source;
        const checks = input.action === 'select' ? store.select(input.ids!) : store.snapshot();
        return ok('project_checks', 'read', 0, checks.length ? checks.map((item) => `${item.selected ? '[required] ' : ''}${item.profile.id}: ${item.status} — ${item.profile.title}`).join('\n') : 'No check profiles. Define version:1 with profiles in .shadow/checks.json; no commands run during discovery.', { checks });
      } catch (error) { return fail('project_checks', 'read', 0, 'invalid_profiles', (error as Error).message); }
    },
  };
}
