/**
 * WorkCenter — a renderer-neutral derived projection of all active work: subagents,
 * background shells, and planning items. The authoritative sources remain AgentTool,
 * BgRegistry, TodoList, and session storage; WorkCenter subscribes to lifecycle events
 * and projects a unified queryable view without becoming a second execution engine.
 *
 * Provides stable IDs, status transitions, timestamps, ownership/nesting, activity detail,
 * and bounded transcript retention. Completed items remain visible for the session.
 */

import type { TodoItem } from '../agent/todo.js';
import type { EventBus, LoopEvent } from '../agent/events.js';
import { redactString } from '../util/redact.js';

export type WorkItemType = 'subagent' | 'bgshell' | 'plan';

export type WorkItemStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface WorkItemActivity {
  timestamp: number;
  type: 'tool' | 'output' | 'detail';
  tool?: string;
  text?: string;
}

export interface WorkItem {
  id: string;
  type: WorkItemType;
  status: WorkItemStatus;
  description: string;
  owner?: string; // parent work item ID
  depth: number; // nesting level (0 = top-level)
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  currentActivity?: string; // current tool name or state
  // Counters when available
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  toolCalls?: number;
  // Final result or exit reason
  exitReason?: string;
  finalOutput?: string;
  /** Only background subagents can be cancelled independently today. */
  background?: boolean;
  priority?: 'low' | 'normal' | 'high';
  retryable?: boolean;
  retryOf?: string;
  retryCount?: number;
  /** Bounded safe query facets; arbitrary tool arguments are never retained. */
  tools?: string[];
  files?: string[];
  // Bounded activity transcript
  activities: WorkItemActivity[];
}

export interface WorkCenterFilters {
  type?: WorkItemType | WorkItemType[];
  status?: WorkItemStatus | WorkItemStatus[];
  owner?: string;
}

export interface WorkCenterSnapshot {
  version: 1;
  capturedAt: number;
  items: WorkItem[];
}

/**
 * Limit for activity records per work item. Can be overridden via SHADOW_WORK_TRANSCRIPT_LIMIT
 * environment variable (validated positive integer with safe upper bound).
 */
const DEFAULT_ACTIVITY_LIMIT = 100;
const MAX_ACTIVITY_LIMIT = 10000;
const MAX_DETAIL_CHARS = 1000;
const MAX_FINAL_OUTPUT_CHARS = 64 * 1024;

