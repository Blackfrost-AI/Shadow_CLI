import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { BORDER, GLYPHS } from '../tui/glyphs.js';
import { C } from '../tui/theme.js';
import { approvalText } from '../util/approvalText.js';
import { bgAnsi, RESET, style } from './ansi.js';

/** Frame an overlay in the current palette; callers sanitize display values before styling. */
export function panelRows(title: string, rows: string[], width: number, footer?: string): string[] {
  const w = Math.max(2, width);
  const inner = w - 2;
  const edge = (left: string, label: string, right: string) => {
    const head = truncateToWidth(` ${approvalText(label)} `, inner, '…');
    return style.fg(C.border ?? C.dim, left + head + BORDER.horizontal.repeat(Math.max(0, inner - visibleWidth(head))) + right);
  };
  const background = C.panel ?? C.menuBg;
  const body = rows.map((row) => {
    const text = truncateToWidth(row, Math.max(0, inner - 2), '…');
    return style.fg(C.border ?? C.dim, BORDER.vertical) + bgAnsi(background) + ' ' + text.replaceAll(RESET, RESET + bgAnsi(background)) + ' '.repeat(Math.max(1, inner - visibleWidth(text) - 1)) + RESET + style.fg(C.border ?? C.dim, BORDER.vertical);
  });
  return [edge(BORDER.topLeft, `${GLYPHS.tool} ${title}`, BORDER.topRight), ...body, edge(BORDER.bottomLeft, footer ?? '', BORDER.bottomRight)];
}
