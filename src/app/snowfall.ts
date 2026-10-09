// Fullscreen composition. Components read live state; layout owns the available space.
import { CURSOR_MARKER, Editor, ScrollView, Spacer, VStack, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import type { TodoItem } from '../agent/todo.js';
import type { SubAgentView } from '../tui/subagentPanel.js';
import { BORDER, GLYPHS, SPACING } from '../tui/glyphs.js';
import { C } from '../tui/theme.js';
import { formatDuration } from '../tui/format.js';
import { approvalText } from '../util/approvalText.js';
import { bgAnsi, RESET, style } from './ansi.js';

export interface SnowfallState {
  version: string;
  workspace: string;
  providerModel: string;
  autonomy: string;
  planMode: boolean;
  bypass: boolean;
  running: boolean;
  startedAt: number;
  tick: number;
  reducedMotion: boolean;
  queued: number;
  toolLine: string | null;
  todos: TodoItem[];
  agents: SubAgentView[];
  contextPct: number;
  costUSD: number;
  goal: string | null;
  missionLine: string;
  mcpConnecting: boolean;
  mcpFailed: boolean;
}

const safe = (text: string) => approvalText(text).replace(/\s+/g, ' ').trim();
const cut = (text: string, width: number) => truncateToWidth(text, Math.max(0, width), '…');
const STATUS_SPACER_MIN_ROWS = 16;

function rule(label: string, width: number): string {
  const text = cut(` ${label} `, Math.max(0, width - 2));
  return style.fg(C.border ?? C.dim, BORDER.topLeft + text + BORDER.horizontal.repeat(Math.max(0, width - visibleWidth(text) - 2)) + BORDER.topRight);
}

function fill(line: string, width: number, background: string): string {
  const row = cut(line, width);
  return bgAnsi(background) + row.replaceAll(RESET, RESET + bgAnsi(background)) + ' '.repeat(Math.max(0, width - visibleWidth(row))) + RESET;
}

export class SnowfallHeader implements Component {
  constructor(private state: () => SnowfallState) {}
  invalidate(): void {}
  render(width: number): string[] {
    const s = this.state();
    const brand = style.fg(C.accent, `${GLYPHS.assistant} SHADOW`) + style.dim(`  ${safe(s.version)}`);
    const workspace = style.dim(safe(s.workspace));
    const hint = width >= 90 ? style.dim('Ctrl+Shift+F search') : '';
    const room = Math.max(0, width - visibleWidth(brand) - visibleWidth(hint) - 8);
    const left = brand + (room >= 8 ? '  ' + cut(workspace, room) : '');
    const row = '  ' + left + ' '.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(hint) - 4)) + hint + '  ';
    return [fill(row, width, C.panel ?? C.menuBg), style.fg(C.border ?? C.dim, BORDER.horizontal.repeat(width))];
  }
}

export class SnowfallStatus implements Component {
  constructor(private state: () => SnowfallState, private now = Date.now) {}
  invalidate(): void {}
  render(width: number): string[] {
    const s = this.state();
    const mode = s.bypass ? 'BYPASS' : s.planMode ? 'PLAN' : s.autonomy;
    const color = s.bypass || s.planMode ? C.yellow : C.accent;
    const parts = [style.fg(color, safe(mode))];
    if (s.running) {
      const frame = GLYPHS.spinner[(s.reducedMotion ? 0 : s.tick) % GLYPHS.spinner.length]!;
      parts.push(style.fg(C.accent, `${frame} working ${formatDuration((this.now() - s.startedAt) / 1000)}`));
      parts.push(style.dim('Esc interrupt'));
    }
    if (s.queued) parts.push(style.fg(C.yellow, `${s.queued} queued`));
    if (s.mcpConnecting) parts.push(style.dim('MCP connecting'));
    else if (s.mcpFailed) parts.push(style.fg(C.yellow, 'MCP failed'));

    // Keep session activity on the left and compact totals on the right, with equal
    // outer margins. Drop whole optional items when space is tight rather than clip them.
    const available = Math.max(0, width - SPACING.page * 2);
    const separatorText = width >= 100 ? '  ·  ' : ' · ';
    const separator = style.dim(separatorText);
    const groupGap = width >= 100 ? 6 : 3;
    let left = parts.join(separator);
    const summaries: string[] = [];
    if (s.missionLine && width >= 110) summaries.push(style.dim(cut(safe(s.missionLine), 28)));
    const activeAgents = s.agents.filter((agent) => !agent.done).length;
    if (activeAgents) summaries.push(style.dim(`${activeAgents} agent${activeAgents === 1 ? '' : 's'}`));
    if (s.todos.length) summaries.push(style.dim(`${s.todos.filter((t) => t.status === 'completed').length}/${s.todos.length} tasks`));
    if (width >= 70) {
      const pct = Math.max(0, Math.min(100, Math.round(s.contextPct * 100)));
      summaries.push(style.fg(pct > 85 ? C.red : pct > 70 ? C.yellow : C.dim, `ctx ${pct}%`));
    }
    if (width >= 90) summaries.push(style.dim(`$${s.costUSD.toFixed(4)}`));
    let right = '';
    for (const summary of summaries) {
      const next = right ? right + separator + summary : summary;
      if (visibleWidth(left) + groupGap + visibleWidth(next) <= available) right = next;
    }
    const leftRoom = Math.max(0, available - (right ? visibleWidth(right) + groupGap : 0));
    const detail = s.running ? width >= 100 ? s.toolLine : null : s.providerModel;
    const detailRoom = leftRoom - visibleWidth(left) - separatorText.length;
    if (detail && detailRoom >= 8) left += separator + style.dim(cut(safe(detail), Math.min(40, detailRoom)));
    left = cut(left, leftRoom);
    const padding = ' '.repeat(SPACING.page);
    const gap = ' '.repeat(Math.max(0, available - visibleWidth(left) - visibleWidth(right)));
    return [fill(padding + left + gap + right + padding, width, C.panel ?? C.menuBg)];
  }
}

