/**
 * Context-window breakdown + token-saving suggestions for the `/context` view.
 *
 * Walks the message history and bucketizes token cost by category (user text,
 * assistant text, tool calls, tool results, reasoning, images) using the same
 * char/4 heuristic the budget uses for a pre-usage estimate. The provider's real
 * per-turn usage (inputTokens) is the source of truth for the *total*; this is a
 * per-category attribution of that cost so the user can see WHAT is consuming the
 * window and act on it.
 *
 * Pure: takes messages + numbers, returns structured data. Unit-testable.
 */
import type { ContentBlock, Message } from '../provider/provider.js';

export interface ContextCategory {
  label: string;
  tokens: number;
}

export interface ContextSuggestion {
  severity: 'info' | 'warn' | 'critical';
  title: string;
  /** Approximate tokens recoverable if the user acts on the tip. */
  savings?: number;
}

export interface ContextBreakdown {
  categories: ContextCategory[];
  messageTokens: number;
  /** System prompt + tool definitions overhead (total − messages), ≥ 0. */
  overheadTokens: number;
  total: number;
  budget: number;
  pct: number; // 0..1 (may exceed 1 when over budget)
}

/** char/4 estimate for a single content block (matches the budget heuristic). */
export function blockTokenEstimate(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
      return Math.ceil(b.text.length / 4);
    case 'thinking':
      return Math.ceil(b.thinking.length / 4);
    case 'redacted_thinking':
      return Math.ceil((b.data?.length ?? 0) / 4);
    case 'tool_use':
      return Math.ceil((b.name.length + JSON.stringify(b.input ?? {}).length) / 4);
    case 'tool_result':
      return Math.ceil((b.content ?? '').length / 4);
    case 'image':
      return 4000; // ~1k tokens flat (real cost arrives via usage events)
    default:
      // Unknown/future block type (e.g. a corrupt snapshot): never poison the
      // breakdown with undefined→NaN — count nothing rather than break /context.
      return 0;
  }
}

function categoryOf(m: Message, b: ContentBlock): string {
  if (b.type === 'tool_result') return 'Tool results';
  if (b.type === 'tool_use') return 'Tool calls';
  if (b.type === 'thinking' || b.type === 'redacted_thinking') return 'Reasoning';
  if (b.type === 'image') return 'Images';
  return m.role === 'assistant' ? 'Assistant text' : m.role === 'user' ? 'User text' : 'System';
}

/**
 * Build a category breakdown. `total` should be the provider-reported request
 * size when available (Context.lastActualTokens / estimateTokens); `budget` is
 * the contextBudget config. Overhead = total − sum(messages), floored at 0.
 */
export function categorizeContext(
  messages: readonly Message[],
  total: number,
  budget: number,
): ContextBreakdown {
  const byCat = new Map<string, number>();
  let messageTokens = 0;
  for (const m of messages) {
    for (const b of m.content) {
      const t = blockTokenEstimate(b);
      messageTokens += t;
      const cat = categoryOf(m, b);
      byCat.set(cat, (byCat.get(cat) ?? 0) + t);
    }
  }
  const categories: ContextCategory[] = [...byCat.entries()]
    .map(([label, tokens]) => ({ label, tokens }))
    .sort((a, b) => b.tokens - a.tokens);

  const effectiveTotal = Math.max(total, messageTokens);
  const overheadTokens = Math.max(0, effectiveTotal - messageTokens);
  return {
    categories,
    messageTokens,
    overheadTokens,
    total: effectiveTotal,
    budget,
    pct: budget > 0 ? effectiveTotal / budget : 0,
  };
}

/**
 * Generate actionable, prioritized token-saving tips from a breakdown.
 * Mirrors the reverse-engineered ContextSuggestions severity/savings shape.
 */
export function contextSuggestions(b: ContextBreakdown): ContextSuggestion[] {
  const out: ContextSuggestion[] = [];
  const overBudget = b.pct > 1;
  const near = b.pct > 0.75;

  if (overBudget) {
    out.push({ severity: 'critical', title: 'Over the context budget — compact now', savings: Math.round(b.total * 0.6) });
  } else if (near) {
    out.push({ severity: 'warn', title: 'Approaching the context budget — /compact to free space', savings: Math.round(b.total * 0.5) });
  }

  const top = b.categories[0];
  if (top && top.tokens > b.total * 0.4) {
    if (top.label === 'Tool results') {
      out.push({ severity: near ? 'warn' : 'info', title: 'Tool output dominates — read less into context (offset/limit)', savings: Math.round(top.tokens * 0.5) });
    } else if (top.label === 'Reasoning') {
      out.push({ severity: 'info', title: 'Reasoning is large — lower /effort for routine tasks' });
    } else if (top.label === 'Images') {
      out.push({ severity: 'info', title: 'Images are heavy (~4k tokens each) — drop stale attachments' });
    }
  }
  return out;
}
