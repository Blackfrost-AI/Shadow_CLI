/**
 * Types for the browser session store (sessionModel.js). Hand-written — the console UI is
 * plain ES modules (no build step), so TypeScript only sees them through declarations like
 * this one where tests import them.
 */

export interface SessionRow {
  id: number;
  kind: string;
  ts: number;
  text?: string;
  streaming?: boolean;
  status?: string;
  /** tool rows */
  name?: string;
  args?: unknown;
  summary?: string;
  durationMs?: number;
  subagent?: boolean;
  /** stats rows */
  stats?: {
    steps?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUSD?: number;
    llmMs?: number;
    toolMs?: number;
  };
  outcome?: string;
  severity?: string;
  title?: string;
}

export interface RequestRecord {
  latencyMs?: number;
  ttftMs?: number;
  in?: number;
  out?: number;
  cacheRead?: number;
}

export interface TurnRecord {
  id: number;
  startTs: number;
  endTs: number | null;
  stopReason: string | null;
  steps: number;
  requests: RequestRecord[];
}

export interface SessionUsage {
  turns: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheHitPct: number | null;
  costUSD: number;
}

export interface ApprovalRow {
  id: string;
  tool: string;
  kind: string;
  detail?: unknown;
}

export interface QueuedPrompt {
  text: string;
}

export interface SubagentRow {
  type: string;
  description?: string;
  background?: boolean;
  queued?: boolean;
  ok?: boolean | null;
}

export interface TodoItem {
  id: string;
  subject: string;
  status: string;
}

export interface SessionSnapshot {
  rows: SessionRow[];
  turns: TurnRecord[];
  session: SessionUsage;
  approvals: ApprovalRow[];
  queue: QueuedPrompt[];
  subagents: SubagentRow[];
  todo: TodoItem[];
  hud: {
    model?: string;
    autonomy?: string;
    usage?: { contextPct?: number | null };
    latencyMs?: number | null;
  };
}

export interface SessionModel {
  apply(event: unknown): void;
  hydrate(events: unknown[]): void;
  reset(): void;
  snapshot(): SessionSnapshot;
  addUserLocal(text: string): void;
  enqueue(text: string): void;
  dequeue(): QueuedPrompt | null;
  unqueue(i: number): void;
  decide(approvalId: string): void;
  statsFor(turn: TurnRecord): unknown;
  lastTurn(): TurnRecord | null;
  subscribe(listener: () => void): () => void;
}

export function createSessionModel(sessionId: string): SessionModel;
