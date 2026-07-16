/**
 * Terminal charts — pure renderers for fenced ```chart blocks in answers.
 *
 * A model (or user) writes a tiny line-oriented spec; Shadow renders real unicode
 * charts in the transcript instead of leaving ASCII art to chance:
 *
 *   ```chart
 *   type: bar                ← bar (default when labeled) | line | spark
 *   title: Requests by region
 *   us-east: 1240
 *   eu-west: 890
 *   ap-south: 431
 *   ```
 *
 * Data rows accept `label: value`, `label | value`, `label, value`, or bare
 * number lists (`3 8 4 12 9` — line/spark material). Values may carry commas,
 * a currency prefix, or a short unit suffix ("1,240", "$90", "45%", "120ms");
 * the ORIGINAL string is kept for display, the parsed number drives geometry.
 *
 * Design rules (dataviz doctrine, adapted to a terminal):
 *  - one series per chart, ONE hue — the `bar` role; labels/values/axes wear
 *    text tokens (fg/dim), never the series color;
 *  - direct labels on bars (the terminal convention), recessive axes;
 *  - geometry is width-aware and degrades: long labels truncate, dense series
 *    resample, and a spec that doesn't parse falls back to a plain code block
 *    (the renderer must never crash or emit garbage on model sloppiness).
 *  - future multi-series: use accents in the order cyan → yellow → purple →
 *    red → green (interleaved for CVD separation; og green↔cyan adjacency
 *    fails the normal-vision floor, validated 2026-07-16).
 *
 * Pure module: no Ink, no theme — rows of {text, role} spans; callers map
 * roles to the active palette.
 */

export type ChartRole = 'title' | 'label' | 'bar' | 'value' | 'axis';

export interface ChartSpan {
  text: string;
  role: ChartRole;
}

export interface ChartPoint {
  label: string;
  value: number;
  /** The value as written in the spec (keeps "1,240", "$90", "45%"). */
  display: string;
}

export interface ChartSpec {
  type: 'bar' | 'line' | 'spark';
  title?: string;
  points: ChartPoint[];
}

/** Fence languages that route to the chart renderer (case-insensitive). */
export const CHART_LANGS: ReadonlySet<string> = new Set(['chart', 'graph', 'spark', 'sparkline']);

// ── parsing ───────────────────────────────────────────────────────────────────

/** "1,240" / "$90" / "45%" / "120ms" / "-3.5" → number, or null when not numeric. */
function parseValue(raw: string): number | null {
  const s = raw.trim();
  // optional sign, optional currency, digits with , _ or space separators, optional
  // decimal, optional short unit tail (%, ms, s, GB…, ≤4 alphanumeric chars).
  const m = /^([+\-−]?)\s*[$€£¥]?\s*(\d[\d,_ ]*(?:\.\d+)?)\s*(%|[a-zA-Z]{1,4})?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[2]!.replace(/[,_ ]/g, ''));
  if (!Number.isFinite(n)) return null;
  return m[1] === '-' || m[1] === '−' ? -n : n;
}

const TYPE_ALIASES: Record<string, ChartSpec['type']> = {
  bar: 'bar',
  bars: 'bar',
  line: 'line',
  graph: 'line',
  area: 'line',
  spark: 'spark',
  sparkline: 'spark',
};

/**
 * Parse a chart spec. Returns null when the block doesn't hold at least one
 * plottable point — the caller then renders it as an ordinary code block.
 */
