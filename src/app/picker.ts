import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { approvalText } from '../util/approvalText.js';
import { GLYPHS } from '../tui/glyphs.js';
import { C } from '../tui/theme.js';
import { style } from './ansi.js';
import { panelRows } from './panel.js';

/** A choice is committed only by Enter, including multi-digit numbered choices. */
export class ChoicePicker<T> implements Component {
  private cursor: number;
  private typed = '';
  private query = '';
  private searching = false;
  constructor(private options: {
    title: string; items: T[]; label: (item: T) => string; selected?: number;
    choose: (item: T) => void; close: () => void; repaint: () => void; rows: () => number;
  }) { this.cursor = options.selected ?? 0; }
  invalidate(): void {}
  private filtered(): T[] {
    return this.query ? this.options.items.filter((item) => this.options.label(item).toLocaleLowerCase().includes(this.query.toLocaleLowerCase())) : this.options.items;
  }
  render(width: number): string[] {
    const { label } = this.options;
    const items = this.filtered();
    const max = Math.max(1, Math.min(12, this.options.rows() - 6));
    const start = Math.min(Math.max(0, this.cursor - max + 1), Math.max(0, items.length - max));
    const lines = items.slice(start, start + max).map((item, offset) => {
      const i = start + offset;
      const text = `${i + 1}. ${approvalText(label(item))}`;
      return i === this.cursor ? style.fg(C.accent, GLYPHS.promptPrefix + text) : style.dim('  ' + text);
    });
    if (start) lines.unshift(style.dim(`↑ ${start} more`));
    if (start + max < items.length) lines.push(style.dim(`↓ ${items.length - start - max} more`));
    if (!lines.length) lines.push(style.dim('No matching choices.'));
    return panelRows(this.options.title, lines, width, this.searching ? `Search: ${approvalText(this.query)} · Enter choose · Esc clear` : this.typed ? `Choice ${this.typed} · Enter confirm · Esc cancel` : '↑/↓ or number · / search · Enter confirm · Esc cancel');
  }
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const items = this.filtered();
    if (matchesKey(data, 'escape')) {
      if (this.searching || this.query) { this.searching = false; this.query = ''; this.cursor = 0; this.options.repaint(); }
      else this.options.close();
      return;
    }
    if (matchesKey(data, 'enter')) {
      const i = this.typed ? Number(this.typed) - 1 : this.cursor;
      if (items[i] !== undefined) this.options.choose(items[i]!);
      return;
    }
    if (this.searching && !matchesKey(data, 'up') && !matchesKey(data, 'down')) {
      if (matchesKey(data, 'backspace')) this.query = this.query.slice(0, -1);
      else if (!/[\x00-\x1f\x7f]/.test(data)) this.query = (this.query + data).slice(0, 150);
      this.cursor = 0; this.typed = '';
    } else if (data === '/') { this.searching = true; this.typed = ''; }
    else if (/^\d+$/.test(data)) {
      this.typed = (this.typed + data).slice(0, 6);
      const i = Number(this.typed) - 1;
      if (items[i] !== undefined) this.cursor = i;
    } else if (matchesKey(data, 'up') || data === 'k') {
      this.cursor = (this.cursor - 1 + items.length) % Math.max(1, items.length); this.typed = '';
    } else if (matchesKey(data, 'down') || data === 'j') {
      this.cursor = (this.cursor + 1) % Math.max(1, items.length); this.typed = '';
    } else if (matchesKey(data, 'backspace')) this.typed = this.typed.slice(0, -1);
    else return;
    this.options.repaint();
  }
}
