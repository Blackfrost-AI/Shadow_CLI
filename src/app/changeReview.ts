import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import type { ChangeSet, ChangedFile } from '../state/gitChanges.js';
import { approvalText } from '../util/approvalText.js';
import { panelRows } from './panel.js';
import { style } from './ansi.js';
import { C } from '../tui/theme.js';

/** A read-only file/hunk browser; the explicit review action supplies the selected scope. */
export class ChangeReview implements Component {
  private cursor = 0;
  private offset = 0;
  private detail: string[] | null = null;
  constructor(private options: {
    changes: ChangeSet; diff: (file: ChangedFile) => string; rows: () => number;
    repaint: () => void; close: () => void; review?: () => void;
  }) {}
  invalidate(): void {}
  render(width: number): string[] {
    const height = Math.max(1, this.options.rows() - 8);
    const { changes } = this.options;
    const start = Math.max(0, this.cursor - height + 1);
    const lines = this.detail ? this.detail.slice(this.offset, this.offset + height).map((line) => {
      const safe = approvalText(line);
      return style.fg(line.startsWith('+') ? C.green : line.startsWith('-') ? C.red : C.dim, safe);
    }) : changes.summary.slice(start, start + height).map((line, i) => i + start === this.cursor ? style.fg(C.accent, `› ${approvalText(line)}`) : `  ${approvalText(line)}`);
    return panelRows(changes.title, lines, width, this.detail
      ? '↑/↓ scroll · n/p hunk · Esc files'
      : `↑/↓ files · Enter diff${this.options.review ? ' · r review' : ''} · Esc close`);
  }
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, 'escape')) {
      if (this.detail) { this.detail = null; this.offset = 0; this.options.repaint(); }
      else this.options.close();
      return;
    }
    if (!this.detail && data === 'r' && this.options.review) { this.options.review(); return; }
    if (!this.detail && matchesKey(data, 'enter')) {
      const file = this.options.changes.files[this.cursor];
      if (file) {
        try { this.detail = this.options.diff(file).split('\n'); }
        catch (error) { this.detail = [(error as Error).message]; }
        this.offset = 0;
      }
    } else if (this.detail) {
      const delta = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : matchesKey(data, 'pageUp') ? -10 : matchesKey(data, 'pageDown') ? 10 : 0;
      this.offset = Math.max(0, Math.min(Math.max(0, this.detail.length - 1), this.offset + delta));
      if (data === 'n') { const next = this.detail.findIndex((line, i) => i > this.offset && line.startsWith('@@')); if (next >= 0) this.offset = next; }
      if (data === 'p') { for (let i = this.offset - 1; i >= 0; i--) if (this.detail[i]!.startsWith('@@')) { this.offset = i; break; } }
    } else if (matchesKey(data, 'up')) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, 'down')) this.cursor = Math.min(Math.max(0, this.options.changes.files.length - 1), this.cursor + 1);
    this.options.repaint();
  }
}
