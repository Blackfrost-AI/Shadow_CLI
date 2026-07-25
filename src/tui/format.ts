// src/tui/format.ts — pure formatting/parsing helpers lifted out of tui.tsx (T2-1 step 2).
//
// A mechanical MOVE: zero React, zero refs, zero behavior change. These were trapped inside a
// 6000-line component purely by history, which meant none of them could be unit-tested without
// booting Ink.

/** A lightweight renderer for the headless path that writes directly to stdout. */
/** Strip terminal control sequences (ESC / CSI / OSC / BEL / C1) from UNTRUSTED content before the
 *  headless renderer writes it RAW to stdout. Model output, tool output, and fetched web / file content
 *  can smuggle OSC 52 (clipboard write), window-retitle, forged clickable hyperlinks, or cursor moves
 *  that hide output. Keeps \t \n \r; drops everything else dangerous. The renderer's own A.* color
 *  constants are trusted and applied AFTER this, so they still render. (The interactive Ink TUI is
 *  already safe — Ink escapes — so only this raw path needed it.) */
export function stripCtl(s: string): string {
  return (
    s
      // OSC … terminated by BEL or ST
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // Fe / single-char escapes
      .replace(/\x1b[@-Z\\-_]/g, '')
      // CSI sequences
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // stray C0 controls (keep \t \n \r) + C1 CSI/OSC introducers
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x9b\x9d]/g, '')
  );
}

/** The usage numbers the status strip renders. */
export interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  contextPct: number;
}

/** Usage chrome fragment. Hides `$0.0000` (local / free runs) so the strip stays calm. */
export function formatUsage(e: UsageEvent): string {
  const total = e.inputTokens + e.outputTokens;
  const base = `${formatCount(total)} tokens · ctx ${Math.round(e.contextPct * 100)}%`;
  if (!(e.costUSD > 0)) return base;
  return `${base} · $${e.costUSD.toFixed(4)}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function shellCommandOf(input: unknown): string | null {
  const o = input as Record<string, unknown> | undefined;
  if (o && typeof o.command === 'string') return o.command;
  return null;
}

/** Pull subagent attribution (type + description) from an `agent` tool call's parsed input, so the
 *  TUI can render a sub-agent distinctly (`▸ type · description`) instead of an anonymous row. */
export function agentAttr(input: unknown): { subagentType?: string; description?: string } | undefined {
  const o = input as Record<string, unknown> | undefined;
  if (!o) return undefined;
  const description = typeof o.description === 'string' ? o.description : undefined;
  const subagentType = typeof o.subagent_type === 'string' ? o.subagent_type : undefined;
  return description || subagentType ? { description, subagentType } : undefined;
}

export function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}…` : flat;
}

/** Count +/- lines in a UI diff body for the one-row tool summary (`+12 −3`). */
export function formatDiffStats(lines: { text: string }[]): string {
  let plus = 0;
  let minus = 0;
  for (const l of lines) {
    const t = l.text;
    if (t.startsWith('…')) continue; // elision notice from capTranscriptBody
    if (t.startsWith('+') && !t.startsWith('+++')) plus++;
    else if (t.startsWith('-') && !t.startsWith('---')) minus++;
  }
  if (!plus && !minus) return '';
  if (plus && minus) return `+${plus} −${minus}`;
  if (plus) return `+${plus}`;
  return `−${minus}`;
}

export function shortPath(path: string): string {
  const home = process.env.HOME;
  const value = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return value.length > 42 ? `…${value.slice(-41)}` : value;
}
