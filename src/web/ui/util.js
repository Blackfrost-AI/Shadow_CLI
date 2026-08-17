/**
 * Formatting helpers. Pure functions, no DOM — shared by the sidebar, transcript, stats strip
 * and details rail. Every duration/number renders through here so the whole console speaks one
 * number language (tabular, compact, dsh-style).
 */

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** "now", "12s", "5m", "3h", "2d" — sidebar and trajectory timestamps. */
export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** HH:MM for anything older than a day. */
export function timeHM(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** ms → "0.8s", "12.4s", "2m 14s" — durations and TTFT. */
export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms / 100) / 10}s`;
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** tokens → "832", "12.4k", "1.2M" — token counters stay short in the strip. */
export function fmtTok(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}

/** Percentage with one decimal only when it matters: 3%, 12.5%, 100%. */
export function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  return p < 10 ? `${Math.round(p * 10) / 10}%` : `${Math.round(p)}%`;
}

/** Collapse an absolute path for display: "~/code/shadow-cli/src/web" → "shadow-cli/src/web". */
export function shortPath(p, keep = 2) {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  const home = parts[0] === 'Users' && parts.length > 3 ? parts.slice(0, 3).join('/') : null;
  const tail = home ? parts.slice(3) : parts;
  const shown = tail.slice(-keep).join('/');
  return shown || p;
}

/** Last path segment ("run_shell" targets, file names). */
export function baseName(p) {
  if (!p) return '';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

/** First non-empty line, truncated — one-line previews for queues and titles. */
export function oneLine(s, max = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Derive a session title from the first user prompt. */
export function titleFromPrompt(s, max = 42) {
  const t = oneLine(s, max + 1);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
