// src/app/subagents.ts — the live sub-agent panel for the pi shell (P1.2).
//
// Thin renderer over 8.7's PURE panel formatter (src/tui/subagentPanel.ts): that module owns the
// per-agent status clauses, the running-first ordering, the degrade-to-summary budget logic and
// the "queued agents are not running" honesty rule. This file only maps its structured lines onto
// the palette and implements the Component contract.

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { renderSubAgentPanel, type SubAgentPanelLine, type SubAgentView } from '../tui/subagentPanel.js';
import { C } from '../tui/theme.js';
import { RESET, fgAnsi } from './ansi.js';
import { fitLines } from './cells.js';

/** The palette slots the structured colorIndex maps onto (deterministic, from subagentColorIndex). */
const PALETTE = [C.cyan, C.purple, C.yellow, C.green, C.red];

/** Glyphs carry the shape cue; running rows get the bright tier, finished rows dim. */
function lineToAnsi(l: SubAgentPanelLine): string {
  const color = l.colorIndex >= 0 ? PALETTE[l.colorIndex % PALETTE.length] : undefined;
  const prefix =
    l.kind === 'agent' || l.kind === 'summary' || l.kind === 'header'
      ? fgAnsi(l.running ? C.accent : C.dim)
      : fgAnsi(C.dim);
  const label = color && l.label ? fgAnsi(color) + l.label + RESET : l.label;
  const detail = l.detail ? fgAnsi(C.dim) + l.detail + RESET : '';
  return `${prefix}${l.glyph}${l.glyph ? ' ' : ''}${RESET}${label}${fgAnsi(C.dim)}${detail}${RESET}`.replace(
    `${RESET}${RESET}`,
    RESET,
  );
}

/** How many rows the panel may take in the live frame — bounded, degrading per the formatter. */
export const SUBAGENT_PANEL_MAX_ROWS = 4;

export class SubAgentsCell implements Component {
  private cachedWidth = -1;
  private cachedSig = '';
  private cachedLines: string[] | null = null;

  constructor(
    private getAgents: () => SubAgentView[],
    private getRows: () => number,
  ) {}

  invalidate(): void {
    this.cachedLines = null;
  }

  render(width: number): string[] {
    const agents = this.getAgents();
    if (!agents.length) return [];
    // Signature covers everything the formatter reads, so an unchanged registry costs nothing
    // (the engine re-renders the live region on every spinner tick).
    const sig = agents
      .map(
        (a) =>
          `${a.taskId}:${a.done ? 1 : 0}:${a.queued ? 1 : 0}:${a.tool ?? ''}:${a.toolUseCount}:${
            a.inputTokens + a.outputTokens
          }`,
      )
      .sort()
      .join('|');
    if (this.cachedLines && this.cachedWidth === width && this.cachedSig === sig) return this.cachedLines;

    const maxRows = Math.min(SUBAGENT_PANEL_MAX_ROWS, Math.max(1, Math.floor(this.getRows() / 4)));
    const lines = renderSubAgentPanel(agents, maxRows, PALETTE.length);
    const out = ['', ...lines.map(lineToAnsi)];
    this.cachedWidth = width;
    this.cachedSig = sig;
    this.cachedLines = fitLines(
      out.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, '…') : l)),
      width,
    );
    return this.cachedLines;
  }
}
