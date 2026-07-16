// Collaboration Mode — the "baton" round-table controller (pure logic, no React/Ink).
//
// A live, MANUAL, in-foreground session where 2–4 models the user already owns share ONE
// conversation. The human holds the baton by default and routes each turn with `@handle <question>`;
// a routed model runs exactly one turn against the shared Context, then the baton returns to the human.
// This module is the pure core: deriving handles, resolving `/table` args to model entries, and parsing
// composer input into a command. The TUI drives providers/turns; nothing here touches the network,
// the model, or React state — so it is fully unit-testable.

import type { ModelEntry } from '../config.js';

/** Per-turn attribution painted in the transcript. Also the shape stored on a TranscriptItem. */
export interface SpeakerTag {
  handle: string;
  /** hex — assigned from a palette that excludes green (human) and orange (the baton). */
  color: string;
  /** "provider/model", shown dim beside the handle. */
  model: string;
}

/** A model seat at the table. The human is the implicit floor holder and is not a Seat. */
export interface Seat {
  handle: string;
  label: string;
  provider: string;
  model: string;
  color: string;
  entry: ModelEntry;
}

export const MIN_SEATS = 2;
export const MAX_SEATS = 4;

/** A short, unique @handle from a model's label: the first alpha run, lowercased, ≤8 chars. */
export function deriveHandle(label: string, taken: Set<string>): string {
  const base = (label.toLowerCase().match(/[a-z][a-z0-9]*/)?.[0] ?? 'model').slice(0, 8) || 'model';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const h = `${base}${i}`;
    if (!taken.has(h)) return h;
  }
}

/** Build seats from chosen entries, assigning a stable unique handle + a seat color (cycled). */
export function buildSeats(entries: ModelEntry[], colors: string[]): Seat[] {
  const taken = new Set<string>();
  return entries.map((entry, i) => {
    const handle = deriveHandle(entry.label, taken);
    taken.add(handle);
    return {
      handle,
      label: entry.label,
      provider: entry.provider,
      model: entry.model,
      color: colors[i % colors.length] ?? colors[0] ?? '#ffffff',
      entry,
    };
  });
}

export function seatTag(seat: Seat): SpeakerTag {
  return { handle: seat.handle, color: seat.color, model: `${seat.provider}/${seat.model}` };
}

/**
 * Resolve `/table` name arguments against the configured models. Matches (case-insensitive), in order:
 * exact label/model, then a label/model substring. Skips disabled entries and silently de-dups a repeat;
 * a name that matches nothing is collected in `errors`.
 */
export function resolveTableEntries(names: string[], models: ModelEntry[]): { entries: ModelEntry[]; errors: string[] } {
  const errors: string[] = [];
  const entries: ModelEntry[] = [];
  const live = models.filter((m) => !m.disabled);
  for (const name of names) {
    const n = name.toLowerCase();
    const hit =
      live.find((m) => m.label.toLowerCase() === n || m.model.toLowerCase() === n) ??
      live.find((m) => m.label.toLowerCase().includes(n) || m.model.toLowerCase().includes(n));
    if (!hit) errors.push(name);
    else if (!entries.includes(hit)) entries.push(hit);
  }
  return { entries, errors };
}

export type TableCommand =
  | { kind: 'route'; handle: string; question: string }
  | { kind: 'pass'; handle: string }
  | { kind: 'done' }
  | { kind: 'unknownHandle'; handle: string }
  | { kind: 'note' };

/**
 * Parse composer input while a table is ACTIVE. `handles` is the whitelist of seat handles — an
 * `@word` or `/pass word` that isn't a known handle returns `unknownHandle` (never routes), which is
 * the injection guard: a peer emitting "@shell" can never resolve to anything. Plain text is a `note`
 * (M1 shows a hint rather than appending a bare human turn).
 */
export function parseTableInput(input: string, handles: string[]): TableCommand {
  const t = input.trim();
  if (/^\/table(\s+(done|end|stop))?\s*$/i.test(t)) return { kind: 'done' };
  const pass = t.match(/^\/pass\s+@?(\S+)/i);
  if (pass) {
    const h = pass[1]!.toLowerCase();
    return handles.includes(h) ? { kind: 'pass', handle: h } : { kind: 'unknownHandle', handle: h };
  }
  const at = t.match(/^@(\S+)\s*([\s\S]*)$/);
  if (at) {
    const h = at[1]!.toLowerCase();
    if (!handles.includes(h)) return { kind: 'unknownHandle', handle: h };
    return { kind: 'route', handle: h, question: at[2]!.trim() };
  }
  return { kind: 'note' };
}
