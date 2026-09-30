/**
 * Shared `/work` command semantics for both Ink and pi renderers.
 * Provides unified parsing, filtering, and formatting logic so both
 * terminals expose identical behavior.
 */

import type { WorkCenter, WorkItem, WorkItemStatus, WorkItemType, WorkCenterFilters } from '../app/workCenter.js';
import type { EventBus } from '../agent/events.js';
import type { BgRegistry } from '../tools/bgShell.js';
import type { HistoricalWorkItem } from '../state/workCenterPersistence.js';
import { approvalText } from '../util/approvalText.js';

export interface WorkCommandResult {
  kind: 'list' | 'detail' | 'cancel' | 'kill' | 'retry' | 'pause' | 'resume' | 'priority' | 'error';
  lines: string[];
  error?: string;
}

export interface WorkCommandOptions {
  workCenter: WorkCenter;
  bus: EventBus;
  bgRegistry: BgRegistry;
  /** Read-only snapshots from durable session logs. */
  workHistory?: (session?: string) => HistoricalWorkItem[];
}

interface ParsedFilters {
  filters?: WorkCenterFilters;
  id?: string;
  allSessions?: boolean;
  session?: string;
  tool?: string;
  file?: string;
  error?: string;
}

function parseFilters(arg: string): ParsedFilters {
  const parts = arg.split(/\s+/).filter(Boolean);
  const filters: WorkCenterFilters = {};
  let id: string | undefined;
  let allSessions = false;
  let session: string | undefined;
  let tool: string | undefined;
  let file: string | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '--type' && i + 1 < parts.length) {
      const typeArg = parts[++i];
      const types = typeArg.split(',').filter(Boolean) as WorkItemType[];
      if (types.some((t) => !['subagent', 'bgshell', 'plan'].includes(t))) {
        return { error: `Invalid type: ${typeArg}. Use: subagent, bgshell, or plan.` };
      }
      filters.type = types.length === 1 ? types[0] : types;
    } else if (part === '--status' && i + 1 < parts.length) {
      const statusArg = parts[++i];
      const statuses = statusArg.split(',').filter(Boolean) as WorkItemStatus[];
      if (statuses.some((s) => !['queued', 'running', 'paused', 'completed', 'failed', 'cancelled'].includes(s))) {
        return { error: `Invalid status: ${statusArg}. Use: queued, running, paused, completed, failed, or cancelled.` };
      }
      filters.status = statuses.length === 1 ? statuses[0] : statuses;
    } else if (part === '--all-sessions') {
      allSessions = true;
    } else if (part === '--session' && i + 1 < parts.length) {
      session = parts[++i];
    } else if (part === '--tool' && i + 1 < parts.length) {
      tool = parts[++i].toLowerCase();
    } else if (part === '--file' && i + 1 < parts.length) {
      file = parts[++i].toLowerCase();
    } else if (part.startsWith('--')) {
      return { error: `Unknown filter: ${part}` };
    } else if (!part.startsWith('--') && !id) {
      id = part;
    }
  }

  if (allSessions && session) return { error: 'Use either --all-sessions or --session, not both.' };
  return { filters, id, allSessions, session, tool, file };
}

