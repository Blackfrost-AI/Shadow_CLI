import { Spacer, type Component } from '@earendil-works/pi-tui';
import { LAYOUT_NODE } from '@earendil-works/pi-tui/dist/layout-node.js';
import type { StackLayoutEntry, StackLayoutNode } from '@earendil-works/pi-tui/dist/layout-node.js';

export const CONTENT_MAX_WIDTH = 100;
// Preserve the original narrow layout and gentle 120-column centering. Beyond that, grow with
// the viewport instead of leaving most of an ultrawide terminal unused. Dialogs size separately.
export const WIDE_CONTENT_PERCENT = 80;

export function contentMetrics(width: number): { contentWidth: number; left: number; right: number } {
  const terminalWidth = Math.max(1, Math.floor(width));
  const contentWidth = Math.min(terminalWidth, Math.max(CONTENT_MAX_WIDTH, Math.floor(terminalWidth * WIDE_CONTENT_PERCENT / 100)));
  const left = Math.floor((terminalWidth - contentWidth) / 2);
  return { contentWidth, left, right: terminalWidth - contentWidth - left };
}

/**
 * A native pi-tui horizontal stack with exact viewport-derived bases. Unlike flex spacers,
 * these bases do not round asymmetrically at odd widths. The child remains a real layout box,
 * so mouse dispatch, selection, and ScrollView use the same content origin as the renderer.
 */
export function centeredRow(child: Component): Component {
  const entries: StackLayoutEntry[] = [
    { component: new Spacer(1), basis: 0, grow: 0, shrink: 0 },
    { component: child, basis: CONTENT_MAX_WIDTH, grow: 0, shrink: 0 },
    { component: new Spacer(1), basis: 0, grow: 0, shrink: 0 },
  ];
  const sync = ({ width }: { width: number; height: number }): boolean => {
    const metrics = contentMetrics(width);
    entries[0]!.basis = metrics.left;
    entries[1]!.basis = metrics.contentWidth;
    entries[2]!.basis = metrics.right;
    return true;
  };
  for (const entry of entries) entry.visible = sync;
  const node: StackLayoutNode = {
    type: 'hstack', entries, gap: 0, align: 'stretch',
  };
  const row: Component = {
    render: (width) => child.render(contentMetrics(width).contentWidth),
    invalidate: () => child.invalidate(),
    // Native layout dispatches to the child with content-relative coordinates. Forwarding here
    // as well would dispatch twice and leak terminal-relative margin clicks into the child.
  };
  Object.assign(row, { [LAYOUT_NODE]: () => node });
  return row;
}
