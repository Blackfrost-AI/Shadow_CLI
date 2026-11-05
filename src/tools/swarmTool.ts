import { z } from 'zod';
import { runSwarm, type SwarmWorkerResult } from '../agent/swarm.js';
import type { Tool, ToolContext, ToolResult } from './types.js';
import { fail, ok } from './types.js';

const schema = z.object({
  tasks: z.array(z.object({
    id: z.string().min(1).max(64).describe('Unique short graph node id.'),
    description: z.string().max(500).optional(),
    prompt: z.string().min(1).max(30_000).describe('Complete narrow worker brief with acceptance evidence.'),
    dependsOn: z.array(z.string()).max(15).optional(),
    profile: z.string().optional().describe('Named model profile; inherits current model by default.'),
    subagentType: z.string().optional(),
    isolation: z.enum(['none', 'worktree']).default('none'),
    maxIterations: z.number().int().positive().max(100).optional(),
  })).min(1).max(16),
  concurrency: z.number().int().min(1).max(16).optional().describe('Requested width; native session semaphore may lower it.'),
});

export function makeSwarmTool(
  executeAgent: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>,
  concurrency = 4,
): Tool<z.infer<typeof schema>, { result: unknown }> {
  return {
    name: 'swarm', risk: 'write', inputSchema: schema,
    description: 'Execute an approved /swarm mission DAG using native agents. Run one dependency-ready wave; the lead integrates verified artifacts before running dependent writers. Worker completion does not verify the mission.',
    async run(input, ctx) {
      if (ctx.nestedAgent) return { ...fail('swarm', 'write', 0, 'not_allowed', 'Nested swarm fan-out is disabled. Only the mission lead may schedule a swarm.'), data: { result: { ok: false, nodes: [] } } };
      const result = await runSwarm({ tasks: input.tasks, concurrency: Math.min(input.concurrency ?? concurrency, concurrency), signal: ctx.signal }, async (node): Promise<SwarmWorkerResult> => {
        const res = await executeAgent({
          prompt: `${node.prompt}\n\nSwarm node ${node.id}. Do not spawn agents, change mission state, widen scope, or claim final verification. Report files changed, checks run with outcomes, and anything unverified.`,
          description: node.description ?? `Swarm ${node.id}`,
          run_in_background: false,
          isolation: node.isolation,
          profile: node.profile,
          subagent_type: node.subagentType,
          max_iterations: node.maxIterations,
        }, ctx);
        const data = res.data as { status?: SwarmWorkerResult['status'] | 'started'; answer?: string; taskId?: string; artifactIds?: string[] } | undefined;
        if (data?.status === 'started') return { status: 'partial', answer: `Worker promoted to background; await ${data.taskId ?? 'its job'} before continuing.`, jobId: data.taskId };
        return { status: ctx.signal.aborted ? 'cancelled' : data?.status ?? (res.ok ? 'completed' : 'failed'), answer: data?.answer ?? res.summary, error: res.ok ? undefined : res.summary, jobId: data?.taskId, artifact: data?.artifactIds?.join(', ') };
      });
      const summary = result.nodes.map((n) => `${n.id}: ${n.status}${n.result?.jobId ? ` (${n.result.jobId})` : ''}${n.result?.answer ? `\n${n.result.answer}` : ''}`).join('\n\n');
      const text = `Swarm wave ${result.ok ? 'completed' : 'incomplete'}. Verify outputs before integration or mission completion.\n${summary}`;
      return result.ok ? ok('swarm', 'write', 0, text, { result }) : { ...fail('swarm', 'write', 0, 'swarm_incomplete', text), data: { result } };
    },
  };
}
