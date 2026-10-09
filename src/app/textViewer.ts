import { isKeyRelease, matchesKey, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { approvalText } from '../util/approvalText.js';
import { redactString } from '../util/redact.js';
import { panelRows } from './panel.js';

/** Bounded, inert display of persisted evidence; never interpret terminal control sequences. */
export class TextViewer implements Component {
  private offset = 0;
  private wrapped: string[] = [];
  constructor(private options: { title: string; text: string; rows: () => number; close: () => void; repaint: () => void }) {}
  invalidate(): void {}
  render(width: number): string[] {
    const raw = this.options.text.length > 160_000 ? this.options.text.slice(0, 160_000) + '\n[Preview truncated; full evidence remains in the project job store.]' : this.options.text;
    this.wrapped = raw.split('\n').flatMap((line) => wrapTextWithAnsi(approvalText(redactString(line)), Math.max(1, width - 4)));
    const height = Math.max(1, this.options.rows() - 8);
    this.offset = Math.min(this.offset, Math.max(0, this.wrapped.length - height));
    return panelRows(this.options.title, this.wrapped.slice(this.offset, this.offset + height), width,
      `↑/↓ scroll · PgUp/PgDn · ${this.offset + 1}/${this.wrapped.length} · Esc back`);
  }
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, 'escape')) { this.options.close(); return; }
    const height = Math.max(1, this.options.rows() - 8);
    const delta = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : matchesKey(data, 'pageUp') ? -height : matchesKey(data, 'pageDown') ? height : 0;
    this.offset = Math.max(0, Math.min(Math.max(0, this.wrapped.length - height), this.offset + delta));
    this.options.repaint();
  }
}
