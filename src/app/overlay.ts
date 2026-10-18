// src/app/overlay.ts — anchored overlay primitive for Snowfall.
//
// Ctrl-T used to dump tasks into the transcript where they scrolled away.
// Anchored overlays live ABOVE the transcript (pi-tui showOverlay) and
// don't scroll with the stream. Esc/q dismisses.

import type { Component } from '@earendil-works/pi-tui';
import { isKeyRelease, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { style } from './ansi.js';
import { C } from '../tui/theme.js';
import { panelRows } from './panel.js';
import type { TodoItem } from '../agent/todo.js';

export interface OverlayOpts {
  title: string;
  hint: string;
  onClose: () => void;
  rows: () => number;
}

export abstract class OverlayBase implements Component {
  protected offset = 0;
  protected cachedWidth = -1;
  protected cachedLines: string[] | null = null;

  constructor(protected opts: OverlayOpts) {}

  invalidate(): void { this.cachedLines = null; }

  // Subclasses produce raw content lines (unframed).
  protected abstract contentLines(width: number): string[];

  protected viewportRows(): number {
    const r = this.opts.rows();
    return Math.max(8, Math.min((typeof r === 'number' ? r : 24) - 6, 32));
  }

  protected handleScrollKeys(data: string, totalLines: number): boolean {
    const page = Math.max(1, this.viewportRows() - 2);
    const last = Math.max(0, totalLines - this.viewportRows());
    if (matchesKey(data, 'escape') || data === 'q') { this.opts.onClose(); return true; }
    if (matchesKey(data, 'up') || data === 'k') { this.offset = Math.max(0, this.offset - 1); return true; }
    if (matchesKey(data, 'down') || data === 'j') { this.offset = Math.min(last, this.offset + 1); return true; }
    if (matchesKey(data, 'pageUp')) { this.offset = Math.max(0, this.offset - page); return true; }
    if (matchesKey(data, 'pageDown')) { this.offset = Math.min(last, this.offset + page); return true; }
    if (data === 'g') { this.offset = 0; return true; }
    if (data === 'G') { this.offset = last; return true; }
    return false;
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const lines = this.contentLines(this.cachedWidth > 0 ? this.cachedWidth : 80);
    this.handleScrollKeys(data, lines.length);
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width || !this.cachedLines) {
      this.cachedWidth = width;
      this.cachedLines = this.contentLines(width);
    }
    const lines = this.cachedLines;
    const rows = this.viewportRows();
    const last = Math.max(0, lines.length - rows);
    if (this.offset > last) this.offset = last;
    const win = lines.slice(this.offset, this.offset + rows);
    const hiddenAbove = this.offset;
    const hiddenBelow = Math.max(0, lines.length - this.offset - rows);
    const scroll = hiddenAbove || hiddenBelow
      ? style.dim(`  ${hiddenAbove ? `↑${hiddenAbove}` : ''}${hiddenAbove && hiddenBelow ? ' ' : ''}${hiddenBelow ? `↓${hiddenBelow}` : ''}`)
      : '';
    const body = [scroll, ...win].filter((l, i) => i > 0 || l !== '');
    return panelRows(this.opts.title, body, width, this.opts.hint);
  }
}

// ── Task Snapshot overlay ──────────────────────────────────────────

export class TaskSnapshotOverlay extends OverlayBase {
  constructor(
    private getTodos: () => TodoItem[],
    opts: { rows: () => number; onClose: () => void },
  ) {
    super({
      title: 'Tasks',
      hint: '↑/↓ scroll · g/G top/bottom · Esc/q close',
      rows: opts.rows,
      onClose: opts.onClose,
    });
  }

  private titleForTodos(): string {
    const todos = this.getTodos();
    if (!todos.length) return 'Tasks';
    const done = todos.filter((t) => t.status === 'completed').length;
    return `Tasks · ${done}/${todos.length}`;
  }

  protected contentLines(width: number): string[] {
    const todos = this.getTodos();
    this.opts.title = this.titleForTodos();
    if (!todos.length) return [style.dim('  No tasks yet. The agent creates them with todo_write.')];
    const w = Math.max(20, width - 10);
    return todos.map((t) => {
      const glyph = t.status === 'completed' ? style.green('✓')
        : t.status === 'in_progress' ? style.fg(C.yellow, '▸')
        : style.dim('○');
      const subject = truncateToWidth(t.subject, w, '…');
      const desc = t.description ? style.dim(' — ' + truncateToWidth(t.description, Math.max(10, w - subject.length - 4), '…')) : '';
      const active = t.status === 'in_progress' ? style.fg(C.yellow, ' ◂ active') : '';
      return `  ${glyph} ${subject}${desc}${active}`;
    });
  }
}
