// ─────────────────────────────────────────────────────────────────────────────
// gauge — a context-pressure gauge for the merged status strip.
//
// The full context breakdown lives in contextViz.ts but only surfaces when the
// operator runs /context. Until then, pressure is invisible — the cliff
// (auto-summarize at summarizeTriggerRatio) arrives as a surprise. This module
// renders a compact block gauge that rides in the strip wherever the usage
// segment rides today (the strip's shrink ladder already drops extras first).
//
// Pure module: returns the glyph bar + a semantic level; the layout layer owns
// the actual color so strip mode (no SGR) degrades to plain text for free.
// ─────────────────────────────────────────────────────────────────────────────

/** Escalation level — the layout maps this to theme colors. */
export type GaugeLevel = 'normal' | 'warn' | 'hot';

/** Default cell count — 10 cells + " 100%" label = 15 cols max. */
export const GAUGE_CELLS = 10;

export const GAUGE_FILLED = '▮';
export const GAUGE_EMPTY = '▯';
/** Trigger-position marker (unfilled cell at the summarize threshold). */
export const GAUGE_TRIGGER = '◦';

export interface ContextGauge {
  /** The rendered bar, e.g. "▮▮▮▮▮▯◦▯▯▯". */
  bar: string;
  /** Percentage label, e.g. " 63%". */
  label: string;
  /** Semantic escalation level for coloring. */
  level: GaugeLevel;
}

/** Escalation thresholds (percent of the context window). */
export function gaugeLevel(pct: number): GaugeLevel {
  if (pct >= 90) return 'hot';
  if (pct >= 75) return 'warn';
  return 'normal';
}

/**
 * Render the gauge.
 *
 * @param pct     usage percent 0–100 (fractions allowed; clamped).
 * @param trigger summarizeTriggerRatio 0–1 (e.g. 0.9) — the cell at this ratio
 *                is marked when unfilled, so the cliff is visible before it hits.
 *                Omit (or pass NaN/out-of-range) to skip the marker.
 * @param cells   cell count (default 10).
 */
export function formatContextGauge(pct: number, trigger?: number, cells: number = GAUGE_CELLS): ContextGauge {
  const n = Math.max(1, Math.floor(cells));
  if (!Number.isFinite(pct) || pct < 0) {
    return { bar: GAUGE_EMPTY.repeat(n), label: ' ?%', level: 'normal' };
  }
  const clamped = Math.min(100, pct);
  const filled = Math.round((clamped / 100) * n);
  const hasTrigger = typeof trigger === 'number' && Number.isFinite(trigger) && trigger > 0 && trigger <= 1;
  const triggerIdx = hasTrigger ? Math.min(n - 1, Math.max(0, Math.round((trigger as number) * n) - 1)) : -1;
  let bar = '';
  for (let i = 0; i < n; i++) {
    bar += i < filled ? GAUGE_FILLED : i === triggerIdx ? GAUGE_TRIGGER : GAUGE_EMPTY;
  }
  return { bar, label: ` ${Math.round(clamped)}%`, level: gaugeLevel(clamped) };
}

/** The full strip fragment: "▮▮▮▯◦▯▯▯▯▯ 43%". */
export function contextGaugeFragment(pct: number, trigger?: number, cells: number = GAUGE_CELLS): ContextGauge & { text: string } {
  const g = formatContextGauge(pct, trigger, cells);
  return { ...g, text: g.bar + g.label };
}
