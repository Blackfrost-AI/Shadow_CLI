import type { Message } from '../provider/provider.js';
import { Context, type ContextOptions } from '../agent/context.js';

/** Payload stored in session JSONL `context_snapshot` records. */
export interface ContextSnapshotData {
  messages: Message[];
  pinnedPrefix: number;
  lastActualTokens: number;
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