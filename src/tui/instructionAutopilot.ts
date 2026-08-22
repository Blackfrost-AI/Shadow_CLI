// ─────────────────────────────────────────────────────────────────────────────
// Instruction-file autopilot — Claude/Codex parity at LAUNCH.
//
// Claude Code seeds CLAUDE.md on first run and honors AGENTS.md; Codex does the
// same with AGENTS.md. Shadow's resolveSystem ALREADY ingests project
// SHADOW.md/AGENTS.md/CLAUDE.md (fenced untrusted) — the missing piece was the
// launch behavior: nothing created the file, and nothing acknowledged the ones
// that were present.
//
// Decision (pure, fs-inspecting only):
//   • SHADOW.md present            → 'none'  (already ingested; stay silent)
//   • AGENTS.md / CLAUDE.md exist  → 'read'  (acknowledge; NEVER create anything)
//   • none of the three            → 'seed'  (write the SHADOW_SEED scaffold)
//
// The seed is the SAME text `/init` writes, so launch seeding and explicit
// regeneration can never drift apart. Seeding is strictly additive: an existing
// file is never touched, and an unwritable workspace reports an error instead of
// throwing (a read-only mount must not kill the session).
//
// Pure module (existsSync/writeFileSync only) — unit tests cover the decision
// matrix and the never-overwrite rule against temp dirs.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The three project instruction files resolveSystem ingests, in resolution order. */
export const INSTRUCTION_FILES = ['SHADOW.md', 'AGENTS.md', 'CLAUDE.md'] as const;

/**
 * The scaffold seeded at launch (and by `/init`). Claude-Code-style sections:
 * commands, conventions, hard rules — plus the note that Shadow reads all three
 * instruction files when present. Kept short: it lands in every system prompt.
 */
export const SHADOW_SEED = `# Project instructions for Shadow

This file is read automatically at session start and becomes part of every system
prompt in this directory. Keep it short and factual — edit it any time.

## Commands

- build: <your build command>
- test:  <your test command>
- lint:  <your lint command>

## Conventions

- <file layout, naming, style — whatever a newcomer must know>

## Hard rules

- <things Shadow must never do in this repo>

---
Shadow also reads AGENTS.md and CLAUDE.md here when present — one file is enough,
but all three are honored if they exist. Regenerate this scaffold any time with /init.
`;

export type AutopilotDecision =
  /** No instruction file exists — seed SHADOW.md. */
  | { action: 'seed'; file: 'SHADOW.md' }
  /** AGENTS.md/CLAUDE.md present — acknowledge only; never create anything. */
  | { action: 'read'; files: string[] }
  /** SHADOW.md already present — silent (already ingested by resolveSystem). */
  | { action: 'none' };

/** Inspect the workspace and decide the launch behavior. Pure — no writes. */
export function decideInstructionAutopilot(workspaceRoot: string): AutopilotDecision {
  const present = INSTRUCTION_FILES.filter((f) => existsSync(join(workspaceRoot, f)));
  if (present.includes('SHADOW.md')) return { action: 'none' };
  if (present.length > 0) return { action: 'read', files: [...present] };
  return { action: 'seed', file: 'SHADOW.md' };
}

export type SeedResult = { created: string } | { alreadyPresent: string } | { error: string };

/**
 * Write the SHADOW_SEED scaffold. Strictly additive: an existing SHADOW.md is
 * reported as alreadyPresent and NEVER touched; write failures (read-only mount,
 * permissions) return an error the caller surfaces — never thrown.
 */
export function seedInstructionFile(workspaceRoot: string): SeedResult {
  const target = join(workspaceRoot, 'SHADOW.md');
  if (existsSync(target)) return { alreadyPresent: target };
  try {
    writeFileSync(target, SHADOW_SEED, 'utf8');
    return { created: target };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Whether the LAUNCH autopilot should run at all. The boot effect in the TUI checks
 * this — it is skipped under node:test workers (NODE_TEST_CONTEXT is set by the test
 * runner itself, never in production), so render tests that mount the full App can't
 * seed SHADOW.md into the real workspace. The pure decide/seed functions are NOT
 * guarded — unit tests exercise them directly against temp dirs.
 */
export function autopilotEnabledForBoot(): boolean {
  return process.env.NODE_TEST_CONTEXT === undefined;
}

/** Render the T1 toast text for a decision (+ optional seed outcome). */
export function autopilotToastText(decision: AutopilotDecision, seed?: SeedResult): string | null {
  switch (decision.action) {
    case 'seed':
      if (!seed) return null;
      if ('created' in seed) return 'Created SHADOW.md — project instructions live here';
      if ('error' in seed) return `Could not create SHADOW.md: ${seed.error}`;
      return null; // alreadyPresent mid-session race — stay silent
    case 'read':
      return `Reading ${decision.files.join(' + ')} as project context`;
    default:
      return null;
  }
}
