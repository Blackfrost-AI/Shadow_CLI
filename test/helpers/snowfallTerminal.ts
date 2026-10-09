import xterm from '@xterm/headless';
import { Container, TuiAltScreen } from '@earendil-works/pi-tui';
import type { Terminal as PiTerminal } from '@earendil-works/pi-tui';
import { FlatCell, BrandSplash } from '../../src/app/cells.js';
import { SnowfallEditor, snowfallLayout, type SnowfallState } from '../../src/app/snowfall.js';
import { style } from '../../src/app/ansi.js';
import { applyTheme, C, type CanonicalThemeName } from '../../src/tui/theme.js';
import { SHADOW_LOGOTYPE } from '../../src/tui/brand.js';
import type { FlattenItem } from '../../src/tui/flatten.js';

/** The production terminal engine writes actual VT sequences into this real terminal emulator. */
export class HeadlessTerminal implements PiTerminal {
  readonly screen: InstanceType<typeof xterm.Terminal>;
  writes: string[] = [];
  input: (data: string) => void = () => {};
  private onResize: () => void = () => {};
  stopped = false;
  kittyProtocolActive = false;
  constructor(public columns = 120, public rows = 36) {
    this.screen = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 10000 });
  }
  start(input: (data: string) => void, resize: () => void): void { this.input = input; this.onResize = resize; this.stopped = false; }
  stop(): void { this.stopped = true; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); this.screen.write(data); }
  moveBy(lines: number): void { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? 'B' : 'A'}`); }
  hideCursor(): void { this.write('\x1b[?25l'); }
  showCursor(): void { this.write('\x1b[?25h'); }
  clearLine(): void { this.write('\x1b[2K'); }
  clearFromCursor(): void { this.write('\x1b[J'); }
  clearScreen(): void { this.write('\x1b[2J'); }
  setTitle(title: string): void { this.write(`\x1b]2;${title}\x07`); }
  setProgress(): void {}
  resize(columns: number, rows: number): void {
    this.columns = columns; this.rows = rows;
    this.screen.resize(columns, rows); this.onResize();
  }
  async flush(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    await new Promise<void>((resolve) => this.screen.write('', resolve));
  }
  lines(all = false): string[] {
    const buffer = this.screen.buffer.active;
    const from = all ? 0 : buffer.viewportY;
    const count = all ? buffer.length : this.rows;
    return Array.from({ length: count }, (_, i) => buffer.getLine(from + i)?.translateToString(true) ?? '');
  }
  /** Character and foreground/background attributes, independent of escape chunk boundaries. */
  cells(): Array<Array<[string, number, number, number, number, number]>> {
    const buffer = this.screen.buffer.active;
    return Array.from({ length: this.rows }, (_, row) => Array.from({ length: this.columns }, (_, col) => {
      const cell = buffer.getLine(buffer.viewportY + row)?.getCell(col);
      const flags = (cell?.isBold() ? 1 : 0) | (cell?.isItalic() ? 2 : 0) | (cell?.isInverse() ? 4 : 0) | (cell?.isUnderline() ? 8 : 0);
      return [cell?.getWidth() === 0 ? '' : cell?.getChars() || ' ', cell?.getFgColorMode() ?? 0, cell?.getFgColor() ?? 0, cell?.getBgColorMode() ?? 0, cell?.getBgColor() ?? 0, flags];
    }));
  }
}

export const snowfallFixtureState = (): SnowfallState => ({
  version: '10.0.0', workspace: '~/work/snowfall', providerModel: 'local / frost-coder',
  autonomy: 'auto-read', planMode: false, bypass: false, running: false, startedAt: 0,
  tick: 0, reducedMotion: true, queued: 0, toolLine: null, contextPct: 0.28, costUSD: 0.0123,
  goal: 'Make the terminal feel like Shadow.', missionLine: '', mcpConnecting: false, mcpFailed: false,
  todos: [
    { id: '1', subject: 'Build the crystalline layout', status: 'completed' },
    { id: '2', subject: 'Check narrow terminals', status: 'in_progress' },
    { id: '3', subject: 'Review the release candidate', status: 'pending' },
  ],
  agents: [{ taskId: 'review', subagentType: 'reviewer', description: 'Checking terminal behavior', tool: 'read_file', toolUseCount: 4, inputTokens: 100, outputTokens: 20, startedAt: 0, background: true }],
});

export const snowfallFixtureItems = (): FlattenItem[] => [
  { id: 1, kind: 'user', text: 'Finish the Snowfall build, then show me the result.' },
  { id: 'thinking', kind: 'reasoning', text: 'I’ll check the layout at each terminal size, then verify that the composer and status bar stay available.\nThe answer should remain separate from the thinking preview.', reasoningState: 'complete', durationMs: 65000 },
  { id: 2, kind: 'assistant', text: 'The new layout gives your conversation the full width, with task and context totals in the footer.\n\n### Ready for review\n- Responsive layout at 80, 120 and 200 columns\n- Unicode stays readable: café, 漢字, ❄\n- Search and prompt navigation preserve your place.' },
  { id: 3, kind: 'tool', text: '', tool: { name: 'run_shell', arg: 'npm test', ok: true, durationMs: 1234, summary: 'Terminal checks passed' }, lines: [{ text: 'PASS  scrolling, search, paste and restoration' }], meta: 'output' },
  { id: 4, kind: 'assistant', text: '| Surface | Result |\n| --- | --- |\n| Transcript | Full width |\n| Composer | Always available |\n| Footer | Session totals |\n\n```ts\nconst renderer = "snowfall";\n```\n\nUse **Ctrl+Shift+F** to find a line, or **End** to return to the latest output.' },
];

export function fixture(theme: CanonicalThemeName, width: number, height = 36, splash = false) {
  applyTheme(theme);
  const terminal = new HeadlessTerminal(width, height);
  const tui = new TuiAltScreen(terminal);
  const document = new Container();
  const state = snowfallFixtureState();
  if (splash) document.addChild(new BrandSplash({ version: state.version, workspace: state.workspace, providerModel: state.providerModel, help: '/help · /model · @ files' }, SHADOW_LOGOTYPE));
  else for (const item of snowfallFixtureItems()) document.addChild(new FlatCell(item, item.kind === 'reasoning'));
  const editor = new SnowfallEditor(tui, {
    borderColor: (text) => style.fg(C.border ?? C.dim, text),
    selectList: { selectedPrefix: style.cyan, selectedText: style.cyan, description: style.dim, scrollInfo: style.dim, noMatch: style.dim },
  }, () => state, () => terminal.rows);
  const layout = snowfallLayout(document, editor, () => state);
  tui.setLayoutRoot(layout.root);
  tui.setFocus(editor);
  tui.start();
  return { terminal, tui, document, editor, state, ...layout };
}