function getActivityLimit(): number {
  const env = process.env.SHADOW_WORK_TRANSCRIPT_LIMIT;
  if (!env) return DEFAULT_ACTIVITY_LIMIT;
  const parsed = parseInt(env, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(parsed, MAX_ACTIVITY_LIMIT);
}

export class WorkCenter {
  private readonly items = new Map<string, WorkItem>();
  private readonly activityLimit: number;
  private busUnsubscribe?: () => void;
  private readonly listeners = new Set<(snapshot: WorkCenterSnapshot) => void>();

  constructor(activityLimit?: number) {
    this.activityLimit = activityLimit ?? getActivityLimit();
  }

  /** Subscribe to event bus lifecycle events to track work items */
  subscribe(bus: EventBus): void {
    this.busUnsubscribe?.();
    this.busUnsubscribe = bus.on((e) => this.handleEvent(e));
  }

  /** Unsubscribe from event bus */
  unsubscribe(): void {
    this.busUnsubscribe?.();
    this.busUnsubscribe = undefined;
  }

  onUpdate(listener: (snapshot: WorkCenterSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    if (!this.listeners.size) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* observers cannot break execution */ }
    }
  }

  private handleEvent(e: LoopEvent): void {
    switch (e.type) {
      case 'todo': {
        // TodoList already publishes this renderer-neutral event on every surface. Consuming it
        // here keeps plan projection parity for Ink, pi, web, ACP, and headless sessions.
        this.syncTodos(e.items);
        break;
      }
      case 'subagent_start': {
        const existing = this.items.get(e.taskId);
        if (existing) {
          // Re-announcement after queue wait
          existing.status = e.queued ? 'queued' : 'running';
          existing.lastActivityAt = Date.now();
          existing.background = e.background ?? existing.background;
          existing.owner = e.parentId ?? existing.owner;
          existing.depth = e.depth ?? existing.depth;
          existing.priority = e.priority ?? existing.priority;
        } else {
          const now = Date.now();
          this.items.set(e.taskId, {
            id: e.taskId,
            type: 'subagent',
            status: e.queued ? 'queued' : 'running',
            description: redactString(e.description || `${e.subagentType} task`).slice(0, MAX_DETAIL_CHARS),
            owner: e.parentId,
            depth: e.depth ?? 0,
            startedAt: now,
            lastActivityAt: now,
            background: e.background === true,
            priority: e.priority ?? 'normal',
            activities: [],
          });
        }
        this.notify();
        break;
      }
      case 'subagent_end': {
        const item = this.items.get(e.taskId);
        if (item) {
          if (item.status !== 'cancelled') item.status = e.ok ? 'completed' : 'failed';
          item.endedAt = Date.now();
          item.lastActivityAt = item.endedAt;
          item.currentActivity = undefined;
        }
        this.notify();
        break;
      }
      case 'tool_start': {
        if (e.subagent) {
          const item = this.items.get(e.subagent);
          if (item) {
            item.currentActivity = e.call.name;
            item.lastActivityAt = Date.now();
            item.toolCalls = (item.toolCalls ?? 0) + 1;
            if (!item.tools?.includes(e.call.name)) item.tools = [...(item.tools ?? []), e.call.name].slice(-100);
            const input = e.call.input as Record<string, unknown> | null;
            if (input && typeof input === 'object') {
              const rawPath = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : undefined;
              if (rawPath && rawPath.length <= 1000 && !/[\r\n\0]/.test(rawPath)) {
                const safePath = redactString(rawPath).slice(0, 500);
                if (!item.files?.includes(safePath)) item.files = [...(item.files ?? []), safePath].slice(-100);
              }
            }
            this.addActivity(item, {
              timestamp: Date.now(),
              type: 'tool',
              tool: e.call.name,
            });
          }
        }
        this.notify();
        break;
      }
      case 'tool_end': {
        if (e.subagent) {
          const item = this.items.get(e.subagent);
          if (item) {
            item.currentActivity = undefined;
            item.lastActivityAt = Date.now();
            this.addActivity(item, {
              timestamp: Date.now(),
              type: 'detail',
              tool: e.call.name,
              text: redactString(e.result.summary || '').slice(0, MAX_DETAIL_CHARS),
            });
          }
        }
        this.notify();
        break;
      }
      case 'subagent_usage': {
        if (e.taskId) {
          const item = this.items.get(e.taskId);
          if (item) {
            item.inputTokens = e.inputTokens;
            item.outputTokens = e.outputTokens;
            item.costUSD = e.costUSD;
            item.lastActivityAt = Date.now();
          }
        }
        this.notify();
        break;
      }
      case 'task_notification': {
        const item = this.items.get(e.taskId);
        if (item) {
          item.finalOutput = redactString(e.answer).slice(0, MAX_FINAL_OUTPUT_CHARS);
          item.lastActivityAt = Date.now();
        }
        this.notify();
        break;
      }
      case 'cancel_subagent': {
        if (e.taskId === '*') {
          // Cancel all running background subagents
          for (const item of this.items.values()) {
            if (item.type === 'subagent' && (item.status === 'running' || item.status === 'queued' || item.status === 'paused')) {
              item.status = 'cancelled';
              item.endedAt = Date.now();
              item.lastActivityAt = item.endedAt;
              item.currentActivity = undefined;
            }
          }
        } else {
          const item = this.items.get(e.taskId);
          if (item && item.type === 'subagent' && (item.status === 'running' || item.status === 'queued' || item.status === 'paused')) {
            item.status = 'cancelled';
            item.endedAt = Date.now();
            item.lastActivityAt = item.endedAt;
            item.currentActivity = undefined;
          }
        }
        this.notify();
        break;
      }
      case 'subagent_paused': {
        const item = this.items.get(e.taskId);
        if (item?.type === 'subagent' && (item.status === 'running' || item.status === 'queued')) {
          item.status = 'paused';
          item.currentActivity = 'paused at safe boundary';
          item.lastActivityAt = Date.now();
          this.notify();
        }
        break;
      }
      case 'pause_subagent': {
        const item = this.items.get(e.taskId);
        if (item?.type === 'subagent' && (item.status === 'running' || item.status === 'queued')) {
          item.currentActivity = 'pause requested';
          item.lastActivityAt = Date.now();
          this.notify();
        }
        break;
      }
      case 'resume_subagent': {
        const item = this.items.get(e.taskId);
        if (item?.type === 'subagent' && item.currentActivity === 'pause requested') {
          item.currentActivity = undefined;
          item.lastActivityAt = Date.now();
          this.notify();
        }
        break;
      }
      case 'subagent_resumed': {
        const item = this.items.get(e.taskId);
        if (item?.type === 'subagent' && item.status === 'paused') {
          item.status = 'running';
          item.currentActivity = undefined;
          item.lastActivityAt = Date.now();
          this.notify();
        }
        break;
      }
      case 'set_subagent_priority': {
        const item = this.items.get(e.taskId);
        if (item?.type === 'subagent' && item.status === 'queued') {
          item.priority = e.priority;
          item.lastActivityAt = Date.now();
          this.notify();
        }
        break;
      }
      case 'subagent_retryable': {
        const item = this.items.get(e.taskId);
        if (item?.type === 'subagent') {
          item.retryable = true;
          this.notify();
        }
        break;
      }
      case 'subagent_retry_link': {
        const item = this.items.get(e.taskId);
        if (item?.type === 'subagent') {
          item.retryOf = e.retryOf;
          item.retryCount = e.retryCount;
          item.retryable = true;
          this.notify();
        }
        break;
      }
      case 'subagent_retry_count': {
        const item = this.items.get(e.taskId);
        if (item?.type === 'subagent') {
          item.retryCount = e.retryCount;
          this.notify();
        }
        break;
      }
    }
  }

  private addActivity(item: WorkItem, activity: WorkItemActivity): void {
    item.activities.push(activity);
    item.lastActivityAt = activity.timestamp;
    // Enforce bounded retention
    if (item.activities.length > this.activityLimit) {
      item.activities.shift();
    }
  }

  /** Register a background shell (called by BgRegistry on shell launch) */
  registerShell(id: string, command: string, startedAt: number): void {
    const firstToken = command.trim().split(/\s+/, 1)[0] ?? '';
    // Shell arguments routinely contain credentials. Retain only a safe executable hint.
    const commandHint = firstToken && !firstToken.includes('=') ? firstToken.slice(0, 200) : 'background shell';
    this.items.set(id, {
      id,
      type: 'bgshell',
      status: 'running',
      description: commandHint,
      depth: 0,
      startedAt,
      lastActivityAt: startedAt,
      activities: [],
    });
    this.notify();
  }

  /** Update background shell status (called by BgRegistry on exit) */
  updateShellStatus(
    id: string,
    status: 'running' | 'completed' | 'failed',
    exitCode?: number | null,
    signal?: string | null,
  ): void {
    const item = this.items.get(id);
    if (item && item.type === 'bgshell') {
      if (item.status === 'cancelled' && status !== 'running') {
        item.lastActivityAt = Date.now();
        return;
      }
      item.status = status;
      item.lastActivityAt = Date.now();
      if (status !== 'running') {
        item.endedAt = Date.now();
        item.currentActivity = undefined;
        if (exitCode !== undefined && exitCode !== null) {
          item.exitReason = `exit code ${exitCode}`;
        } else if (signal) {
          item.exitReason = `signal ${signal}`;
        }
      }
      this.notify();
    }
  }

  /** Mark a user-requested shell termination without waiting for its close event. */
  cancelShell(id: string): void {
    const item = this.items.get(id);
    if (!item || item.type !== 'bgshell' || item.status !== 'running') return;
    const now = Date.now();
    item.status = 'cancelled';
    item.endedAt = now;
    item.lastActivityAt = now;
    item.currentActivity = undefined;
    item.exitReason = 'terminated by operator';
    this.notify();
  }

  /** Record shell output activity (bounded) */
  addShellOutput(id: string, stream: 'stdout' | 'stderr', chunk: string): void {
    const item = this.items.get(id);
    if (item && item.type === 'bgshell') {
      this.addActivity(item, {
        timestamp: Date.now(),
        type: 'output',
        text: `[${stream}] ${redactString(chunk).slice(0, 500)}`, // bounded + redacted snapshot
      });
      this.notify();
    }
  }

  /** Sync planning items from TodoList (called when todo updates) */
  syncTodos(todos: TodoItem[]): void {
    // Mark all existing plan items as stale
    const staleIds = new Set<string>();
    for (const [id, item] of this.items) {
      if (item.type === 'plan') staleIds.add(id);
    }

    // Update or create items from current todos
    for (const todo of todos) {
      const id = `plan_${todo.id}`;
      staleIds.delete(id);
      
      const existing = this.items.get(id);
      if (existing) {
        existing.description = redactString(todo.subject).slice(0, MAX_DETAIL_CHARS);
        existing.status =
          todo.status === 'completed' ? 'completed'
          : todo.status === 'in_progress' ? 'running'
          : 'queued';
        if (existing.status === 'completed' && !existing.endedAt) {
          existing.endedAt = Date.now();
        }
        existing.lastActivityAt = Date.now();
      } else {
        this.items.set(id, {
          id,
          type: 'plan',
          status:
            todo.status === 'completed' ? 'completed'
            : todo.status === 'in_progress' ? 'running'
            : 'queued',
          description: redactString(todo.subject).slice(0, MAX_DETAIL_CHARS),
          depth: 0,
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          activities: [],
        });
      }
    }

    // Remove stale plan items (todos that were deleted)
    for (const id of staleIds) {
      this.items.delete(id);
    }
    this.notify();
  }

  /** Get a single work item by ID */
  get(id: string): WorkItem | undefined {
    return this.items.get(id);
  }

  /** List all work items (optionally filtered) */
  list(filters?: WorkCenterFilters): WorkItem[] {
    let results = Array.from(this.items.values());

    if (filters?.type) {
      const types = Array.isArray(filters.type) ? filters.type : [filters.type];
      results = results.filter((item) => types.includes(item.type));
    }

    if (filters?.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      results = results.filter((item) => statuses.includes(item.status));
    }

    if (filters?.owner !== undefined) {
      results = results.filter((item) => item.owner === filters.owner);
    }

    return results.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Clear all work items (typically on session /clear) */
  clear(): void {
    this.items.clear();
    this.notify();
  }

  /** Get count of items matching filters */
  count(filters?: WorkCenterFilters): number {
    return this.list(filters).length;
  }

  snapshot(): WorkCenterSnapshot {
    return {
      version: 1,
      capturedAt: Date.now(),
      items: this.list().map((item) => ({
        ...item,
        activities: item.activities.map((activity) => ({ ...activity })),
      })),
    };
  }

  /** Restore a persisted projection. Live rows become failed/interrupted; processes are never revived. */
  restore(snapshot: WorkCenterSnapshot | null | undefined, markInterrupted = true): void {
    this.items.clear();
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.items)) {
      this.notify();
      return;
    }
    const now = Date.now();
    for (const raw of snapshot.items.slice(0, 1000)) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.description !== 'string') continue;
      if (!['subagent', 'bgshell', 'plan'].includes(raw.type)) continue;
      if (!['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'].includes(raw.status)) continue;
      const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
      const boundedList = (value: unknown, max = 100): string[] | undefined => {
        if (!Array.isArray(value)) return undefined;
        const out = value.filter((entry): entry is string => typeof entry === 'string').slice(-max).map((entry) => redactString(entry).slice(0, 500));
        return out.length ? out : undefined;
      };
      const item: WorkItem = {
        id: redactString(raw.id).slice(0, 500),
        type: raw.type,
        status: raw.status,
        description: redactString(raw.description).slice(0, MAX_DETAIL_CHARS),
        owner: typeof raw.owner === 'string' ? redactString(raw.owner).slice(0, 500) : undefined,
        depth: Math.max(0, Math.min(100, finite(raw.depth, 0))),
        startedAt: finite(raw.startedAt, now),
        lastActivityAt: finite(raw.lastActivityAt, now),
        endedAt: raw.endedAt === undefined ? undefined : finite(raw.endedAt, now),
        currentActivity: typeof raw.currentActivity === 'string' ? redactString(raw.currentActivity).slice(0, MAX_DETAIL_CHARS) : undefined,
        inputTokens: raw.inputTokens === undefined ? undefined : Math.max(0, finite(raw.inputTokens, 0)),
        outputTokens: raw.outputTokens === undefined ? undefined : Math.max(0, finite(raw.outputTokens, 0)),
        costUSD: raw.costUSD === undefined ? undefined : Math.max(0, finite(raw.costUSD, 0)),
        toolCalls: raw.toolCalls === undefined ? undefined : Math.max(0, finite(raw.toolCalls, 0)),
        exitReason: typeof raw.exitReason === 'string' ? redactString(raw.exitReason).slice(0, MAX_DETAIL_CHARS) : undefined,
        finalOutput: typeof raw.finalOutput === 'string' ? redactString(raw.finalOutput).slice(0, MAX_FINAL_OUTPUT_CHARS) : undefined,
        background: raw.background === true,
        priority: ['low', 'normal', 'high'].includes(String(raw.priority)) ? raw.priority : undefined,
        retryable: false,
        retryOf: typeof raw.retryOf === 'string' ? redactString(raw.retryOf).slice(0, 500) : undefined,
        retryCount: raw.retryCount === undefined ? undefined : Math.max(0, Math.min(3, finite(raw.retryCount, 0))),
        tools: boundedList(raw.tools),
        files: boundedList(raw.files),
        activities: Array.isArray(raw.activities)
          ? raw.activities.slice(-this.activityLimit).flatMap((activity): WorkItemActivity[] => {
              if (!activity || typeof activity !== 'object' || !['tool', 'output', 'detail'].includes(String(activity.type))) return [];
              return [{
                timestamp: finite(activity.timestamp, now),
                type: activity.type,
                tool: typeof activity.tool === 'string' ? redactString(activity.tool).slice(0, 200) : undefined,
                text: typeof activity.text === 'string' ? redactString(activity.text).slice(0, MAX_DETAIL_CHARS) : undefined,
              }];
            })
          : [],
      };
      if (markInterrupted && (item.status === 'queued' || item.status === 'running' || item.status === 'paused')) {
        item.status = 'failed';
        item.endedAt = now;
        item.lastActivityAt = now;
        item.currentActivity = undefined;
        item.exitReason = 'session ended before this work item completed';
      }
      this.items.set(item.id, item);
    }
    this.notify();
  }
}
