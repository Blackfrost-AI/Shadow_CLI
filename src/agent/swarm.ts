/** Dependency-aware swarm execution. The mission lead owns integration and verification. */
export interface SwarmTask {
  id: string;
  prompt: string;
  dependsOn?: string[];
  description?: string;
  profile?: string;
  subagentType?: string;
  isolation?: 'none' | 'worktree';
  maxIterations?: number;
}

export type SwarmNodeStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'blocked';
export interface SwarmWorkerResult {
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  answer?: string;
  error?: string;
  jobId?: string;
  artifact?: string;
}
export interface SwarmNode extends SwarmTask {
  status: SwarmNodeStatus;
  result?: SwarmWorkerResult;
}
export interface SwarmResult {
  ok: boolean;
  nodes: SwarmNode[];
}

export function validateSwarmTasks(tasks: SwarmTask[]): string | null {
  if (!Array.isArray(tasks) || tasks.length === 0) return 'Swarm requires at least one task.';
  if (tasks.length > 16) return 'Swarm supports at most 16 tasks per wave.';
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(t.id)) return `Invalid task id: ${String(t.id)}`;
    if (ids.has(t.id)) return `Duplicate task id: ${t.id}`;
    ids.add(t.id);
    if (!t.prompt?.trim()) return `Task ${t.id} needs a prompt.`;
    if ('maxAgents' in t) return `Task ${t.id} cannot request nested maxAgents fan-out.`;
    for (const dep of t.dependsOn ?? []) if (!ids.has(dep) && !tasks.some((n) => n.id === dep)) return `Task ${t.id} has unknown dependency ${dep}.`;
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (t: SwarmTask): boolean => {
    if (visiting.has(t.id)) return true;
    if (visited.has(t.id)) return false;
    visiting.add(t.id);
    for (const dep of t.dependsOn ?? []) if (visit(tasks.find((n) => n.id === dep)!)) return true;
    visiting.delete(t.id); visited.add(t.id); return false;
  };
  return tasks.some(visit) ? 'Swarm dependency graph contains a cycle.' : null;
}

export async function runSwarm(
  options: { tasks: SwarmTask[]; concurrency?: number; signal?: AbortSignal },
  worker: (task: SwarmTask) => Promise<SwarmWorkerResult>,
): Promise<SwarmResult> {
  const invalid = validateSwarmTasks(options.tasks);
  if (invalid) throw new Error(invalid);
  const nodes: SwarmNode[] = options.tasks.map((t) => ({ ...t, status: 'pending' }));
  const concurrency = Math.max(1, Math.min(16, Math.floor(options.concurrency ?? 4)));
  let next = 0;
  let running = 0;
  const ready = nodes.filter((n) => (n.dependsOn?.length ?? 0) === 0);
  const unblockReady = (): void => {
    for (const n of nodes) {
      if (n.status === 'pending' && !ready.includes(n) && n.isolation !== 'worktree' &&
        (n.dependsOn?.length ?? 0) > 0 && n.dependsOn!.every((id) => nodes.find((p) => p.id === id)?.status === 'completed')) ready.push(n);
    }
  };
  const blockDependents = (id: string): void => {
    for (const n of nodes) {
      if (n.status === 'pending' && n.dependsOn?.includes(id)) { n.status = 'blocked'; blockDependents(n.id); }
    }
  };
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (running < concurrency && next < ready.length && !options.signal?.aborted) {
        const node = ready[next++]!;
        node.status = 'running'; running++;
        void Promise.resolve().then(() => worker(node)).then((result) => {
          node.result = result; node.status = result.status;
          if (result.status !== 'completed') blockDependents(node.id);
        }).catch((error: unknown) => {
          node.result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
          node.status = 'failed'; blockDependents(node.id);
        }).finally(() => { running--; unblockReady(); pump(); });
      }
      if (running === 0 && (next >= ready.length || options.signal?.aborted)) resolve();
    };
    pump();
  });
  for (const node of nodes) if (node.status === 'pending') { node.status = 'blocked'; blockDependents(node.id); }
  return { ok: nodes.every((n) => n.status === 'completed'), nodes };
}
