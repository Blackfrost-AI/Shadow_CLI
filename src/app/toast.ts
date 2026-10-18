/**
 * Transient toast channel — the "what just happened" layer.
 *
 * Background work in Shadow is asynchronous by nature: a sub-agent finishes while you are typing,
 * a background shell exits, a watcher fires. Before this module the only trace was a line pushed
 * into the transcript, which scrolls away in the stream — so a task that completed 40 seconds ago
 * was effectively invisible.
 *
 * Design rules (all of them enforced by tests):
 * - NEVER steals focus. Toasts are render-only; no key handling, no cursor movement, no input
 *   capture. Dismissal is by timeout, not by requiring interaction.
 * - Bounded. At most MAX_VISIBLE are on screen; older ones are dropped, not queued forever.
 * - Deduplicating. Identical messages within the coalesce window collapse into one toast with a
 *   repeat count, so a chatty watcher cannot strobe the footer.
 * - Zero rows when empty, so a quiet session looks exactly as before.
 */

import type { Component } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { RESET, style } from './ansi.js';
import { C } from '../tui/theme.js';
import { sanitizeTerminalEscapes } from '../util/scrub.js';

export type ToastLevel = 'info' | 'ok' | 'warn' | 'error';

export interface Toast {
  /** Stable identity for dedupe/coalesce. */
  key: string;
  level: ToastLevel;
  text: string;
  /** ms since epoch when it was created (or last re-raised, when coalesced). */
  at: number;
  /** How many times an identical message has been raised. */
  repeats: number;
  /** Lifetime in ms from `at`. */
  ttl: number;
}

export const MAX_VISIBLE = 2;
export const DEFAULT_TTL = 6000;
/** Identical messages raised inside this window fold into the existing toast. */
export const COALESCE_MS = 4000;

const GLYPH: Record<ToastLevel, string> = {
  info: '·',
  ok: '✓',
  warn: '!',
  error: '✗',
};

const COLOR: Record<ToastLevel, string> = {
  info: C.dim,
  ok: C.green,
  warn: C.yellow,
  error: C.red,
};

/** Pure, time-injected toast queue. No timers inside: `tick(now)` expires entries. */
export class ToastQueue {
  private items: Toast[] = [];

  /** Raise a toast. Identical keys inside COALESCE_MS fold into the existing entry. */
  raise(input: { key?: string; level?: ToastLevel; text: string; ttl?: number; now?: number }): Toast {
    const now = input.now ?? Date.now();
    const level = input.level ?? 'info';
    const key = input.key ?? `${level}:${input.text}`;
    const ttl = input.ttl ?? DEFAULT_TTL;

    const existing = this.items.find((t) => t.key === key && now - t.at <= COALESCE_MS);
    if (existing) {
      // Slide forward rather than stacking: a repeated event reads as one toast with a count.
      existing.at = now;
      existing.repeats += 1;
      existing.ttl = ttl;
      return existing;
    }

    // Push newest last, then keep only the most recent MAX_VISIBLE. Oldest are dropped outright:
    // a backlog of stale toasts is worse than losing one.
    const item: Toast = { key, level, text: input.text, at: now, repeats: 1, ttl };
    this.items = [...this.items.filter((t) => t.key !== key), item].slice(-MAX_VISIBLE);
    return item;
  }

  /** Drop expired toasts. Returns true when the visible set changed (caller should repaint). */
  tick(now = Date.now()): boolean {
    const before = this.items.length;
    this.items = this.items.filter((t) => now - t.at < t.ttl);
    return this.items.length !== before;
  }

  /** Currently live toasts, oldest first. */
  live(now = Date.now()): Toast[] {
    return this.items.filter((t) => now - t.at < t.ttl);
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}

/**
 * Format toasts into rows. Text is clamped to the width and the level drives the colour; the
 * count suffix appears only when a message repeated.
 *
 * Toast text routinely carries model-supplied strings (sub-agent types, descriptions, statuses),
 * so it is sanitised here as well as at the call sites. A concealed escape sequence living in a
 * sub-agent's name would otherwise be invisible on screen while rewriting the line, which is
 * exactly the class of bug the escape tests exist to catch.
 */
export function toastLines(toasts: readonly Toast[], width: number): string[] {
  const w = Math.max(1, width);
  return toasts.map((t) => {
    const badge = `${GLYPH[t.level]} `;
    const count = t.repeats > 1 ? ` ×${t.repeats}` : '';
    // Reserve columns for the badge and the count so truncation keeps the count visible.
    const room = Math.max(1, w - visibleWidth(badge) - visibleWidth(count));
    const text = truncate(sanitizeTerminalEscapes(t.text, false), room);
    return style.fg(COLOR[t.level], badge) + style.fg(COLOR[t.level], text) + style.dim(count) + RESET;
  });
}

/** Width-aware truncation that preserves ANSI-free text and appends an ellipsis. */
function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (visibleWidth(flat) <= width) return flat;
  let out = '';
  for (const ch of flat) {
    if (visibleWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * pi-tui cell. Renders nothing when the queue is empty so the footer does not reserve rows.
 * Positioned directly above the status bar; it must never sit above the editor, where it would
 * push typing around.
 *
 * Formatting happens here rather than in state because row width is only known at render time.
 */
export class ToastCell implements Component {
  constructor(private readonly live: () => readonly Toast[]) {}

  invalidate(): void {}

  render(width: number): string[] {
    const toasts = this.live();
    if (!toasts.length) return [];
    return toastLines(toasts, width);
  }
}
