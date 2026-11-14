/**
 * Drill-in command menu overlay (11.7.0, OMP parity). Renders the menuTree data as a
 * navigable list: ↑/↓ move, Enter drills into a submenu or dispatches a command, Esc/←
 * goes back one level (Esc at the root closes). The breadcrumb header shows the path.
 *
 * Reuses the same overlay/focus machinery as ChoicePicker. Command leaves are handed back
 * to the host (app.ts) which dispatches them through runSlash — so menu actions and typed
 * slash commands share one handler.
 */
import type { Component, TuiAltScreen } from '@earendil-works/pi-tui';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { C } from '../tui/theme.js';
import { style } from './ansi.js';
import { buildMenuTree, menuBreadcrumb, type MenuNode } from './menuTree.js';

const MAX_VISIBLE = 12;

export class MenuOverlay implements Component {
  private root: MenuNode[] = buildMenuTree();
  /** Stack of submenu ids from the root; empty = root menu. */
  private path: string[] = [];
  private selected = 0;
  private scroll = 0;
  private handle?: { hide(): void };

  constructor(
    private tui: TuiAltScreen,
    /** Dispatch a command leaf (e.g. '/model') through the host's runSlash. */
    private onCommand: (command: string) => void,
    private onClose?: () => void,
  ) {}

  show(): void {
    this.handle = this.tui.showOverlay(this, {
      width: '70%',
      maxHeight: '70%',
      anchor: 'center',
      margin: 2,
    }) as unknown as { hide(): void };
    this.tui.requestRender();
  }

  private close(): void {
    this.handle?.hide();
    this.onClose?.();
    this.tui.requestRender();
  }

  /** Current level's nodes, resolved from the path. */
  private level(): MenuNode[] {
    let nodes = this.root;
    for (const id of this.path) {
      const next = nodes.find((n) => n.kind === 'submenu' && n.id === id);
      if (!next || next.kind !== 'submenu') return this.root;
      nodes = next.children;
    }
    return nodes;
  }

  private goBack(): boolean {
    if (this.path.length === 0) return false;
    this.path.pop();
    this.selected = 0;
    this.scroll = 0;
    return true;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const nodes = this.level();
    if (matchesKey(data, 'escape')) {
      if (!this.goBack()) this.close();
      else this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'left') || matchesKey(data, 'backspace')) {
      if (this.goBack()) this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.selected = Math.max(0, this.selected - 1);
      this.clampScroll(nodes.length);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.selected = Math.min(nodes.length - 1, this.selected + 1);
      this.clampScroll(nodes.length);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
      const node = nodes[this.selected];
      if (!node) return;
      if (node.kind === 'submenu') {
        this.path.push(node.id);
        this.selected = 0;
        this.scroll = 0;
        this.tui.requestRender();
      } else {
        // Dispatch through the host; close the menu first so the command's own overlay
        // (e.g. the model picker) takes focus cleanly.
        this.close();
        this.onCommand(node.command);
      }
      return;
    }
  }

  private clampScroll(count: number): void {
    if (this.selected < this.scroll) this.scroll = this.selected;
    else if (this.selected >= this.scroll + MAX_VISIBLE) this.scroll = this.selected - MAX_VISIBLE + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, count - MAX_VISIBLE)));
  }

  render(width: number): string[] {
    const w = Math.max(24, width);
    const inner = w - 4;
    const nodes = this.level();
    const crumbs = menuBreadcrumb(this.root, this.path).join(' › ');
    const lines: string[] = [];
    const border = (s: string) => style.fg(C.border ?? C.dim, s);
    const pad = (s: string) => {
      const vis = visibleWidth(s);
      return s + ' '.repeat(Math.max(0, inner - vis));
    };
    lines.push(border(`╭─ ${truncateToWidth(crumbs, inner - 2)} ` + '─'.repeat(Math.max(0, inner - visibleWidth(crumbs) - 3)) + '╮'));
    if (nodes.length === 0) {
      lines.push(border('│') + pad(style.fg(C.dim, '  (empty)')) + border('│'));
    }
    const end = Math.min(nodes.length, this.scroll + MAX_VISIBLE);
    for (let i = this.scroll; i < end; i++) {
      const node = nodes[i];
      const isSel = i === this.selected;
      const marker = node.kind === 'submenu' ? '▸' : '·';
      const label = `${marker} ${node.label}`;
      const detail = node.detail ? `  ${node.detail}` : '';
      let text = truncateToWidth(label + detail, inner - 2);
      if (isSel) text = style.bg(C.accent, style.fg(C.bg ?? '#000000', ` ${text} `));
      else text = ` ${text} `;
      lines.push(border('│') + pad(text) + border('│'));
    }
    const hint = this.path.length > 0 ? '↑↓ move · Enter open · Esc back' : '↑↓ move · Enter open · Esc close';
    lines.push(border('├' + '─'.repeat(inner) + '┤'));
    lines.push(border('│') + pad(style.fg(C.dim, ` ${truncateToWidth(hint, inner - 2)}`)) + border('│'));
    lines.push(border('╰' + '─'.repeat(inner) + '╯'));
    return lines;
  }
}