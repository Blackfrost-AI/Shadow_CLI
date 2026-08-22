/** Pure terminal layout math for the Shadow TUI — no React/Ink imports. */

import { formatContextGauge } from './gauge.js';

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
 *
 * `composerInputRows` is the draft's CURRENT visual height (1 when empty). The baseline 11 assumes
 * a single-line composer; the composer actually grows to COMPOSER_MAX_VISIBLE_ROWS (8), and those
 * extra rows were unbudgeted — an expanded task list plus a multi-line draft pushed the frame to
 * terminal height and wiped the user's scrollback on every keystroke.
 */
/**
 * Rows of draft the composer may show without the live frame reaching terminal height.
 *
 * The counterpart to `pinnedMaxItems`, and deliberately in the same file: the scrollback-wipe bug
 * survived because these two budgets were computed independently, from different assumptions, in
 * different modules. The composer's own cap only counted its 2 rules (`rows - 3`) and knew nothing
 * about the pinned block or the status strip, so `pinnedMaxItems` could correctly return 0 items
 * and the frame STILL overflowed on the draft alone.
 *
 * Chrome accounted for: composer marginTop 1 + composer box 4 + status strip 1 = 6, plus 1 row of
 * headroom, plus the pinned block's own fixed chrome (marginTop 1 + rules 2 + header 1 + '+N more'
 * 1 = 5) when it is visible, plus one row each for goal / plan-path / custom statusline.
 */
export function composerMaxRows(
  rows: number,
  hasPinnedBlock: boolean,
  hasGoal = false,
  hasPlanPath = false,
  hasCustomStatus = false,
): number {
  const chrome =
    7 +
    (hasPinnedBlock ? 5 : 0) +
    (hasGoal ? 1 : 0) +
    (hasPlanPath ? 1 : 0) +
    (hasCustomStatus ? 1 : 0);
  return Math.max(1, Math.min(COMPOSER_VISIBLE_ROW_CAP, rows - chrome));
}

/** Hard ceiling on composer draft rows, mirroring COMPOSER_MAX_VISIBLE_ROWS in tui/composer.ts. */
export const COMPOSER_VISIBLE_ROW_CAP = 8;

export function pinnedMaxItems(
  rows: number,
  hasGoal: boolean,
  hasPlanPath: boolean,
  hasCustomStatus: boolean,
  composerInputRows = 1,
): number {
  const extraComposer = Math.max(0, composerInputRows - 1);
  const chrome =
    11 + extraComposer + (hasGoal ? 1 : 0) + (hasPlanPath ? 1 : 0) + (hasCustomStatus ? 1 : 0);
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
  /** Context usage percent (0-100) — when present the ctx segment gains a block gauge. */
  contextPct?: number;
  /** summarizeTriggerRatio (0-1) — marks the cliff cell on the gauge when known. */
  triggerRatio?: number;
}

