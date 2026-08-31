// Per-turn and per-session budgets for LSP diagnostic notes (plan 3.1).
//
// Pure state machine in the Sprint-2.3 budget-guard shape: counters + decisions, no I/O, no
// clocks. When a budget is exhausted the notes simply STOP APPENDING — a budget trip never
// blocks a write and never fails a tool result; at most one bus finding announces it.

export interface LspNoteBudgetConfig {
  /** Max note characters per turn (default 8_000). */
  maxTurnChars?: number;
  /** Max note characters for the whole session (default 60_000). */
  maxSessionChars?: number;
}

export const DEFAULT_MAX_TURN_CHARS = 8_000;
export const DEFAULT_MAX_SESSION_CHARS = 60_000;

export interface LspNoteBudgetSnapshot {
  turnChars: number;
  sessionChars: number;
  maxTurnChars: number;
  maxSessionChars: number;
  /** True once the SESSION cap has been hit (latched for the session; the turn cap is transient). */
  exhausted: boolean;
}

export interface LspNoteBudgetState {
  /** Would appending `chars` now stay inside both budgets? */
  allows(chars: number): boolean;
  /** Record an appended note's size. */
  record(chars: number): void;
  /** True once the session cap has been hit (latched; `beginTurn` does not clear it). */
  exhausted(): boolean;
  /** True only on the FIRST not-exhausted → exhausted transition; drives the one bus finding. */
  announceExhausted(): boolean;
  /**
   * When `allows` refused `chars`: was it the SESSION cap (vs the transient turn cap)?
   * Callers use this to decide whether the refusal itself latches exhaustion — a blocked
   * note is never `record`ed, so the latch would otherwise never trip for big first notes.
   */
  blockedBySession(chars: number): boolean;
  /** Latch exhaustion now (idempotent). */
  markExhausted(): void;
  /** Start a new turn: resets the per-turn counter, keeps the session counter. */
  beginTurn(): void;
  snapshot(): LspNoteBudgetSnapshot;
}

export function createLspNoteBudget(config?: LspNoteBudgetConfig): LspNoteBudgetState {
  const maxTurnChars = config?.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS;
  const maxSessionChars = config?.maxSessionChars ?? DEFAULT_MAX_SESSION_CHARS;
  let turnChars = 0;
  let sessionChars = 0;
  let hit = false;
  let announced = false;

  return {
    allows(chars) {
      if (hit) return false; // latched: at/past the session cap nothing more appends
      return turnChars + chars <= maxTurnChars && sessionChars + chars <= maxSessionChars;
    },
    record(chars) {
      turnChars += chars;
      sessionChars += chars;
      // Only the SESSION cap latches `exhausted` — the turn cap resets each turn and never
      // deserves a session-wide announcement.
      if (sessionChars >= maxSessionChars) hit = true;
    },
    exhausted() {
      return hit;
    },
    announceExhausted() {
      // The transition detector: true exactly once, on the first call after exhaustion.
      if (!hit || announced) return false;
      announced = true;
      return true;
    },
    blockedBySession(chars) {
      return sessionChars + chars > maxSessionChars;
    },
    markExhausted() {
      hit = true;
    },
    beginTurn() {
      turnChars = 0;
    },
    snapshot() {
      return { turnChars, sessionChars, maxTurnChars, maxSessionChars, exhausted: hit };
    },
  };
}
