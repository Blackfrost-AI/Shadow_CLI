/**
 * P3-01 — focus-owner router: helpers shared by more than one owner.
 */
import type { QueuedTask } from '../../tui.js';
import type { KeyEnv } from './types.js';

/** Human messages steer the active agent; commands and scheduled wakeups wait for turn-end.
 *  A path-like "/Users/…" is a message, not a command (classifySlash says 'message'). */
export function queuedTaskKind(env: KeyEnv, task: string): QueuedTask['kind'] {
  if (!task.startsWith('/')) return 'steer';
  return env.classifySlash(task).kind === 'message' ? 'steer' : 'deferred';
}
