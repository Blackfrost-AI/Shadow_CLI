import { isKeyRelease, matchesKey, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { ContextInspection, ContextInspectionEntry } from '../context/inspection.js';
import { approvalText } from '../util/approvalText.js';
import { C } from '../tui/theme.js';
import { style } from './ansi.js';
import { panelRows } from './panel.js';

export type ContextInspectorAction = 'pin' | 'exclude' | 'remove';

/** Local, keyboard-driven inspection of request inputs. Opening the view makes no model calls. */
export class ContextInspector implements Component {
  private cursor = 0;
  private detail: false | 'entry' | 'compaction' = false;
  private offset = 0;
  private busy = false;
  private status = '';
  constructor(private options: {
    snapshot: () => ContextInspection;
    rows: () => number;
    repaint: () => void;
    close: () => void;
    action?: (entry: ContextInspectionEntry, action: ContextInspectorAction) => void | Promise<void>;
  }) {}

  invalidate(): void {}

  render(width: number): string[] {
    const snapshot = this.options.snapshot();
    this.cursor = Math.max(0, Math.min(this.cursor, snapshot.entries.length - 1));
    const height = Math.max(1, this.options.rows() - 10);
    const inner = Math.max(1, width - 6);
    const heading = [
      `${snapshot.provider} · ${snapshot.model}${snapshot.destination ? ` · ${snapshot.destination}` : ''}`,
      `${snapshot.basis === 'prepared-request' ? 'Last prepared request' : 'Provisional next-request draft'}: ~${snapshot.estimatedTokens.toLocaleString()} tokens (estimate) / ${snapshot.budget.toLocaleString()} budget`,
      `Last provider-reported request: ${snapshot.lastActualTokens ? snapshot.lastActualTokens.toLocaleString() + ' tokens' : 'not available'} · ${snapshot.messageCount} messages`,
      snapshot.preparedAt ? `Captured ${snapshot.preparedAt} · historical; controls apply to next request` : 'Actual per-turn system additions and tool filtering are captured when a request starts.',
    ].map((line) => style.fg(C.dim, approvalText(line)));
    let body: string[];
    if (this.detail) {
      const entry = snapshot.entries[this.cursor];
      const paragraphs = this.detail === 'compaction' ? ['Compaction preview for the current session', snapshot.compaction.description, '', ...snapshot.notices] : entry ? [entry.label, `Origin: ${entry.origin}`, entry.reason,
        `State: ${entry.state} · ~${entry.estimatedTokens.toLocaleString()} tokens (estimate)`, '',
        entry.preview.length > 32_000 ? entry.preview.slice(0, 32_000) + '\n[Inspector preview truncated; request content is unchanged.]' : entry.preview] : [];
      const content = paragraphs.join('\n').split('\n').flatMap((line) => wrapTextWithAnsi(approvalText(line), inner));
      this.offset = Math.max(0, Math.min(this.offset, Math.max(0, content.length - height)));
      body = content.slice(this.offset, this.offset + height);
    } else {
      const start = Math.max(0, this.cursor - height + 1);
      body = snapshot.entries.slice(start, start + height).map((entry, index) => {
        const line = `${index + start === this.cursor ? '›' : ' '} ${entry.state === 'pinned' ? '◆' : entry.state === 'excluded' ? '×' : '·'} ${entry.label} · ~${entry.estimatedTokens.toLocaleString()}${entry.mutable ? '' : ' · read-only'}`;
        return index + start === this.cursor ? style.fg(C.accent, approvalText(line)) : approvalText(line);
      });
    }
    const selected = snapshot.entries[this.cursor];
    const controls = this.detail !== 'compaction' && selected?.mutable && this.options.action ? ' · p pin · x exclude · r remove control' : '';
    return panelRows('Context inspector', [...heading, '', ...body,
      style.fg(C.dim, approvalText(this.status || (this.detail ? 'Previously transmitted content cannot be recalled.' : 'Pins survive compaction. Exclusions: attachments + repository_context only.')))], width,
    this.detail ? `↑/↓ scroll${controls} · Esc list` : `↑/↓ select · Enter inspect · c compaction${controls} · Esc close`);
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, 'escape')) {
      if (this.detail) { this.detail = false; this.offset = 0; this.status = ''; this.options.repaint(); }
      else this.options.close();
      return;
    }
    const snapshot = this.options.snapshot();
    if (this.busy) return;
    if (data === 'c' && !this.detail) { this.detail = 'compaction'; this.offset = 0; this.status = ''; this.options.repaint(); return; }
    const entry = snapshot.entries[this.cursor];
    if (this.detail !== 'compaction' && entry?.mutable && this.options.action && ['p', 'x', 'r'].includes(data)) {
      this.busy = true;
      this.status = 'Updating context…'; this.options.repaint();
      Promise.resolve().then(() => this.options.action!(entry, data === 'p' ? 'pin' : data === 'x' ? 'exclude' : 'remove'))
        .then(() => { this.status = 'Updated for the next request. Existing history is unchanged.'; })
        .catch((error: Error) => { this.status = error.message; })
        .finally(() => { this.busy = false; this.options.repaint(); });
      return;
    }
    if (matchesKey(data, 'enter') && !this.detail) { this.detail = 'entry'; this.offset = 0; this.status = ''; }
    else {
      const delta = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : matchesKey(data, 'pageUp') ? -10 : matchesKey(data, 'pageDown') ? 10 : 0;
      if (this.detail) this.offset = Math.max(0, this.offset + delta);
      else this.cursor = Math.max(0, Math.min(snapshot.entries.length - 1, this.cursor + delta));
    }
    this.options.repaint();
  }
}
