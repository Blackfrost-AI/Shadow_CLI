import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import type { LoopEvent } from '../agent/events.js';
import { isBashReadOnly } from '../safety/bashReadOnly.js';
import { sanitizeTerminalEscapes } from '../util/scrub.js';
import { displayToolArg, displayToolName, isCollapsibleTool } from './toolDisplay.js';
import { agentAttr, oneLine, shellCommandOf } from './format.js';
import { previewOf } from './headless.js';
import type { TranscriptBase } from './rows.js';

export type ToolEnd = Extract<LoopEvent, { type: 'tool_end' }>;
export type TranscriptDraft = Omit<TranscriptBase, 'id'>;
export interface ActivitySummary {
  id: number;
  tools: number;
  commands: number;
  reads: number;
  searches: number;
  thoughts: number;
  failed: number;
  closed: boolean;
}
export interface ActivityEntry {
  id: number;
  title: string;
  ok: boolean;
  kind: 'tool' | 'reasoning';
}
interface Group extends ActivitySummary {
  entries: ActivityEntry[];
}

/** Presentation only. Permissions still use the executor's normal scoped classification.
 * Inspect the WHOLE shell command; unknown commands and mutations keep their own visible row.
 * Filesystem scope is irrelevant to display grouping, so allow the filesystem root here only.
 */
export function isRoutineCall(name: string, input: unknown): boolean {
  if (name === 'memory') {
    const action = (input as { action?: string } | undefined)?.action;
    return action === 'list' || action === 'get' || action === 'recall';
  }
  if (name === 'run_shell') {
    const command = shellCommandOf(input);
    // Descriptor duplication only changes where output appears. Remove it for this display
    // classifier because the safety classifier conservatively splits '&' as a command boundary.
    // File redirections, substitutions and all command stages still go through its checks.
    const displayCommand = command?.replace(/\d*>&\d+\b/g, '');
    return !!displayCommand && isBashReadOnly(displayCommand, [parse(process.cwd()).root]);
  }
  return isCollapsibleTool(name);
}

