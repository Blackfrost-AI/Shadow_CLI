import type { Component } from '@earendil-works/pi-tui';

// Snowfall content always spans the full terminal width, matching the 10.6.0/10.6.1 layout.
// The 10.6.2 fixed reading measure shrank every surface into a centered column, which reads as
// a broken, boxed-in window on normal-width terminals. Dialogs size independently.
export function contentMetrics(width: number): { contentWidth: number; left: number; right: number } {
  const contentWidth = Math.max(1, Math.floor(width));
  return { contentWidth, left: 0, right: 0 };
}

/**
 * Snowfall rows are rendered at the full viewport width. This stays a named seam so layout
 * geometry is described in one place and remains covered by regression tests; it deliberately
 * adds no wrapper box, so mouse dispatch, selection, and ScrollView all use native coordinates.
 */
export function centeredRow(child: Component): Component {
  return child;
}
