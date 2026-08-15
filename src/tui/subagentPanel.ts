// Pure formatting for the live sub-agent panel (the founder's #1 gap: "you never see those sub
// agents or what they're doing"). Kept theme-free and Ink-free so it unit-tests without booting
// React or the palette: it emits STRUCTURED lines (a colorIndex, never a color token) that tui.tsx
// maps onto the active palette. Mirrors Claude Code's AgentProgressLine contract — per-agent type,
// description, tool-use count, tokens, current tool / Initializing… / Done — bounded to the
// constant 2-row live budget, degrading to a single summary row when it can't fit.

export interface SubAgentView {
  taskId: string;
  subagentType: string;
  description?: string;
  /** The tool the sub-agent is running right now (from its forwarded, taskId-tagged tool_start). */
  tool?: string;
  argPreview?: string;
  toolUseCount: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  background: boolean;
  /** F06-10: true while the agent waits for a session concurrency slot (semaphore). Cleared by
   *  the admission re-announcement, which re-registers this taskId. */
  queued?: boolean;
  /** Set once subagent_end arrives; the entry lingers (bg) until the next user turn clears it. */
  done?: boolean;
  ok?: boolean;
}

export type SubAgentLineKind = 'header' | 'agent' | 'more' | 'summary';

export interface SubAgentPanelLine {
  kind: SubAgentLineKind;
  /** Leading glyph: '▸' (header/summary), '├─' / '└─' (tree branch). */
  glyph: string;
  /** The type label (colored by colorIndex in the renderer); empty for header/more/summary. */
  label: string;
  /** Dim trailing detail after the label. */
  detail: string;
  /** Palette slot for the type label; -1 when there is no colored label. */
  colorIndex: number;
  /** True while this agent (or any agent, for the header) is still unresolved — drives the spinner/dim. */
  running: boolean;
}

/** Deterministic type→palette-slot mapping (stable across renders, testable without a palette). */
export function subagentColorIndex(type: string, paletteSize: number): number {
  if (paletteSize <= 0) return 0;
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return h % paletteSize;
}

/** Compact token count: 942 → "942", 1234 → "1.2k", 262144 → "262k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/** The status clause for one agent line. */
function agentStatus(a: SubAgentView): string {
  if (a.done) return a.ok === false ? 'failed' : 'Done';
  // F06-10: an agent waiting on a concurrency slot says so — "Initializing…" would lie about it.
  if (a.queued) return 'queued…';
  if (a.tool) return a.argPreview ? `${a.tool} ${a.argPreview}` : a.tool;
  // No tool yet: a fresh agent is "Initializing…"; a bg agent between tools reads "running…".
  return a.toolUseCount > 0 ? 'running…' : 'Initializing…';
}

/** The trailing counters clause, e.g. "· 3 tools · 1.2k tok". */
function counters(a: SubAgentView): string {
  const toks = a.inputTokens + a.outputTokens;
  const parts: string[] = [];
  if (a.toolUseCount > 0) parts.push(plural(a.toolUseCount, 'tool'));
  if (toks > 0) parts.push(`${formatTokens(toks)} tok`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function agentDetail(a: SubAgentView): string {
  const desc = a.description ? ` ${a.description}` : '';
  const bg = a.background ? ' [bg]' : '';
  return `${bg}${desc} · ${agentStatus(a)}${counters(a)}`;
}

/**
 * Render the panel to at most `maxRows` structured lines (the caller owns wrapping/colors).
 * `maxRows` is the live-budget rows the panel may use THIS frame; it degrades to one summary row
 * when the agents can't each get a line.
 */
export function renderSubAgentPanel(
  agents: SubAgentView[],
  maxRows: number,
  paletteSize: number,
): SubAgentPanelLine[] {
  if (agents.length === 0 || maxRows <= 0) return [];
  // F06-10: a queued agent holds NO slot and runs NO tools — counting it as "running" would lie.
  // It still keeps the panel live (anyRunning) so the row doesn't collapse to "finished".
  const running = agents.filter((a) => !a.done && !a.queued).length;
  const queuedCount = agents.filter((a) => !a.done && a.queued).length;
  const anyRunning = running > 0 || queuedCount > 0;
  const totalTools = agents.reduce((s, a) => s + a.toolUseCount, 0);
  const liveClause =
    (running > 0 ? `Running ${plural(running, 'agent')}` : '') +
    (queuedCount > 0 ? `${running > 0 ? ' · ' : ''}${queuedCount} queued` : '');

  // Single-agent, single-row: fold everything onto one line (no separate header).
  if (agents.length === 1 && maxRows >= 1) {
    const a = agents[0]!;
    return [
      {
        kind: 'agent',
        glyph: '▸',
        label: a.subagentType,
        detail: agentDetail(a),
        colorIndex: subagentColorIndex(a.subagentType, paletteSize),
        running: !a.done,
      },
    ];
  }

  // Tight budget with ≥2 agents: one summary row.
  const summary = (): SubAgentPanelLine => ({
    kind: 'summary',
    glyph: '▸',
    label: '',
    detail: anyRunning
      ? `${liveClause}${totalTools ? ` · ${plural(totalTools, 'tool call')}` : ''}…`
      : `${plural(agents.length, 'agent')} finished`,
    colorIndex: -1,
    running: anyRunning,
  });
  if (maxRows === 1) return [summary()];

  // Header + as many agent rows as fit; overflow folds into a "+N more" row.
  const header: SubAgentPanelLine = {
    kind: 'header',
    glyph: '▸',
    label: '',
    detail: anyRunning ? `${liveClause}…` : `${plural(agents.length, 'agent')} finished`,
    colorIndex: -1,
    running: anyRunning,
  };
  const bodyRows = maxRows - 1;
  const lines: SubAgentPanelLine[] = [header];
  // Running agents first so a burst of finished bg agents can't push a live one out of view.
  const ordered = [...agents].sort((a, b) => Number(!!a.done) - Number(!!b.done) || a.startedAt - b.startedAt);
  const needMore = ordered.length > bodyRows;
  const shown = needMore ? ordered.slice(0, Math.max(0, bodyRows - 1)) : ordered;
  shown.forEach((a, i) => {
    const last = !needMore && i === shown.length - 1;
    lines.push({
      kind: 'agent',
      glyph: last ? '└─' : '├─',
      label: a.subagentType,
      detail: agentDetail(a),
      colorIndex: subagentColorIndex(a.subagentType, paletteSize),
      running: !a.done,
    });
  });
  if (needMore) {
    const hidden = ordered.length - shown.length;
    lines.push({ kind: 'more', glyph: '  ', label: '', detail: `+${hidden} more`, colorIndex: -1, running: false });
  }
  return lines;
}