/** The editor keeps its own cursor/wrapping logic. Crop around its cursor only on short screens,
 * and map mouse coordinates back to those original rows so clicks still edit the visible text. */
export class SnowfallEditor extends Editor {
  private rowMap: number[] = [];
  constructor(tui: TUI, theme: EditorTheme, private getState: () => SnowfallState, private rows: () => number) {
    super(tui, theme, { paddingX: SPACING.page, autocompleteMaxVisible: 5 });
  }
  protected override renderTopBorder(width: number, hidden: number): string {
    const s = this.getState();
    return rule(`${s.planMode ? 'Plan' : s.running ? 'Queue a follow-up' : 'Message'}${hidden ? ` · ↑ ${hidden}` : ''}`, width);
  }
  protected override renderBottomBorder(width: number, hidden: number): string {
    const hint = hidden ? `↓ ${hidden}` : width >= 65 ? 'Enter send · Shift+Enter newline · / commands · @ files' : 'Enter send · / commands';
    return rule(hint, width).replace(BORDER.topLeft, BORDER.bottomLeft).replace(BORDER.topRight, BORDER.bottomRight);
  }
  override render(width: number): string[] {
    const lines = super.render(width);
    // Replace existing padding, preserving the editor's exact two-cell input geometry.
    if (width >= 5 && lines[1]?.startsWith('  ')) lines[1] = style.fg(C.accent, GLYPHS.promptPrefix) + lines[1].slice(2);
    const height = this.rows();
    const reserved = height >= STATUS_SPACER_MIN_ROWS ? 6 : height >= 10 ? 5 : 2;
    const budget = Math.max(1, Math.min(lines.length, height - reserved));
    this.rowMap = lines.map((_, i) => i);
    if (lines.length > budget) {
      const cursor = Math.max(1, lines.findIndex((line) => line.includes(CURSOR_MARKER)));
      const start = Math.max(0, Math.min(lines.length - budget, cursor - Math.floor(budget / 2)));
      this.rowMap = this.rowMap.slice(start, start + budget);
    }
    return this.rowMap.map((i) => lines[i]!);
  }
  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return super.handleMouse({ ...event, y: this.rowMap[event.y] ?? event.y });
  }
}

export function snowfallLayout(document: Component, editor: Component, state: () => SnowfallState): { root: VStack; scroll: ScrollView } {
  const scroll = new ScrollView(document, {
    primary: true, follow: 'end', scrollbar: 'auto',
    scrollbarThumbStyle: (text) => style.fg(C.border ?? C.dim, text),
    scrollbarTrackStyle: (text) => style.dim(text),
  });
  const root = new VStack([
    { component: new SnowfallHeader(state), basis: 2, shrink: 0, visible: ({ height }) => height >= 10 },
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 0 },
    { component: editor, basis: 'auto', shrink: 0 },
    { component: new Spacer(1), basis: 1, shrink: 0, visible: ({ height }) => height >= STATUS_SPACER_MIN_ROWS },
    { component: new SnowfallStatus(state), basis: 1, shrink: 0 },
  ]);
  return { root, scroll };
}
