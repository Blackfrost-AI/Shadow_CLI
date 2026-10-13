import { CURSOR_MARKER, Editor, isKeyRelease, matchesKey, wrapTextWithAnsi,
  type Component, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import { isCodexPane, type TmuxConnection, type TmuxPane } from '../tmux/client.js';
import { approvalText } from '../util/approvalText.js';
import { C } from '../tui/theme.js';
import { style } from './ansi.js';
import { panelRows } from './panel.js';

/** An explicit user-operated view of the existing process, separate from Shadow model context. */
export class TmuxView implements Component {
  private editor: Editor;
  private text = '';
  private wrapped: string[] = [];
  private wrapKey = '';
  private offset = 0;
  private height = 1;
  private following = true;
  private direct = false;
  private searching = false;
  private query = '';
  private status = 'Connecting…';
  private available = false;
  private sending = false;
  private disposed = false;
  private refreshing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private editorRows: number[] = [];
  private editorTop = 0;

  constructor(private options: {
    client: TmuxConnection; pane: TmuxPane; tui: TUI; theme: EditorTheme;
    rows: () => number; close: () => void; repaint: () => void; draft?: string;
  }) {
    this.editor = new Editor(options.tui, options.theme, { paddingX: 0 });
    this.editor.setText(options.draft ?? '');
    this.editor.onSubmit = (text) => { void this.send(text); };
    this.editor.onChange = () => options.repaint();
    void this.refresh();
  }

  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  getDraft(): string { return this.editor.getExpandedText(); }
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); }
  invalidate(): void { this.wrapKey = ''; this.editor.invalidate(); }

  private async refresh(): Promise<void> {
    if (this.disposed || this.refreshing) return;
    this.refreshing = true;
    try {
      const text = await this.options.client.capture(this.options.pane);
      if (this.disposed) return;
      this.text = text.trimEnd(); this.available = true; this.failures = 0;
      if (this.status === 'Connecting…' || this.status.startsWith('Disconnected:')) this.status = 'Connected';
    } catch (error) {
      if (this.disposed) return;
      this.available = false; this.failures++;
      this.status = `Disconnected: ${(error as Error).message}`;
    } finally {
      this.refreshing = false;
      if (!this.disposed) {
        this.options.repaint();
        this.timer = setTimeout(() => { void this.refresh(); }, this.failures ? Math.min(5000, this.failures * 1000) : 750);
      }
    }
  }

  private async send(text: string): Promise<void> {
    // Editor clears on submit before invoking us. Retain the draft until delivery succeeds.
    this.editor.setText(text);
    if (this.sending || !text.trim()) return;
    if (!this.available || !isCodexPane(this.options.pane)) {
      this.status = 'Read-only: connect to a running Codex pane to send messages.'; this.options.repaint(); return;
    }
    this.sending = true; this.editor.disableSubmit = true; this.status = 'Sending to Codex…';
    this.options.repaint();
    try {
      await this.options.client.send(this.options.pane, text);
      this.editor.addToHistory(text); this.editor.setText(''); this.following = true;
      this.status = 'Submitted to Codex';
    } catch (error) { this.status = `Send failed: ${(error as Error).message}`; }
    finally { this.sending = false; this.editor.disableSubmit = false; if (!this.disposed) this.options.repaint(); }
  }

  private remoteKeys(data: string): void {
    if (!this.available || this.sending) return;
    void this.options.client.keys(this.options.pane, data).catch((error: Error) => {
      this.status = `Input failed: ${error.message}`; if (!this.disposed) this.options.repaint();
    });
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const key = `${inner}\0${this.text}`;
    if (key !== this.wrapKey) {
      this.wrapKey = key;
      this.wrapped = this.text.split('\n').flatMap((line) => wrapTextWithAnsi(approvalText(line), inner));
    }
    const editor = this.direct ? [style.fg(C.yellow, 'DIRECT KEYS → Codex · F2 returns to the message composer')]
      : this.editor.render(inner);
    const editorBudget = Math.max(1, Math.min(6, this.options.rows() - 9));
    const cursor = Math.max(0, editor.findIndex((line) => line.includes(CURSOR_MARKER)));
    const start = Math.max(0, Math.min(editor.length - editorBudget, cursor - Math.floor(editorBudget / 2)));
    this.editorRows = editor.map((_, i) => i).slice(start, start + editorBudget);
    const draft = this.editorRows.map((i) => editor[i]!);
    this.height = Math.max(1, this.options.rows() - draft.length - 6);
    const max = Math.max(0, this.wrapped.length - this.height);
    this.offset = this.following ? max : Math.min(this.offset, max);
    const body = this.wrapped.slice(this.offset, this.offset + this.height);
    while (body.length < this.height) body.push('');
    const mode = isCodexPane(this.options.pane) ? 'Codex' : `Read-only · ${this.options.pane.command}`;
    const status = this.searching ? `Find: ${this.query} · Enter next · Esc close search`
      : `${this.status} · ${this.following ? 'Live' : 'History'} · ${this.offset + 1}/${this.wrapped.length}`;
    this.editorTop = body.length + 3;
    return panelRows(`SHADOW · ${this.options.pane.session} · ${mode} · ${this.options.pane.id}`,
      [...body, style.dim(approvalText(status)), style.dim('─'.repeat(inner)), ...draft], width,
      this.direct ? 'F2 composer · Ctrl+] detach · keys go to Codex'
        : 'Enter send · F2 Codex keys · Ctrl+F find · PgUp/PgDn scroll · Esc detach');
  }

  private scroll(delta: number): void {
    this.offset = Math.max(0, Math.min(Math.max(0, this.wrapped.length - this.height), this.offset + delta));
    this.following = this.offset >= this.wrapped.length - this.height;
    this.options.repaint();
  }

  private findNext(): void {
    if (!this.query) return;
    for (let step = 1; step <= this.wrapped.length; step++) {
      const i = (this.offset + step) % this.wrapped.length;
      if (this.wrapped[i]!.toLocaleLowerCase().includes(this.query.toLocaleLowerCase())) {
        this.offset = i; this.following = false; this.status = `Found: ${this.query}`; return;
      }
    }
    this.status = `No match: ${this.query}`;
  }

  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data)) return;
    if (data === '\x1d' || matchesKey(data, 'ctrl+]')) { this.options.close(); return; }
    if (matchesKey(data, 'f2')) {
      if (isCodexPane(this.options.pane) && !this.sending) this.direct = !this.direct;
      this.options.repaint(); return;
    }
    if (this.direct) { this.remoteKeys(data); return; }
    if (this.searching) {
      if (matchesKey(data, 'escape')) this.searching = false;
      else if (matchesKey(data, 'enter')) { this.findNext(); this.searching = false; }
      else if (matchesKey(data, 'backspace')) this.query = [...this.query].slice(0, -1).join('');
      else if (!/[\x00-\x1f\x7f]/.test(data)) this.query = (this.query + data).slice(0, 200);
      this.options.repaint(); return;
    }
    if (matchesKey(data, 'escape')) { this.options.close(); return; }
    if (matchesKey(data, 'ctrl+f')) { this.searching = true; this.query = ''; this.options.repaint(); return; }
    if (matchesKey(data, 'f3')) { this.findNext(); this.options.repaint(); return; }
    if (matchesKey(data, 'pageUp')) { this.scroll(-this.height); return; }
    if (matchesKey(data, 'pageDown')) { this.scroll(this.height); return; }
    if (matchesKey(data, 'ctrl+home')) { this.offset = 0; this.following = false; this.options.repaint(); return; }
    if (matchesKey(data, 'ctrl+end')) { this.following = true; this.options.repaint(); return; }
    if (matchesKey(data, 'ctrl+c')) { this.editor.setText(''); this.options.repaint(); return; }
    if (!this.sending) this.editor.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel') { this.scroll(event.wheelDelta ?? 0); return { handled: true, render: true }; }
    if (!this.direct && event.y >= this.editorTop) {
      return this.editor.handleMouse({ ...event, x: event.x - 2, y: this.editorRows[event.y - this.editorTop] ?? 0 });
    }
    return { handled: true };
  }
}