/** 24-bit SGR for a #rrggbb hex color. Pure (no deps) so layout stays standalone. */
function sgrFg24(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '';
  const n = parseInt(m[1]!, 16);
  return `\u001b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/** Build the 1-line status strip (priority fields first; drops plan/todo on narrow). */
export function formatStatusStrip(
  input: StatusStripInput,
  cols: number,
  palette?: { warn?: string; hot?: string },
): string {
  const core = `${input.provider}/${input.model} · mode: ${input.autonomy}${input.bypass ? ' (yolo)' : ''}`;
  // Context gauge rides at the head of the ctx segment — same drop priority as the usage
  // text (drops LAST, before it the mode label). Plain text for the width ladder; the
  // SGR color is injected into the WINNING tier only, so `.length` math stays exact.
  const gauge = Number.isFinite(input.contextPct) && (input.contextPct as number) >= 0
    ? formatContextGauge(input.contextPct as number, input.triggerRatio)
    : null;
  const gaugeText = gauge ? `${gauge.bar}${gauge.label} · ` : '';
  const ctx = `${gaugeText}${input.status}`;
  const extras = `${input.effortStatus ?? ''}${input.planStatus ?? ''}${input.todoStatus ?? ''}${input.sandboxStatus ?? ''}`;
  const full = `${core}${extras} · ${ctx}`;
  const narrow = `${core} · ${ctx}`;
  // Usage (tokens/ctx%/cost) outlives the mode label as width shrinks: it is the strip's only
  // early warning of context exhaustion, so it drops LAST — before it, lose extras, then mode.
  const slim = `${input.model} · ${ctx}`;
  const min = `${input.model} · ${input.autonomy}`;
  // Colorize the gauge in the winning tier (the gauge is present only when ctx is).
  const paintGauge = (tier: string): string => {
    if (!gauge || !palette) return tier;
    const hex = gauge.level === 'hot' ? palette.hot : gauge.level === 'warn' ? palette.warn : null;
    if (!hex) return tier;
    const sgr = sgrFg24(hex);
    if (!sgr) return tier;
    return tier.replace(gaugeText, `${sgr}${gaugeText}\u001b[39m`);
  };
  if (full.length <= cols) return paintGauge(full);
  if (narrow.length <= cols) return paintGauge(narrow);
  if (slim.length <= cols && ctx) return paintGauge(slim);
  if (min.length <= cols) return min;
  return min.slice(0, Math.max(8, cols - 1)) + '…';
}

/** Which optional live-frame rows fit, and the composer hint. See fitHud. */
export interface HudFit {
  liveRows: number;   // height of the streaming preview region (0..liveWant)
  status: boolean;    // the 'working… Ns' / spacer line above the composer
  pinned: boolean;    // the 1-row pinned goal/task summary while running
  queued: boolean;    // the type-ahead queue line
  custom: boolean;    // the customStatus (/statusline) strip
  hint: boolean;      // the composer's keybinding hint row
  toast: boolean;     // the transient toast row (clipboard/theme/style acks — never Static)
  marginTop: boolean; // the blank spacer above the composer group
  strip: boolean;     // the main status strip
  height: number;     // total live-frame height this produces (always < rows for rows >= 4)
}

/**
 * Bound the LIVE (non-<Static>) frame so its height stays STRICTLY below `rows`. Ink wipes the whole
 * screen + scrollback and re-dumps the entire transcript on EVERY render when `outputHeight >= rows`
 * (node_modules/ink/build/ink.js:121) — the flicker/duplication you get on a short or split-pane
 * terminal). The composer's input + its two borders (3 rows) are mandatory; every other row is added
 * only while it still fits under `rows - 1`, in priority order, so as the terminal shrinks the least
 * important rows drop first (custom status → toast → queued → pinned → margin → live preview →
 * status line → strip → hint) and the frame never reaches the terminal height. Pure; the invariant is unit-tested.
 */
export function fitHud(
  rows: number,
  want: {
    liveWant: number;
    pinned: boolean;
    queued: boolean;
    custom: boolean;
    /** The transient toast row is currently UP (a recent ack is showing). 1 row when it fits. */
    toast?: boolean;
    /** The live slot is currently BLANK (idle reserve): rank it below the hint so short terminals keep real content over empty rows. */
    liveBlank?: boolean;
    /** Separate status strip row. Default true; Phase B merges strip into hint/status so callers pass false. */
    strip?: boolean;
    /**
     * Visual rows of composer *input* (not counting the two border rules).
     * Default 1 (single-line). Multi-line drafts raise this so the live frame budget stays honest.
     */
    composerInputRows?: number;
  },
): HudFit {
  const cap = rows - 1; // outputHeight must be <= rows - 1 to stay under Ink's wipe threshold
  // The composer's OWN chrome (2 rules + N input rows) is mandatory, but it must never by itself
  // reach the terminal height or Ink wipes the screen on every keystroke. Clamp the input rows so
  // the base (2 + input) stays <= cap even if the caller requests more — the documented invariant
  // "height < rows for rows >= 4" then holds for any composerInputRows.
  const inputRows = Math.max(1, Math.min(want.composerInputRows ?? 1, Math.max(1, rows - 3)));
  const f: HudFit = {
    liveRows: 0, status: false, pinned: false, queued: false, custom: false,
    hint: false, toast: false, marginTop: false, strip: false,
    // Composer chrome: top rule + N (clamped) input rows + bottom rule.
    height: 2 + inputRows,
  };
  // Added high-priority → low: whatever doesn't fit as the terminal shrinks drops from the bottom of
  // this list first (cosmetic blank spacer goes first, then custom status, queued, pinned, …).
  // `liveWant` is the desired streaming-preview height (0 when there's nothing live to show).
  const add = (n: number, on: () => void): void => { if (f.height + n <= cap) { f.height += n; on(); } };
  // Separate strip is optional — Phase B merges model/mode/ctx into the composer hint (idle) or
  // the working status line (running), reclaiming one permanent chrome row.
  if (want.strip !== false) add(1, () => (f.strip = true));
  add(1, () => (f.status = true));  // 'working…' status line (liveness)
  const addLive = (): void => { for (let i = 0; i < want.liveWant; i++) add(1, () => (f.liveRows += 1)); };
  const addHint = (): void => add(1, () => (f.hint = true)); // composer hint — also carries merged strip when idle
  // An idle live slot is BLANK reserve rows; the hint (which carries the merged model/mode/ctx/
  // OFFLINE strip) must outrank blank rows on short terminals. While running, the streaming
  // preview is real content and keeps its priority above the hint.
  if (want.liveBlank) { addHint(); addLive(); } else { addLive(); addHint(); }
  if (want.pinned) add(1, () => (f.pinned = true));  // goal / task summary
  if (want.queued) add(1, () => (f.queued = true));
  if (want.toast) add(1, () => (f.toast = true));    // transient ack — outranks /statusline, not the queue
  if (want.custom) add(1, () => (f.custom = true));
  add(1, () => (f.marginTop = true)); // cosmetic blank above the composer — first to go
  return f;
}

