import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import type { WorkItem } from './workCenter.js';
import { formatWorkItemDetail } from '../tui/workCommand.js';
import { approvalText } from '../util/approvalText.js';
import { panelRows } from './panel.js';
import { style } from './ansi.js';
import { C } from '../tui/theme.js';

interface WorkAction { label: string; command?: string; artifacts?: boolean; job?: boolean; confirm?: boolean }
export function workActions(item: WorkItem): WorkAction[] {
  const actions: WorkAction[] = [];
  if (item.jobId) actions.push({ label: 'Inspect job and acceptance', job: true });
  if (item.artifactIds?.length) actions.push({ label: 'Inspect retained artifacts', artifacts: true });
  if (item.type === 'subagent' && item.background) {
    if (['running', 'queued', 'paused', 'waiting'].includes(item.status)) actions.push({ label: 'Cancel worker', command: `cancel ${item.id}` });
    if (['running', 'queued'].includes(item.status)) actions.push({ label: 'Pause at the next safe boundary', command: `pause ${item.id}` });
    if (item.status === 'paused') actions.push({ label: 'Resume worker', command: `resume ${item.id}` });
  }
  if (item.type === 'bgshell' && item.status === 'running') actions.push({ label: 'Stop background command', command: `kill ${item.id}` });
  if (item.type === 'subagent' && item.retryable && ['failed', 'partial', 'cancelled', 'interrupted', 'completed'].includes(item.status)) {
    actions.push({ label: 'Retry as a new attempt (may repeat effects)', command: `retry ${item.id} --confirm`, confirm: true });
  }
  if (item.type === 'subagent' && item.status === 'queued') for (const priority of ['high', 'normal', 'low']) {
    actions.push({ label: `Priority: ${priority}`, command: `priority ${item.id} ${priority}` });
  }
  return actions;
}

/** Live projection only: all controls go through the existing Work Center command dispatcher. */
export class WorkBrowser implements Component {
  private selectedId: string | undefined;
  private index = 0;
  private detail = false;
  private offset = 0;
  private actionIndex: number | null = null;
  private confirm: WorkAction | null = null;
  private digits = '';
  private query = '';
  private searching = false;
  private message = '';
  constructor(private options: {
    items: () => WorkItem[]; rows: () => number; repaint: () => void; close: () => void;
    command: (command: string) => string; artifacts: (item: WorkItem) => void;
    job?: (id: string) => void;
    title?: string;
  }) {}
  invalidate(): void {}
  private items(): WorkItem[] {
    const items = this.options.items().filter((item) => `${item.id} ${item.type} ${item.description} ${item.status}`.toLowerCase().includes(this.query.toLowerCase()));
    const at = items.findIndex((item) => item.id === this.selectedId);
    this.index = at >= 0 ? at : Math.min(this.index, Math.max(0, items.length - 1));
    this.selectedId = items[this.index]?.id;
    return items;
  }
  render(width: number): string[] {
    const items = this.items();
    const item = items[this.index];
    const limit = Math.max(1, this.options.rows() - 9);
    let lines: string[];
    let hint = '↑/↓ or number · Enter details · / search · Esc close';
    if (this.confirm) {
      lines = [this.confirm.label, 'A retry starts new execution and can repeat external effects.', 'Enter to start · Escape to return'];
      hint = 'Enter confirm · Esc back';
    } else if (this.actionIndex !== null && item) {
      lines = workActions(item).map((action, i) => i === this.actionIndex ? style.fg(C.accent, `› ${action.label}`) : `  ${action.label}`);
      if (!lines.length) lines = ['No supported controls for this item.'];
      hint = '↑/↓ action · Enter choose · Esc details';
    } else if (this.detail && item) {
      const detail = formatWorkItemDetail(item).flatMap((line) => line.split('\n'));
      this.offset = Math.max(0, Math.min(this.offset, Math.max(0, detail.length - limit)));
      lines = detail.slice(this.offset, this.offset + limit).map(approvalText);
      hint = '↑/↓ scroll · a actions · Esc list';
    } else {
      const start = Math.max(0, this.index - limit + 1);
      lines = items.slice(start, start + limit).map((entry, i) => {
        const label = `${i + start + 1}. ${entry.status.padEnd(11)} ${entry.type === 'subagent' ? 'agent' : entry.type === 'bgshell' ? 'shell' : entry.type}  ${approvalText(entry.description)}${entry.artifactIds?.length ? '  ◇ artifact' : ''}`;
        return i + start === this.index ? style.fg(C.accent, `› ${label}`) : `  ${label}`;
      });
      if (!lines.length) lines = [this.query ? 'No work matches this search.' : 'No work yet. Agents, commands and plan steps appear here as they run.'];
    }
    if (this.message) lines.push(style.dim(approvalText(this.message)));
    if (this.searching) hint = `Search: ${approvalText(this.query)} · Enter finish · Esc clear`;
    else if (this.digits) hint = `Choice ${this.digits} · Enter details · Esc close`;
    return panelRows(this.options.title ?? `Work Center · ${items.length} items`, lines, width, hint);
  }
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const items = this.items();
    const item = items[this.index];
    if (this.searching) {
      if (matchesKey(data, 'escape')) { this.searching = false; this.query = ''; }
      else if (matchesKey(data, 'enter')) this.searching = false;
      else if (matchesKey(data, 'backspace')) this.query = this.query.slice(0, -1);
      else if (!/[\x00-\x1f\x7f]/.test(data)) this.query = (this.query + data).slice(0, 150);
      this.index = 0; this.selectedId = undefined; this.options.repaint(); return;
    }
    if (matchesKey(data, 'escape')) {
      if (this.confirm) this.confirm = null;
      else if (this.actionIndex !== null) this.actionIndex = null;
      else if (this.detail) { this.detail = false; this.offset = 0; }
      else { this.options.close(); return; }
    } else if (matchesKey(data, 'enter')) {
      if (this.confirm) { this.message = this.options.command(this.confirm.command!); this.confirm = null; this.actionIndex = null; }
      else if (this.actionIndex !== null && item) {
        const action = workActions(item)[this.actionIndex];
        if (action?.job && item.jobId) { this.options.job?.(item.jobId); return; }
        if (action?.artifacts) { this.options.artifacts(item); return; }
        if (action?.confirm) this.confirm = action;
        else if (action?.command) { this.message = this.options.command(action.command); this.actionIndex = null; }
      } else if (item) { this.detail = true; this.digits = ''; }
    } else if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      const delta = matchesKey(data, 'up') ? -1 : 1;
      if (this.actionIndex !== null && item) this.actionIndex = Math.max(0, Math.min(workActions(item).length - 1, this.actionIndex + delta));
      else if (this.detail) this.offset = Math.max(0, this.offset + delta);
      else { this.index = Math.max(0, Math.min(items.length - 1, this.index + delta)); this.selectedId = items[this.index]?.id; this.digits = ''; }
    } else if (data === 'a' && this.detail) this.actionIndex = 0;
    else if (data === '/' && !this.detail) this.searching = true;
    else if (/^\d+$/.test(data) && !this.detail) {
      this.digits = (this.digits + data).slice(0, 6);
      const at = Number(this.digits) - 1;
      if (items[at]) { this.index = at; this.selectedId = items[at]!.id; }
    } else if (matchesKey(data, 'backspace') && !this.detail) this.digits = this.digits.slice(0, -1);
    this.options.repaint();
  }
}
