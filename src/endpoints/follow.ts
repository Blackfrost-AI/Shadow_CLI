import type { ObservedEndpoint, SavedEndpoint } from './types.js';

export interface FollowContext {
  endpoint: SavedEndpoint;
  observation?: ObservedEndpoint;
  running: boolean;
  /** Adoption is an explicit per-endpoint opt-in, never inferred from discovery. */
  enabled: boolean;
}

export type FollowDecision =
  | { action: 'ignore'; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'adopt'; reason: string; modelId: string; deploymentId?: string };

/** Decide whether an observed replacement may be adopted; performs no I/O or provider mutation. */
export function decideFollow(context: FollowContext, next: ObservedEndpoint): FollowDecision {
  if (!context.enabled || context.endpoint.follow?.enabled !== true) return { action: 'ignore', reason: 'follow is disabled' };
  if (context.running) return { action: 'wait', reason: 'a turn is running; adoption waits for a conversation boundary' };
  if (next.readiness === 'loading') return { action: 'wait', reason: 'endpoint is still loading' };
  if (next.readiness !== 'ready') return { action: 'wait', reason: `endpoint is ${next.readiness}` };
  const configured = context.endpoint.follow.modelId ?? context.endpoint.model;
  if (!configured) return { action: 'ignore', reason: 'no followed model is configured' };
  const replacement = next.models.find((model) => model.id === configured);
  if (!replacement) return { action: 'wait', reason: `followed model ${configured} is not currently served` };
  if (context.observation?.deploymentId && next.deploymentId && context.observation.deploymentId === next.deploymentId) {
    return { action: 'ignore', reason: 'deployment is unchanged' };
  }
  if (context.observation?.models.some((model) => model.id === replacement.id) && !next.deploymentId && !replacement.deploymentId) {
    return { action: 'ignore', reason: 'model identity is unchanged and no deployment revision was reported' };
  }
  return { action: 'adopt', reason: `followed deployment is now ${replacement.id}`, modelId: replacement.id, deploymentId: next.deploymentId ?? replacement.deploymentId };
}
