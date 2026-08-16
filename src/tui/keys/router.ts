/**
 * P3-01 — the focus-owner router (replaces the old 900-line ordered `onKey` if-chain, F03-02).
 *
 * Contract (FRONTIER_LAUNCH_PLAN P3-01):
 *  1. ONE owner per frame claims the keystream: dialog, picker, search, vim, or composer.
 *     Reserved chords (Ctrl-C/Ctrl-D exit arming, Ctrl-X editor arming) resolve BEFORE owner
 *     routing; bracketed paste (and mouse/DSR) are transports ABOVE the owners (P1A-14).
 *  2. Precedence is DATA — the FOCUS_OWNERS array below is the single source of truth and its
 *     order is pinned by a snapshot test (`test/focus-owner-router.test.ts`). It is never
 *     re-derived from if-order, so the old bug class — "a branch above swallowed a key it
 *     never claimed" (11 verified findings in TUI_4.0_PLAN) — is unrepresentable: an owner
 *     either explicitly claims a key via its handler's `true`, or the key visibly falls
 *     through to the next owner in the table.
 *  3. Behavior-preserving: the owner handlers are verbatim extractions of the old if-chain
 *     sections, and the table order is the old if-order. The byte-level TUI suites are the
 *     acceptance witness.
 */
import { composerOwner } from './composerOwner.js';
import { dialogOwner } from './dialogOwner.js';
import { pickerOwner } from './pickerOwner.js';
import { searchOwner } from './searchOwner.js';
import { vimOwner } from './vimOwner.js';
import { runTransportsAndReserved } from './reserved.js';
import type { FocusOwnerHandler, InkKey, KeyEnv } from './types.js';

/**
 * The dispatch table. ORDER IS PRECEDENCE and is pinned by a snapshot test:
 *
 *   dialog   — an open approval/question gate owns everything (type-ahead guard re-routes
 *              in-flight typing to the composer; a paste can never decide).
 *   picker   — the model picker captures navigation, swallows the rest.
 *   search   — an open Ctrl-R search owns the line; its WAKE chord (Ctrl-R) also resolves at
 *              this slot so it lands ABOVE vim — a focus owner is consulted before a mode.
 *   vim      — modal re-interpretation of composer keys; structural keys fall through.
 *   composer — the always-active fall-through owner (Esc, resolver, menu, Tab ring, editing,
 *              caret, history, backspace, submit, insert).
 */
export const FOCUS_OWNERS: readonly FocusOwnerHandler[] = [
  dialogOwner,
  pickerOwner,
  searchOwner,
  vimOwner,
  composerOwner,
];

/** Route one raw key event. Returns nothing; consumption is internal to the table walk. */
export function dispatchKey(env: KeyEnv, ch: string, key: InkKey): void {
  // Transports (mouse, DSR) and reserved chords (exit/editor arming, paste) resolve first.
  if (runTransportsAndReserved(env, ch, key)) return;
  // Owner routing: first ACTIVE owner wins; an owner returning false lets the key fall
  // through to the next (how vim's structural keys reach the composer).
  for (const owner of FOCUS_OWNERS) {
    if (!owner.active(env, ch, key)) continue;
    if (owner.handle(env, ch, key)) return;
  }
}
