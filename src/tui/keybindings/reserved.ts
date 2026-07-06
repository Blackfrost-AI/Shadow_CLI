/**
 * Reserved shortcuts — keys the terminal or OS owns, or that Shadow hardcodes
 * (and therefore refuses to rebind via config). Used by the loader to validate
 * user configs: hardcoded keys are rejected with a `reserved` warning; OS/terminal
 * shortcuts are allowed but flagged so the user knows they may not work.
 *
 * `ctrl+m` is reserved because terminals deliver it identically to Enter; binding
 * it would shadow Enter unpredictably. `ctrl+c`/`ctrl+d` are Shadow's two-stage
 * interrupt/quit handshake and are never rebindable.
 */
import { keystrokesEqual } from './match.js';
import type { ParsedKeystroke } from './types.js';

interface ReservedEntry {
  reason: string;
  /** 'hard' = cannot rebind at all; 'warn' = rebind allowed but unreliable. */
  severity: 'hard' | 'warn';
}

const k = (key: string, ctrl = false, shift = false, meta = false): ParsedKeystroke => ({ key, ctrl, shift, meta });

const RESERVED: ReadonlyArray<{ ks: ParsedKeystroke; entry: ReservedEntry }> = [
  // Hardcoded by Shadow — never rebindable.
  { ks: k('c', true), entry: { reason: 'ctrl+c is Shadow’s interrupt/quit handshake (hardcoded)', severity: 'hard' } },
  { ks: k('d', true), entry: { reason: 'ctrl+d is hardcoded as quit', severity: 'hard' } },
  { ks: k('m', true), entry: { reason: 'ctrl+m is delivered as Enter by terminals (hardcoded)', severity: 'hard' } },
  // Terminal-owned signals — rebind at your own risk.
  { ks: k('z', true), entry: { reason: 'ctrl+z suspends the process (SIGTSTP) in most terminals', severity: 'warn' } },
  { ks: k('\\', true), entry: { reason: 'ctrl+\\ sends SIGQUIT in most terminals', severity: 'warn' } },
  { ks: k('s', true), entry: { reason: 'ctrl+s is XOFF (flow control) in many terminals', severity: 'warn' } },
  { ks: k('q', true), entry: { reason: 'ctrl+q is XON (flow control) in many terminals', severity: 'warn' } },
];

/** macOS command shortcuts are only reachable on a few terminals; flag them. */
const MAC_RESERVED: ReadonlyArray<ParsedKeystroke> = [
  k('c', false, false, true),
  k('v', false, false, true),
  k('x', false, false, true),
  k('q', false, false, true),
  k('w', false, false, true),
  k('tab', false, false, true),
];

export interface ReservedCheck {
  reserved: boolean;
  severity: 'hard' | 'warn' | null;
  reason: string | null;
}

/** Look up whether a keystroke is reserved and why. */
export function checkReserved(ks: ParsedKeystroke, platform: NodeJS.Platform = process.platform): ReservedCheck {
  for (const e of RESERVED) {
    if (keystrokesEqual(e.ks, ks)) {
      return { reserved: true, severity: e.entry.severity, reason: e.entry.reason };
    }
  }
  if (platform === 'darwin' && MAC_RESERVED.some((m) => keystrokesEqual(m, ks))) {
    return {
      reserved: true,
      severity: 'warn',
      reason: 'cmd+<key> is a macOS system shortcut and rarely reaches the terminal',
    };
  }
  return { reserved: false, severity: null, reason: null };
}

/** True if the keystroke is hardcoded and must not be reassigned. */
export function isHardcoded(ks: ParsedKeystroke, platform?: NodeJS.Platform): boolean {
  return checkReserved(ks, platform).severity === 'hard';
}