export function activityLabel(a: ActivitySummary): string {
  const parts: string[] = [];
  if (a.commands) parts.push(`${a.commands} command${a.commands === 1 ? '' : 's'}`);
  if (a.reads) parts.push(`${a.reads} file read${a.reads === 1 ? '' : 's'}`);
  if (a.searches) parts.push(`${a.searches} search${a.searches === 1 ? '' : 'es'}`);
  const other = a.tools - a.commands - a.reads - a.searches;
  if (other) parts.push(`${other} other action${other === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'Thinking';
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '[Result could not be formatted]';
  }
}

export function toolDetail(e: ToolEnd): string {
  const data = e.result.data as { stdout?: string; stderr?: string } | undefined;
  const sections = [displayToolName(e.call.name), json(e.call.input), e.result.summary];
  if (typeof data?.stdout === 'string' || typeof data?.stderr === 'string') {
    if (data.stdout) sections.push(`stdout:\n${data.stdout}`);
    if (data.stderr) sections.push(`stderr:\n${data.stderr}`);
  } else if (e.result.data !== undefined) sections.push(json(e.result.data));
  if (e.result.meta?.diff?.length)
    sections.push(e.result.meta.diff.map((d) => `${d.tag} ${d.text}`).join('\n'));
  return sanitizeTerminalEscapes(sections.filter(Boolean).join('\n\n'), false);
}

/** Full details are spooled outside React, with private permissions. Only metadata and a small
 * summary live in the render tree. A disk failure falls back to memory rather than losing output.
 * Files belong to this UI session and are removed on clear/unmount; the session log is unchanged.
 */
export class ActivityHistory {
  private groups: Group[] = [];
  private current: Group | null = null;
  private details = new Map<number, { file: string } | { text: string }>();
  private dir: string | undefined;
  private nextEntry = 1;
  private nextGroup = 1;

  private group(): Group {
    if (!this.current) {
      this.current = {
        id: this.nextGroup++,
        tools: 0,
        commands: 0,
        reads: 0,
        searches: 0,
        thoughts: 0,
        failed: 0,
        closed: false,
        entries: [],
      };
      this.groups.push(this.current);
    }
    return this.current;
  }

  private add(title: string, text: string, kind: ActivityEntry['kind'], ok = true): Group {
    const group = this.group();
    const id = this.nextEntry++;
    try {
      this.dir ??= mkdtempSync(join(tmpdir(), 'shadow-activity-'));
      const file = join(this.dir, `${id}.txt`);
      writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
      this.details.set(id, { file });
    } catch {
      this.details.set(id, { text });
    }
    group.entries.push({ id, title: sanitizeTerminalEscapes(title, false), kind, ok });
    if (!ok) group.failed++;
    return group;
  }

  reasoning(text: string, durationMs: number): void {
    if (!text.trim()) return;
    const seconds = Math.max(0, Math.round(durationMs / 1000));
    this.add(
      `Thinking${seconds ? ` · ${seconds}s` : ''}`,
      sanitizeTerminalEscapes(text, false),
      'reasoning',
    ).thoughts++;
  }

  tool(e: ToolEnd): void {
    const title = `${e.result.ok ? 'DONE' : 'FAILED'} ${displayToolName(e.call.name)} ${displayToolArg(previewOf(e.call.input), 90)}`;
    const group = this.add(title, toolDetail(e), 'tool', e.result.ok);
    group.tools++;
    if (e.call.name === 'run_shell') group.commands++;
    else if (e.call.name === 'read_file') group.reads++;
    else if (e.call.name === 'grep' || e.call.name === 'glob') group.searches++;
  }

  summary(): ActivitySummary | null {
    if (!this.current) return null;
    const { entries: _, ...summary } = this.current;
    return summary;
  }

  close(): ActivitySummary | null {
    if (!this.current) return null;
    this.current.closed = true;
    const summary = this.summary();
    this.current = null;
    return summary;
  }

  list(): ActivitySummary[] {
    return this.groups.map(({ entries: _, ...g }) => ({ ...g }));
  }
  entries(id: number): ActivityEntry[] {
    return [...(this.groups.find((g) => g.id === id)?.entries ?? [])];
  }
  read(id: number): string {
    const detail = this.details.get(id);
    if (!detail) return 'Details are no longer available.';
    if ('text' in detail) return detail.text;
    try {
      return readFileSync(detail.file, 'utf8');
    } catch {
      return 'Could not read these details. The session log may contain the result.';
    }
  }

  reset(): void {
    if (this.dir) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    this.dir = undefined;
    this.groups = [];
    this.current = null;
    this.details.clear();
    // IDs are never reused: a stale view must not resolve to a different result after reset.
  }
}

export function activityDraft(summary: ActivitySummary): TranscriptDraft {
  return {
    kind: 'activity',
    activityId: summary.id,
    text: `[${summary.failed ? 'FAILED' : 'DONE'}] ${activityLabel(summary)} · /activity ${summary.id}`,
  };
}

/** Exceptional tools keep a concise visible result. Complete output is in the detail journal. */
export function toolDraft(e: ToolEnd, activityId: number): TranscriptDraft {
  const diff = e.result.meta?.diff;
  const changed = diff?.filter((d) => d.tag === '+' || d.tag === '-');
  const summary = changed?.length
    ? `+${changed.filter((d) => d.tag === '+').length} −${changed.filter((d) => d.tag === '-').length}`
    : oneLine(e.result.summary).replace(/^Command exited 0\.?$/, '');
  return {
    kind: 'tool',
    text: summary,
    activityId,
    tool: {
      name: e.call.name,
      arg: previewOf(e.call.input),
      ok: e.result.ok,
      durationMs: Math.max(0, e.result.meta?.durationMs ?? 0),
      summary,
      agent: e.call.name === 'agent' ? agentAttr(e.call.input) : undefined,
    },
    lines: changed?.slice(0, 2).map((d) => ({ text: `${d.tag} ${d.text}` })),
    meta: changed?.length ? 'diff' : undefined,
  };
}