export function parseChartSpec(src: string): ChartSpec | null {
  let type: ChartSpec['type'] | undefined;
  let title: string | undefined;
  const points: ChartPoint[] = [];
  let sawLabel = false;

  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const colon = line.indexOf(':');
    const pipeSplit = colon < 0 ? line.split(/\s*[|]\s*/) : null;
    let label: string | null = null;
    let valueRaw: string | null = null;

    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const rest = line.slice(colon + 1).trim();
      const lower = key.toLowerCase();
      if (lower === 'type') {
        type = TYPE_ALIASES[rest.toLowerCase()] ?? type;
        continue;
      }
      if (lower === 'title') {
        title = rest;
        continue;
      }
      label = key;
      valueRaw = rest;
    } else if (pipeSplit && pipeSplit.length === 2) {
      [label, valueRaw] = [pipeSplit[0]!.trim(), pipeSplit[1]!.trim()];
    } else if (/,/.test(line) && line.split(',').length === 2 && parseValue(line.split(',')[1]!) !== null) {
      const [l, v] = line.split(',');
      [label, valueRaw] = [l!.trim(), v!.trim()];
    } else {
      // Bare numbers ("3 8 4 12" or "3, 8, 4, 12") — unlabeled series material.
      const toks = line.split(/[\s,]+/).filter(Boolean);
      const vals = toks.map(parseValue);
      if (toks.length >= 1 && vals.every((v) => v !== null)) {
        vals.forEach((v, i) => points.push({ label: '', value: v!, display: toks[i]! }));
        continue;
      }
      return null; // a line that is neither directive, point, nor numbers — not a chart
    }

    const v = parseValue(valueRaw!);
    if (v === null) return null; // "label: prose" — not a chart, don't guess
    sawLabel = sawLabel || label !== '';
    points.push({ label: label!, value: v, display: valueRaw!.trim() });
  }

  if (points.length === 0) return null;
  // Untyped specs: labeled data reads as a bar chart; a bare number series as a line.
  const resolved: ChartSpec['type'] = type ?? (sawLabel ? 'bar' : 'line');
  if ((resolved === 'line' || resolved === 'spark') && points.length < 2) return null;
  return { type: resolved, title, points };
}

