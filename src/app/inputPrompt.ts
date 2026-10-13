import { Editor, isKeyRelease, matchesKey, type Component, type EditorTheme, type TUI } from '@earendil-works/pi-tui';
import { panelRows } from './panel.js';
import { approvalText } from '../util/approvalText.js';

/** Focused local input; caller validates before executing any action. */
export class InputPrompt implements Component {
  private editor: Editor;
  constructor(private options: { title: string; description?: string; initial?: string; tui: TUI; theme: EditorTheme;
    submit: (text: string) => void; close: () => void; repaint: () => void }) {
    this.editor = new Editor(options.tui, options.theme, { paddingX: 0 });
    this.editor.setText(options.initial ?? '');
    this.editor.onChange = options.repaint;
    this.editor.onSubmit = (text) => { this.editor.setText(text); options.submit(text); };
  }
  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  invalidate(): void { this.editor.invalidate(); }
  render(width: number): string[] { return panelRows(this.options.title, [
    ...(this.options.description ? [approvalText(this.options.description)] : []), ...this.editor.render(Math.max(1, width - 4)),
  ], width, 'Enter continue · Shift+Enter newline · Esc back'); }
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, 'escape')) { this.options.close(); return; }
    this.editor.handleInput(data); this.options.repaint();
  }
}
