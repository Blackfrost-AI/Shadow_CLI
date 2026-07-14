/** Pure terminal layout math for the Shadow TUI — no React/Ink imports. */

export interface ChromeConfig {
  statusRows?: number;
  composerRows?: number;
  panelRows?: number;
  overlayRows?: number;
  /** Live welcome banner rows (wide ~8, narrow ~6) — reserved from transcript budget. */
  bannerRows?: number;
}

export interface TerminalLayout {
  cols: number;
  rows: number;
  statusRows: number;
  composerRows: number;
  panelRows: number;
  overlayRows: number;
  transcriptMaxHeight: number;
  wideBanner: boolean;
  useSidePanel: boolean;
  sidePanelCols: number;
}

/** Width of the figlet SHADOW wordmark (longest line). Keep in sync with SHADOW_ART in tui.tsx. */
export const SHADOW_LOGO_WIDTH = 50;

const LOGO_MIN_COLS = 90; // legacy wide threshold for computeLayout.wideBanner

/** True when cols can fit the left info column and the full wordmark side-by-side. */
export function fitsWideBanner(cols: number, leftTextCols: number): boolean {
  const borderPad = 6; // round border + paddingX
  const gap = 2;
  return cols >= leftTextCols + SHADOW_LOGO_WIDTH + borderPad + gap;
}

export function computeLayout(
  cols: number,
  rows: number,
  chrome: ChromeConfig = {},
): TerminalLayout {
  const c = Math.max(20, cols | 0);
  const r = Math.max(10, rows | 0);
  const statusRows = chrome.statusRows ?? 1;
  const composerRows = chrome.composerRows ?? 3;
  const panelRows = chrome.panelRows ?? 0;
  const overlayRows = chrome.overlayRows ?? 0;
  const bannerRows = chrome.bannerRows ?? 0;

  // Side panel for todo/plan when wide enough (mimics Claude flow: state on the side, not crowding transcript)
  const useSidePanel = c >= 90; // wide enough for transcript + side
  const sidePanelCols = useSidePanel ? Math.min(32, Math.floor((c - 10) * 0.28)) : 0; // ~28-32 cols for state

  const chromeTotal = statusRows + composerRows + panelRows + overlayRows + bannerRows;
  const transcriptMaxHeight = Math.max(4, r - chromeTotal);

  return {
    cols: c,
    rows: r,
    statusRows,
    composerRows,
    panelRows,
    overlayRows,
    transcriptMaxHeight,
    wideBanner: c >= LOGO_MIN_COLS,
    useSidePanel,
    sidePanelCols,
  };
}

/**
 * How many todo rows the idle PinnedState block may show without the live frame reaching terminal
 * height (Ink's clearTerminal fallback fires at outputHeight ≥ rows — the scrollback-wipe bug).
 * Fixed chrome outside the items: pinned marginTop 1 + rules 2 + header 1 + '+N more' 1 + composer
 * marginTop 1 + composer box 4 + status strip 1 = 11, plus one row each for goal / plan-path /
 * custom-statusline when present, plus 1 row headroom. Every row is wrap="truncate" (single-line),
 * so bounding the COUNT bounds the physical height exactly.
 */
export function pinnedMaxItems(
  rows: number,
  hasGoal: boolean,
  hasPlanPath: boolean,
  hasCustomStatus: boolean,
): number {
  const chrome = 11 + (hasGoal ? 1 : 0) + (hasPlanPath ? 1 : 0) + (hasCustomStatus ? 1 : 0);
  // Floor at 0, not 1: at 15 rows with all three extras present, chrome alone fills the budget —
  // forcing one item row pushed the frame to exactly terminal height (the fallback threshold).
  // With 0 items the '+N more' row still communicates the list's existence.
  return Math.max(0, Math.min(8, rows - 1 - chrome));
}

export interface StatusStripInput {
  provider: string;
  model: string;
  autonomy: string;
  bypass?: boolean;
  planStatus?: string;
  todoStatus?: string;
  sandboxStatus?: string; // e.g. ' · sandbox:off' under --yolo, else '' (core already shows '(yolo)')
  effortStatus?: string; // e.g. ' · ◑ high' — reasoning-depth indicator (drops on narrow)
  status: string;
}

/** Build the 1-line status strip (priority fields first; drops plan/todo on narrow). */
export function formatStatusStrip(input: StatusStripInput, cols: number): string {
  const core = `${input.provider}/${input.model} · mode: ${input.autonomy}${input.bypass ? ' (yolo)' : ''}`;
  const ctx = input.status;
  const extras = `${input.effortStatus ?? ''}${input.planStatus ?? ''}${input.todoStatus ?? ''}${input.sandboxStatus ?? ''}`;
  const full = `${core}${extras} · ${ctx}`;
  const narrow = `${core} · ${ctx}`;
  // Usage (tokens/ctx%/cost) outlives the mode label as width shrinks: it is the strip's only
  // early warning of context exhaustion, so it drops LAST — before it, lose extras, then mode.
  const slim = `${input.model} · ${ctx}`;
  const min = `${input.model} · ${input.autonomy}`;
  if (full.length <= cols) return full;
  if (narrow.length <= cols) return narrow;
  if (slim.length <= cols && ctx) return slim;
  if (min.length <= cols) return min;
  return min.slice(0, Math.max(8, cols - 1)) + '…';
}