// ── shared bits ───────────────────────────────────────────────────────────────

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const;
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/** Compact axis number: 1234 → 1.2k, 2500000 → 2.5M, 0.5 → 0.5. */
export function fmtAxis(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}${trim1(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}${trim1(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}${trim1(a / 1e3)}k`;
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}
function trim1(n: number): string {
  const s = (Math.round(n * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function truncLabel(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** Resample `values` to exactly `n` points by linear interpolation (n ≥ 2). */
function resample(values: number[], n: number): number[] {
  if (values.length === n) return values.slice();
  if (values.length === 1) return new Array(n).fill(values[0]);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (values.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(values.length - 1, lo + 1);
    const f = t - lo;
    out.push(values[lo]! * (1 - f) + values[hi]! * f);
  }
  return out;
}

// ── bar ───────────────────────────────────────────────────────────────────────

function renderBar(spec: ChartSpec, width: number): ChartSpan[][] {
  const rows: ChartSpan[][] = [];
  if (spec.title) rows.push([{ text: spec.title, role: 'title' }]);

  const labelW = Math.min(24, Math.max(0, ...spec.points.map((p) => p.label.length)));
  const valueW = Math.max(...spec.points.map((p) => p.display.length));
  // label + space + bar + space + value must fit `width`; bars get what's left.
  const barW = Math.max(4, width - labelW - valueW - (labelW > 0 ? 2 : 1));
  const maxAbs = Math.max(...spec.points.map((p) => Math.abs(p.value)), 0);

  for (const p of spec.points) {
    const eighths = maxAbs === 0 ? 0 : Math.round((Math.abs(p.value) / maxAbs) * barW * 8);
    const full = Math.floor(eighths / 8);
    const rem = eighths % 8;
    // A non-zero value always shows at least a sliver — a bar that rounds to
    // nothing reads as zero, which is a lie.
    let bar = '█'.repeat(full) + EIGHTHS[rem]!;
    if (bar === '' && p.value !== 0) bar = '▏';
    const row: ChartSpan[] = [];
    if (labelW > 0) row.push({ text: `${truncLabel(p.label, labelW).padEnd(labelW)} `, role: 'label' });
    row.push({ text: bar, role: 'bar' });
    // Values right-align on a shared edge (ledger style): pad to the bar column's end,
    // then padStart within the value column.
    row.push({ text: `${' '.repeat(Math.max(1, barW - bar.length + 1))}${p.display.padStart(valueW)}`, role: 'value' });
    rows.push(row);
  }
  return rows;
}

// ── spark ─────────────────────────────────────────────────────────────────────

function renderSpark(spec: ChartSpec, width: number): ChartSpan[][] {
  const rows: ChartSpan[][] = [];
  if (spec.title) rows.push([{ text: spec.title, role: 'title' }]);
  const values = spec.points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const tail = ` ${fmtAxis(lo)}…${fmtAxis(hi)}`;
  const room = Math.max(4, width - tail.length);
  const vs = values.length > room ? resample(values, room) : values;
  const glyphs = vs
    .map((v) => (hi === lo ? SPARKS[3] : SPARKS[Math.min(7, Math.floor(((v - lo) / (hi - lo)) * 8))]))
    .join('');
  rows.push([
    { text: glyphs, role: 'bar' },
    { text: tail, role: 'value' },
  ]);
  return rows;
}

// ── line (braille canvas) ─────────────────────────────────────────────────────

// Braille cell dot bits by (x ∈ 0..1, y ∈ 0..3).
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

const LINE_HEIGHT_CELLS = 6; // 24 dot rows — tall enough for shape, short enough for chat

function renderLine(spec: ChartSpec, width: number): ChartSpan[][] {
  const rows: ChartSpan[][] = [];
  if (spec.title) rows.push([{ text: spec.title, role: 'title' }]);

  const values = spec.points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const maxLbl = fmtAxis(hi);
  const minLbl = fmtAxis(lo);
  const gutterW = Math.max(maxLbl.length, minLbl.length);
  const plotW = Math.max(10, width - gutterW - 1);

  const dotW = plotW * 2;
  const dotH = LINE_HEIGHT_CELLS * 4;
  const ys = resample(values, dotW).map((v) =>
    hi === lo ? Math.floor(dotH / 2) : Math.round(((hi - v) / (hi - lo)) * (dotH - 1)),
  );

  // Paint the polyline: each dot column gets its point, plus a vertical run that
  // meets the previous column halfway — a continuous stroke, not scattered dots.
  const grid: number[][] = Array.from({ length: LINE_HEIGHT_CELLS }, () => new Array(plotW).fill(0));
  const set = (x: number, y: number): void => {
    const cx = x >> 1;
    const cy = y >> 2;
    if (cy < 0 || cy >= LINE_HEIGHT_CELLS || cx < 0 || cx >= plotW) return;
    grid[cy]![cx] = grid[cy]![cx]! | DOT_BITS[y & 3]![x & 1]!;
  };
  for (let x = 0; x < dotW; x++) {
    const y = ys[x]!;
    set(x, y);
    if (x > 0) {
      const prev = ys[x - 1]!;
      const mid = Math.floor((prev + y) / 2);
      const [a, b] = prev < y ? [prev, y] : [y, prev];
      // Split the vertical run at the midpoint: the half nearer `prev` draws in the
      // previous dot column, the half nearer `y` in this one — a smooth diagonal step.
      for (let yy = a; yy <= b; yy++) set((yy <= mid) === (prev < y) ? x - 1 : x, yy);
    }
  }

  for (let cy = 0; cy < LINE_HEIGHT_CELLS; cy++) {
    const axis =
      cy === 0 ? maxLbl.padStart(gutterW) : cy === LINE_HEIGHT_CELLS - 1 ? minLbl.padStart(gutterW) : ' '.repeat(gutterW);
    const braille = grid[cy]!.map((bits) => (bits ? String.fromCharCode(0x2800 + bits) : ' ')).join('');
    rows.push([
      { text: `${axis} `, role: 'axis' },
      { text: braille, role: 'bar' },
    ]);
  }
  return rows;
}

// ── entry ─────────────────────────────────────────────────────────────────────

/**
 * Render a parsed spec to rows of role-tagged spans at `width` columns.
 * Callers map roles to theme colors: title→bright+bold, label→fg, bar→accent
 * (single hue), value/axis→dim.
 */
export function renderChart(spec: ChartSpec, width: number): ChartSpan[][] {
  const w = Math.max(16, width);
  switch (spec.type) {
    case 'bar':
      return renderBar(spec, w);
    case 'spark':
      return renderSpark(spec, w);
    case 'line':
      return renderLine(spec, w);
  }
}
