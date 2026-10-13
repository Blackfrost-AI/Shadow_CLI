import type { Message } from '../provider/provider.js';
import { Context, type ContextOptions, type ContextSource } from '../agent/context.js';
import type { SessionStateSnapshot } from './sessionState.js';

/** Payload stored in session JSONL `context_snapshot` records. */
export interface ContextSnapshotData {
  sessionState?: SessionStateSnapshot;
  messages: Message[];
  pinnedPrefix: number;
  lastActualTokens: number;
  lastReportedTokens?: number;
  /** Explicit session pins/exclusions; request capture itself is deliberately not persisted. */
  sources?: ContextSource[];
  /** Captured bg sub-agent launches for recovery (taskId + prompt snapshot). */
  subAgentTasks?: Array<{ taskId: string; prompt: string; subagentType?: string; ts?: string }>;
}

export type HydrateOptions = ContextOptions;

/** Serialize a live context into a JSON-safe snapshot payload. */
export function serializeContext(ctx: Context): ContextSnapshotData {
  return ctx.exportState() as ContextSnapshotData;
}

/** Reconstruct a Context from snapshot data and budget options. */
export function hydrateContext(data: ContextSnapshotData, opts: HydrateOptions): Context {
  const ctx = new Context(opts);
  ctx.loadState(data);
  return ctx;
}
