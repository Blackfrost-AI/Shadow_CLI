import { stdin, stdout } from 'node:process';
import { createInterface, type Interface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import {
  Input,
  ProcessTerminal,
  TuiAltScreen,
  matchesKey,
  isKeyRelease,
  visibleWidth,
  truncateToWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { Component, Terminal } from '@earendil-works/pi-tui';
import { panelRows } from '../app/panel.js';
import { style } from '../app/ansi.js';
import { SHADOW_LOGOTYPE, SHADOW_COMPACT, degradeArt } from '../tui/brand.js';
import { C, applyTheme, backgroundSequence, themeBackground } from '../tui/theme.js';
import { redactString } from '../util/redact.js';

export const BACK = Symbol('back');
export class OnboardCancelled extends Error {}
export interface Screen {
  stage: number;
  title: string;
  description?: string;
  details?: string[];
  error?: string;
}
export interface Choice {
  id: string;
  label: string;
  detail?: string;
}
export interface ChoiceOptions {
  initial?: string;
  search?: boolean;
  selected?: string[];
  multiple?: boolean;
}
export interface TextOptions {
  initial?: string;
  placeholder?: string;
  secret?: boolean;
  validate?: (value: string) => string | undefined;
}
export interface OnboardUI {
  choose(
    screen: Screen,
    choices: Choice[],
    options?: ChoiceOptions,
  ): Promise<string[] | typeof BACK>;
  text(screen: Screen, options?: TextOptions): Promise<string | typeof BACK>;
  busy<T>(screen: Screen, work: (signal: AbortSignal) => Promise<T>): Promise<T | typeof BACK>;
  /** Give an official account-login CLI the terminal, then restore this wizard. */
  external?<T>(work: (signal?: AbortSignal) => Promise<T>): Promise<T>;
  updateBusy?(screen: Partial<Screen>): void;
  close(): void;
}

const safe = (value: string) =>
  stripVTControlCharacters(redactString(value)).replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    ' ',
  );
const stages = ['Connect', 'Endpoint', 'Models', 'Verify', 'Save'];

/** A single mounted input owner for the entire wizard; secret fields never replace stdin. */
export class OnboardScreen implements Component {
  screen: Screen = { stage: 0, title: 'Connect a model' };
  kind: 'choice' | 'text' | 'busy' = 'choice';
  choices: Choice[] = [];
  options: ChoiceOptions = {};
  textOptions: TextOptions = {};
  input = new Input({ prompt: '› ' });
  selected = new Set<string>();
  cursor = 0;
  typed = '';
  query = '';
  searching = false;
  startedAt = 0;
  accept: (value: string | string[] | typeof BACK) => void = () => {};
  cancel: () => void = () => {};
  constructor(
    private repaint: () => void,
    private rows: () => number,
  ) {}
  invalidate(): void {}

  configure(screen: Screen): void {
    this.screen = { ...screen };
    this.cursor = 0;
    this.typed = this.query = '';
    this.searching = false;
    this.input = new Input({ prompt: '› ', placeholderStyle: style.dim });
    this.input.focused = true;
  }

  private filtered(): Choice[] {
    const query = this.query.toLowerCase();
    return this.choices.filter(
      (item) =>
        item.id === '@manual' || `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(query),
    );
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d')) {
      this.cancel();
      return;
    }
    if (matchesKey(data, 'escape')) {
      if (this.searching || this.query) {
        this.searching = false;
        this.query = '';
        this.cursor = 0;
        this.input.setValue('');
        this.repaint();
        return;
      }
      this.accept(BACK);
      return;
    }
    if (this.kind === 'busy') return;
    if (this.kind === 'text') {
      if (matchesKey(data, 'enter')) {
        const value = this.input.getValue().trim();
        const error = this.textOptions.validate?.(value);
        if (error) {
          this.screen.error = error;
          this.repaint();
        } else this.accept(value);
      } else {
        this.input.handleInput(data);
        this.repaint();
      }
      return;
    }
    const items = this.filtered();
    const move = (offset: number) => {
      this.cursor = (this.cursor + offset + items.length) % Math.max(1, items.length);
      this.typed = '';
      this.searching = false;
    };
    if (matchesKey(data, 'up')) move(-1);
    else if (matchesKey(data, 'down')) move(1);
    else if (matchesKey(data, 'pageUp')) move(-Math.min(6, items.length));
    else if (matchesKey(data, 'pageDown')) move(Math.min(6, items.length));
    else if (matchesKey(data, 'enter')) {
      const index = this.typed ? Number(this.typed) - 1 : this.cursor;
      const item = items[index];
      if (!item) {
        this.screen.error = 'Choose a listed number or use the arrow keys.';
        this.repaint();
        return;
      }
      // Manual model entry is a navigation action, never part of the selected model set.
      if (item.id === '@manual') this.accept(['@manual', this.query.trim()]);
      else if (this.options.multiple && this.selected.size) this.accept([...this.selected]);
      else this.accept([item.id]);
      return;
    } else if (data === ' ' && this.options.multiple && !this.searching) {
      const item = items[this.cursor];
      if (item && item.id !== '@manual') {
        if (this.selected.has(item.id)) this.selected.delete(item.id);
        else this.selected.add(item.id);
      }
    } else if (!this.searching && /^\d+$/.test(data)) {
      this.typed = (this.typed + data).slice(0, 6);
      const index = Number(this.typed) - 1;
      if (items[index]) this.cursor = index;
    } else if (!this.searching && matchesKey(data, 'backspace') && this.typed) {
      this.typed = this.typed.slice(0, -1);
    } else if (this.options.search) {
      if (!this.searching && data === '/') {
        this.searching = true;
        this.typed = '';
        this.input.setValue(this.query);
        this.input.handleInput('\x05');
      } else {
        this.searching = true;
        this.typed = '';
        this.input.handleInput(data);
        this.query = this.input.getValue();
        this.cursor = 0;
      }
    }
    this.repaint();
  }

  render(width: number): string[] {
    const height = Math.max(5, this.rows());
    const w = Math.max(2, Math.min(88, width - (width >= 48 ? 4 : 0)));
    const inner = Math.max(1, w - 4);
    const margin = ' '.repeat(Math.max(0, Math.floor((width - w) / 2)));
    const compact = height < 28;
    const art = compact ? [SHADOW_COMPACT] : degradeArt(SHADOW_LOGOTYPE, w);
    const banner = (art.length ? art : [SHADOW_COMPACT]).map(
      (line) =>
        ' '.repeat(Math.max(0, Math.floor((w - visibleWidth(line)) / 2))) +
        style.fg(C.accent, line),
    );
    const stepper = stages
      .map((stage, index) =>
        index === this.screen.stage
          ? style.fg(C.accent, `${index + 1} ${stage}`)
          : style.dim(stage),
      )
      .join(style.dim('  ›  '));
    const body: string[] = [];
    if (this.screen.description)
      body.push(style.dim(truncateToWidth(safe(this.screen.description), inner, '…')));
    for (const line of (this.screen.details ?? []).slice(0, height < 20 ? 1 : 4))
      body.push(style.dim(safe(line)));
    if (this.screen.error)
      body.push(
        ...wrapTextWithAnsi(safe(this.screen.error), inner)
          .slice(0, height < 20 ? 1 : 3)
          .map(style.yellow),
      );
    if (height >= 20) body.push('');
    let hint = 'Enter continue · Esc back · Ctrl+C quit';
    if (this.kind === 'text') {
      if (this.textOptions.secret) {
        // Never call Input.render() for a secret (including cursor/backspace redraws).
        body.push(
          '› ' +
            (this.input.getValue()
              ? '•'.repeat(Math.min(32, [...this.input.getValue()].length))
              : style.dim(this.textOptions.placeholder ?? 'Paste your API key')),
        );
      } else body.push(...this.input.render(inner));
    } else if (this.kind === 'busy') {
      const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
      body.push(style.cyan(`Checking${'.'.repeat((seconds % 3) + 1)}  ${seconds}s`));
      hint = 'Esc cancel check / go back · Ctrl+C quit';
    } else {
      if (this.query || this.searching)
        body.push(style.dim(`Search: ${safe(this.query) || 'type to filter'}`));
      const items = this.filtered();
      const max = Math.max(1, Math.min(8, height - banner.length - body.length - 9));
      this.cursor = Math.max(0, Math.min(this.cursor, items.length - 1));
      const start = Math.min(Math.max(0, this.cursor - max + 1), Math.max(0, items.length - max));
      for (let index = start; index < Math.min(items.length, start + max); index++) {
        const item = items[index]!;
        const mark =
          this.options.multiple && item.id !== '@manual'
            ? this.selected.has(item.id)
              ? '[✓] '
              : '[ ] '
            : '';
        const label = `${index === this.cursor ? '›' : ' '} ${index + 1}. ${mark}${safe(item.label)}`;
        body.push(index === this.cursor ? style.fg(C.accent, label) : style.dim(label));
      }
      if (!items.length) body.push(style.yellow('No matches. Esc clears the search.'));
      const current = items[this.cursor];
      if (current?.detail && height >= 24) body.push('', style.dim(safe(current.detail)));
      const count = items.length > max ? `${this.cursor + 1}/${items.length} · ` : '';
      hint = this.typed
        ? `Choice ${this.typed} · Enter confirm · Backspace edit`
        : `${count}↑/↓ or number · Enter ${this.options.multiple ? 'continue · Space select' : 'select'}${this.options.search ? ' · / search' : ''}`;
    }
    const top = [...banner, '', truncateToWidth(stepper, w, '…'), ''];
    const frame = panelRows(
      `${this.screen.stage + 1}/5  ${safe(this.screen.title)}`,
      body,
      w,
      hint,
    );
    const footer =
      this.kind === 'choice'
        ? style.dim(
            `${this.selected.size ? `${this.selected.size} selected · ` : ''}Esc back · Ctrl+C quit`,
          )
        : '';
    const lines = [...top, ...frame, footer];
    // At tiny heights keep the active field/menu and its footer visible.
    return lines
      .slice(Math.max(0, lines.length - height))
      .map((line) => margin + truncateToWidth(line, w, '…'));
  }
}

export class TerminalOnboardUI implements OnboardUI {
  readonly view: OnboardScreen;
  private tui: TuiAltScreen;
  private rejectPending?: (error: Error) => void;
  private closed = false;
  private signals = new Map<NodeJS.Signals, () => void>();
  private onEnd = () => this.rejectPending?.(new OnboardCancelled('Input closed'));
  constructor(
    private terminal: Terminal = new ProcessTerminal(),
    theme?: string,
  ) {
    applyTheme(theme ?? 'snowfall');
    this.tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
    this.view = new OnboardScreen(
      () => this.tui.requestRender(),
      () => terminal.rows,
    );
    this.view.cancel = () => this.rejectPending?.(new OnboardCancelled());
    this.tui.setLayoutRoot(this.view);
    this.tui.setFocus(this.view);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const handler = () => {
        this.close();
        process.kill(process.pid, signal);
      };
      this.signals.set(signal, handler);
      process.on(signal, handler);
    }
    stdin.on('end', this.onEnd);
    process.on('exit', this.restore);
    process.on('uncaughtExceptionMonitor', this.restore);
    terminal.write('\x1b[22;2t' + backgroundSequence(themeBackground(theme), true));
    terminal.setTitle('Setup — Shadow');
    this.tui.start();
  }
  private restore = () => {
    if (this.closed) return;
    this.closed = true;
    this.tui.stop();
    this.terminal.write(backgroundSequence(null, true) + '\x1b[0m\x1b[23;2t\x1b[?2004l\x1b[?25h');
  };
  private wait<T extends string | string[]>(
    screen: Screen,
    configure: () => void,
  ): Promise<T | typeof BACK> {
    if (this.closed) return Promise.reject(new OnboardCancelled());
    this.view.configure(screen);
    configure();
    return new Promise<T | typeof BACK>((resolve, reject) => {
      const clear = () => {
        this.view.accept = () => {};
        this.rejectPending = undefined;
      };
      this.view.accept = (value) => {
        clear();
        resolve(value as T | typeof BACK);
      };
      this.rejectPending = (error) => {
        clear();
        reject(error);
      };
      this.tui.requestRender();
    });
  }
  choose(
    screen: Screen,
    choices: Choice[],
    options: ChoiceOptions = {},
  ): Promise<string[] | typeof BACK> {
    return this.wait<string[]>(screen, () => {
      this.view.kind = 'choice';
      this.view.choices = choices;
      this.view.options = options;
      this.view.selected = new Set(options.selected ?? []);
      this.view.cursor = Math.max(
        0,
        choices.findIndex((item) => item.id === options.initial),
      );
    });
  }
  text(screen: Screen, options: TextOptions = {}): Promise<string | typeof BACK> {
    return this.wait<string>(screen, () => {
      this.view.kind = 'text';
      this.view.textOptions = options;
      this.view.input = new Input({
        prompt: '› ',
        placeholder: options.placeholder,
        placeholderStyle: style.dim,
      });
      this.view.input.focused = true;
      this.view.input.setValue(options.initial ?? '');
      this.view.input.handleInput('\x05'); // End of the restored draft, ready to edit.
    });
  }
  async busy<T>(
    screen: Screen,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | typeof BACK> {
    const controller = new AbortController();
    const cancelled = this.wait<string>(screen, () => {
      this.view.kind = 'busy';
      this.view.startedAt = Date.now();
    });
    const timer = setInterval(() => this.tui.requestRender(), 200);
    try {
      return await Promise.race([work(controller.signal), cancelled as Promise<typeof BACK>]);
    } finally {
      clearInterval(timer);
      controller.abort();
      this.view.accept = () => {};
      this.rejectPending = undefined;
    }
  }
  close(): void {
    this.rejectPending?.(new OnboardCancelled());
    this.view.input.setValue('');
    this.restore();
    for (const [signal, handler] of this.signals) process.removeListener(signal, handler);
    stdin.removeListener('end', this.onEnd);
    process.removeListener('exit', this.restore);
    process.removeListener('uncaughtExceptionMonitor', this.restore);
  }
  updateBusy(screen: Partial<Screen>): void {
    if (this.closed || this.view.kind !== 'busy') return;
    this.view.screen = { ...this.view.screen, ...screen };
    this.tui.requestRender();
  }
  async external<T>(work: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new OnboardCancelled();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    // The normal handlers re-raise immediately. While a child owns the terminal,
    // first let its abort handler finish terminating it and restoring its state.
    for (const [signal, handler] of this.signals) {
      process.removeListener(signal, handler);
      process.on(signal, cancel);
    }
    try {
      this.tui.stop({ preserveScreen: true });
      const result = await work(controller.signal);
      if (controller.signal.aborted) throw new OnboardCancelled();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new OnboardCancelled();
      throw error;
    } finally {
      for (const [signal, handler] of this.signals) {
        process.removeListener(signal, cancel);
        if (!this.closed) process.on(signal, handler);
      }
      if (!this.closed) {
        this.tui.start();
        this.tui.setFocus(this.view);
        this.tui.renderNow(true);
      }
    }
  }
}

/** Pipe/accessible fallback: one readline, queued lines, explicit EOF, no secret echo. */
export class PlainOnboardUI implements OnboardUI {
  private rl: Interface;
  private lines: string[] = [];
  private ended = false;
  private pending?: (line?: string) => void;
  constructor() {
    this.rl = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (this.pending) {
        const next = this.pending;
        this.pending = undefined;
        next(line);
      } else this.lines.push(line);
    });
    this.rl.on('close', () => {
      this.ended = true;
      this.pending?.();
      this.pending = undefined;
    });
  }
  private async line(): Promise<string | typeof BACK> {
    const line = this.lines.length
      ? this.lines.shift()
      : this.ended
        ? undefined
        : await new Promise<string | undefined>((resolve) => {
            this.pending = resolve;
          });
    if (line === undefined || /^(quit|exit|q)$/i.test(line.trim())) throw new OnboardCancelled();
    if (/^(back|b)$/i.test(line.trim())) return BACK;
    return line.trim();
  }
  private show(screen: Screen) {
    stdout.write(`\nSHADOW · ${screen.stage + 1}/5 · ${safe(screen.title)}\n`);
    for (const line of [screen.description, ...(screen.details ?? []), screen.error])
      if (line) stdout.write(safe(line) + '\n');
  }
  updateBusy(screen: Partial<Screen>): void {
    for (const line of [screen.description, ...(screen.details ?? []), screen.error])
      if (line) stdout.write(safe(line) + '\n');
  }
  async choose(
    screen: Screen,
    choices: Choice[],
    options: ChoiceOptions = {},
  ): Promise<string[] | typeof BACK> {
    this.show(screen);
    choices.forEach((item, index) => stdout.write(`${index + 1}. ${safe(item.label)}\n`));
    while (true) {
      stdout.write(
        `Choose${options.multiple ? ' (comma-separated numbers)' : ''} [${Math.max(1, choices.findIndex((item) => item.id === options.initial) + 1)}], back, or quit: `,
      );
      const answer = await this.line();
      if (answer === BACK) return BACK;
      const indexes = (
        answer || String(Math.max(1, choices.findIndex((item) => item.id === options.initial) + 1))
      ).split(',');
      const selected = indexes.map((value) =>
        /^\d+$/.test(value.trim())
          ? choices[Number(value) - 1]?.id
          : choices.find((item) => item.id === value.trim())?.id,
      );
      if (
        selected.every((item) => item !== undefined) &&
        (options.multiple || selected.length === 1)
      )
        return [...new Set(selected as string[])];
      stdout.write('Choose a listed number.\n');
    }
  }
  async text(screen: Screen, options: TextOptions = {}): Promise<string | typeof BACK> {
    this.show(screen);
    while (true) {
      stdout.write(`› ${options.initial && !options.secret ? `[${safe(options.initial)}] ` : ''}`);
      const answer = await this.line();
      if (answer === BACK) return BACK;
      const value = answer || options.initial || '';
      const error = options.validate?.(value);
      if (!error) return value;
      stdout.write(safe(error) + '\n');
    }
  }
  async busy<T>(
    screen: Screen,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | typeof BACK> {
    this.show(screen);
    return work(new AbortController().signal);
  }
  close(): void {
    this.rl.close();
  }
}
