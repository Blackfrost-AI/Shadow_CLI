import { COLLABORATION_PRESETS } from '../../agent/collaboration.js';
import type { ApiContext, RouteFn } from '../router.js';

/** Read-only roster metadata. Authentication/authorization happens before the router. */
export function registerCollaborationRoutes(route: RouteFn, _ctx: ApiContext): void {
  route('GET', /^\/api\/collaboration$/, async () => ({
    status: 200,
    body: { presets: COLLABORATION_PRESETS },
  }));
}