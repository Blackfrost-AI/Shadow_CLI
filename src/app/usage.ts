/**
 * `/cost` `/usage` `/stats` line builder (extracted from app.ts — line budget).
 *
 * Pure: builds the transcript block lines for session usage stats. The shell keeps the
 * no-usage guard; everything after is formatting.
 */
export interface UsageStatsInput {
  sessionTurns: number;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  costUSD: number;
  lastUsage?: { inputTokens: number; outputTokens: number; costUSD: number };
}

export interface UsageStatsLine {
  text: string;
  bold?: boolean;
  color?: string;
  dimColor?: boolean;
}

export function usageStatsLines(stats: UsageStatsInput, cyan: string): UsageStatsLine[] {
  const lines: UsageStatsLine[] = [
    {
      text: `Session (${stats.sessionTurns} turn${stats.sessionTurns === 1 ? '' : 's'}): ${stats.sessionInputTokens.toLocaleString()} in · ${stats.sessionOutputTokens.toLocaleString()} out · ${(stats.sessionInputTokens + stats.sessionOutputTokens).toLocaleString()} total`,
      bold: true,
    },
  ];
  lines.push(
    stats.costUSD > 0
      ? { text: `Session cost: $${stats.costUSD.toFixed(4)}`, color: cyan }
      : { text: 'Session cost: none — local/unpriced model', dimColor: true },
  );
  if (stats.lastUsage) {
    lines.push({
      text: `Last turn: ${stats.lastUsage.inputTokens.toLocaleString()} in · ${stats.lastUsage.outputTokens.toLocaleString()} out${stats.lastUsage.costUSD > 0 ? ` · $${stats.lastUsage.costUSD.toFixed(4)}` : ''}`,
      dimColor: true,
    });
  }
  return lines;
}