function formatElapsed(startedAt: number, endedAt?: number): string {
  const elapsed = (endedAt ?? Date.now()) - startedAt;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatWorkItemSummary(item: WorkItem, sessionId?: string): string {
  const status = item.status.padEnd(10);
  const typeLabel = item.type === 'subagent' ? 'agent' : item.type === 'bgshell' ? 'shell' : 'plan';
  const elapsed = formatElapsed(item.startedAt, item.endedAt);
  const activity = item.currentActivity ? ` · ${approvalText(item.currentActivity)}` : '';
  const stalled = item.status === 'running' && Date.now() - item.lastActivityAt > 5 * 60_000 ? ' · ⚠ stalled' : '';
  const rawId = approvalText(sessionId ? `${sessionId.slice(-8)}::${item.id}` : item.id);
  const id = `${item.depth > 0 ? `${'  '.repeat(Math.min(item.depth, 4))}↳ ` : ''}${rawId}`;
  const owner = item.owner ? approvalText(item.owner).slice(-12) : '—';
  const safeDescription = approvalText(item.description);
  const description = safeDescription.length > 48 ? `${safeDescription.slice(0, 47)}…` : safeDescription;
  return `  ${id.padEnd(29)} ${typeLabel.padEnd(8)} ${status} ${elapsed.padEnd(9)} ${owner.padEnd(12)} ${description}${activity}${stalled}`;
}

function formatWorkItemDetail(item: WorkItem, sessionId?: string): string[] {
  const lines: string[] = [];
  lines.push(`Work Item: ${approvalText(item.id)}`);
  if (sessionId) lines.push(`  Session: ${approvalText(sessionId)} (historical, read-only)`);
  lines.push(`  Type: ${item.type}`);
  lines.push(`  Status: ${item.status}`);
  lines.push(`  Description: ${approvalText(item.description)}`);
  lines.push(`  Started: ${new Date(item.startedAt).toISOString()}`);
  if (item.endedAt) {
    lines.push(`  Ended: ${new Date(item.endedAt).toISOString()}`);
    lines.push(`  Duration: ${formatElapsed(item.startedAt, item.endedAt)}`);
  } else {
    lines.push(`  Elapsed: ${formatElapsed(item.startedAt)}`);
  }
  if (item.owner) {
    lines.push(`  Owner: ${approvalText(item.owner)} (depth ${item.depth})`);
  }
  if (item.priority) lines.push(`  Priority: ${item.priority}`);
  if (item.retryOf) lines.push(`  Retry of: ${item.retryOf} (attempt ${item.retryCount ?? 1}/3)`);
  if (item.status === 'running' && Date.now() - item.lastActivityAt > 5 * 60_000) {
    lines.push(`  Stall: no activity for ${formatElapsed(item.lastActivityAt)}`);
  }
  if (item.currentActivity) {
    lines.push(`  Current: ${approvalText(item.currentActivity)}`);
  }
  if (item.inputTokens !== undefined || item.outputTokens !== undefined) {
    lines.push(`  Tokens: in=${item.inputTokens ?? 0} out=${item.outputTokens ?? 0}`);
  }
  if (item.costUSD !== undefined) {
    lines.push(`  Cost: $${item.costUSD.toFixed(4)}`);
  }
  if (item.toolCalls !== undefined) {
    lines.push(`  Tool calls: ${item.toolCalls}`);
  }
  if (item.tools?.length) lines.push(`  Tools: ${item.tools.map(approvalText).join(', ')}`);
  if (item.files?.length) lines.push(`  Files: ${item.files.map(approvalText).join(', ')}`);
  if (item.exitReason) {
    lines.push(`  Exit: ${approvalText(item.exitReason)}`);
  }
  if (item.finalOutput) {
    const safeOutput = approvalText(item.finalOutput);
    lines.push(`  Result: ${safeOutput.slice(0, 200)}${safeOutput.length > 200 ? '…' : ''}`);
  }
  if (item.activities.length > 0) {
    lines.push(`  Recent activity (last ${Math.min(item.activities.length, 10)}):`);
    const recent = item.activities.slice(-10);
    for (const act of recent) {
      const time = new Date(act.timestamp).toISOString().split('T')[1].split('.')[0];
      const prefix = act.type === 'tool' ? `[tool:${act.tool}]` : act.type === 'output' ? '[output]' : '[detail]';
      const text = approvalText(act.text ?? '').slice(0, 80);
      lines.push(`    ${time} ${approvalText(prefix)} ${text}`);
    }
  }
  return lines;
}

/**
 * Execute a `/work` command and return formatted results.
 * Handles: /work [filters], /work show <id>, /work cancel <id>, /work kill <id>
 */
export function executeWorkCommand(arg: string, opts: WorkCommandOptions): WorkCommandResult {
  const { workCenter, bus, bgRegistry, workHistory } = opts;

  // Parse subcommand
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[0]?.toLowerCase();

  // /work show <id>
  if (subcommand === 'show' && parts.length >= 2) {
    const idArg = parts[1];
    const parsed = parseFilters(parts.slice(2).join(' '));
    if (parsed.error) return { kind: 'error', lines: [], error: parsed.error };
    const split = idArg.indexOf('::');
    const explicitSession = split >= 0 ? idArg.slice(0, split) : parsed.session;
    const id = split >= 0 ? idArg.slice(split + 2) : idArg;
    if (explicitSession || parsed.allSessions) {
      if (!workHistory) return { kind: 'error', lines: [], error: 'Cross-session Work Center history is unavailable.' };
      const match = workHistory(explicitSession).find((row) => row.item.id === id && (!explicitSession || row.sessionId.endsWith(explicitSession)));
      if (!match) return { kind: 'error', lines: [], error: `No historical work item found: ${idArg}` };
      return { kind: 'detail', lines: formatWorkItemDetail(match.item, match.sessionId) };
    }
    const item = workCenter.get(id);
    if (!item) {
      return { kind: 'error', lines: [], error: `No work item found: ${id}` };
    }
    return { kind: 'detail', lines: formatWorkItemDetail(item) };
  }

  // /work cancel <id> - cancels a subagent
  if (subcommand === 'cancel' && parts.length >= 2) {
    const id = parts[1];
    const item = workCenter.get(id);
    if (!item) {
      return { kind: 'error', lines: [], error: `No work item found: ${id}` };
    }
    if (item.type !== 'subagent') {
      return { kind: 'error', lines: [], error: `Cannot cancel ${item.type} (only subagents are cancellable)` };
    }
    if (!item.background) {
      return { kind: 'error', lines: [], error: 'Foreground subagents are inspect-only; only background subagents can be cancelled.' };
    }
    if (item.status !== 'running' && item.status !== 'queued' && item.status !== 'paused') {
      return { kind: 'error', lines: [], error: `Cannot cancel ${item.status} subagent` };
    }
    bus.emit({ type: 'cancel_subagent', taskId: id });
    return { kind: 'cancel', lines: [`Cancelling subagent ${id}…`] };
  }

  if (subcommand === 'pause' && parts.length >= 2) {
    const item = workCenter.get(parts[1]);
    if (!item || item.type !== 'subagent') return { kind: 'error', lines: [], error: `No subagent found: ${parts[1]}` };
    if (!item.background) return { kind: 'error', lines: [], error: 'Only background subagents can be paused.' };
    if (item.status !== 'running' && item.status !== 'queued') return { kind: 'error', lines: [], error: `Cannot pause ${item.status} subagent` };
    bus.emit({ type: 'pause_subagent', taskId: item.id });
    return { kind: 'pause', lines: [`Pause requested for ${item.id}; it will stop at the next safe model/tool boundary.`] };
  }

  if (subcommand === 'resume' && parts.length >= 2) {
    const item = workCenter.get(parts[1]);
    if (!item || item.type !== 'subagent') return { kind: 'error', lines: [], error: `No subagent found: ${parts[1]}` };
    if (item.status !== 'paused' && item.currentActivity !== 'pause requested') return { kind: 'error', lines: [], error: `Subagent ${item.id} is not paused.` };
    bus.emit({ type: 'resume_subagent', taskId: item.id });
    return { kind: 'resume', lines: [`Resuming ${item.id}.`] };
  }

  if (subcommand === 'priority' && parts.length >= 3) {
    const item = workCenter.get(parts[1]);
    const priority = parts[2] as 'low' | 'normal' | 'high';
    if (!item || item.type !== 'subagent') return { kind: 'error', lines: [], error: `No subagent found: ${parts[1]}` };
    if (!['low', 'normal', 'high'].includes(priority)) return { kind: 'error', lines: [], error: 'Priority must be low, normal, or high.' };
    if (item.status !== 'queued') return { kind: 'error', lines: [], error: 'Priority can only be changed while a subagent is queued.' };
    bus.emit({ type: 'set_subagent_priority', taskId: item.id, priority });
    return { kind: 'priority', lines: [`Priority for ${item.id} set to ${priority}.`] };
  }

  if (subcommand === 'retry' && parts.length >= 2) {
    const item = workCenter.get(parts[1]);
    if (!item || item.type !== 'subagent') return { kind: 'error', lines: [], error: `No subagent found: ${parts[1]}` };
    if (!parts.includes('--confirm')) return { kind: 'error', lines: [], error: 'Retry starts a new run and may duplicate external effects. Re-run with --confirm.' };
    if (!['completed', 'failed', 'cancelled'].includes(item.status)) return { kind: 'error', lines: [], error: `Cannot retry ${item.status} subagent` };
    if (!item.retryable) return { kind: 'error', lines: [], error: 'This item has no in-memory retry specification (historical retries are read-only).' };
    if ((item.retryCount ?? 0) >= 3) return { kind: 'error', lines: [], error: 'Maximum retry count (3) reached.' };
    bus.emit({ type: 'retry_subagent', taskId: item.id });
    return { kind: 'retry', lines: [`Retry scheduled for ${item.id} as a linked new background run.`] };
  }

  // /work kill <id> - kills a background shell
  if (subcommand === 'kill' && parts.length >= 2) {
    const id = parts[1];
    const item = workCenter.get(id);
    if (!item) {
      return { kind: 'error', lines: [], error: `No work item found: ${id}` };
    }
    if (item.type !== 'bgshell') {
      return { kind: 'error', lines: [], error: `Cannot kill ${item.type} (only background shells are killable)` };
    }
    if (item.status !== 'running') {
      return { kind: 'error', lines: [], error: `Shell ${id} is not running` };
    }
    const killed = bgRegistry.kill(id);
    if (!killed) {
      return { kind: 'error', lines: [], error: `Failed to kill ${id}` };
    }
    return { kind: 'kill', lines: [`Sent SIGTERM to shell ${id}`] };
  }

  // /work list or /work [filters]
  const filterArg = subcommand === 'list' ? parts.slice(1).join(' ') : arg;
  const { filters, allSessions, session, tool, file, error } = parseFilters(filterArg);
  if (error) {
    return { kind: 'error', lines: [], error };
  }

  const matchesExtra = (item: WorkItem): boolean => {
    if (tool && !(item.tools ?? item.activities.map((activity) => activity.tool).filter(Boolean) as string[]).some((name) => name.toLowerCase().includes(tool))) return false;
    if (file) {
      const haystack = [item.description, item.finalOutput, ...(item.files ?? []), ...item.activities.map((activity) => activity.text)].filter(Boolean).join('\n').toLowerCase();
      if (!haystack.includes(file)) return false;
    }
    return true;
  };
  const matchesBase = (item: WorkItem): boolean => {
    const type = filters?.type;
    const status = filters?.status;
    if (type && !(Array.isArray(type) ? type : [type]).includes(item.type)) return false;
    if (status && !(Array.isArray(status) ? status : [status]).includes(item.status)) return false;
    return matchesExtra(item);
  };
  const historical = allSessions || session
    ? (workHistory?.(session) ?? []).filter((row) => matchesBase(row.item))
    : [];
  const items = allSessions || session ? [] : workCenter.list(filters).filter(matchesExtra);
  if (items.length === 0 && historical.length === 0) {
    const filterDesc = filters?.type || filters?.status ? ' matching filters' : '';
    return { kind: 'list', lines: [`No work items${filterDesc}.`] };
  }

  const lines: string[] = [];
  lines.push(historical.length ? 'Work Center history (read-only):' : 'Work Center:');
  lines.push(`  ${historical.length ? 'Session::ID'.padEnd(29) : 'ID'.padEnd(29)} Type     Status     Elapsed   Owner        Description`);
  for (const item of items) {
    lines.push(formatWorkItemSummary(item));
  }
  for (const row of historical) lines.push(formatWorkItemSummary(row.item, row.sessionId));
  lines.push('');
  lines.push('Commands: show · cancel · kill · pause · resume · priority <id> <level> · retry <id> --confirm');
  lines.push('Filters: --type subagent,bgshell,plan · --status queued,running,completed');
  lines.push('History: --all-sessions · --session <id> · --tool <name> · --file <path> (read-only)');

  return { kind: 'list', lines };
}
