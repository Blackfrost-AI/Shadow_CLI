/**
 * Runtime-context snapshot — tells the model its own confinement, every request.
 *
 * Adapted from DeepSeek Harness (`deepseek-ai/deepseek-harness`), MIT License, which folds the
 * live sandbox/workspace state into the system prompt instead of leaving it implicit in the
 * tool definitions. Copyright (c) DeepSeek. See THIRD_PARTY_NOTICES.md.
 *
 * WHY THIS IS A SEPARATE, TINY BLOCK
 * ----------------------------------
 * A model that does not know it is sandboxed behaves badly in two opposite ways. It either
 * assumes writes will fail and stops trying (giving up on a task it could do), or it assumes it
 * can write anywhere and reports success for a command the kernel blocked. Both are failures of
 * *self-model*, and both are cheap to prevent: state the boundary in one line, per request, from
 * the same policy object that actually builds the sandbox.
 *
 * The honesty rule is the whole design. `describeSandboxPolicy` renders what the policy SAYS;
 * this block additionally renders whether confinement is actually ENFORCED on this host, because
 * `--no-sandbox` and a missing backend both mean "the mode is a lie here". A prompt that reports
 * containment the kernel is not providing is worse than no block at all.
 */

import type { SandboxMode } from '../safety/sandboxPolicy.js';

export interface RuntimeContextFacts {
  /** Absolute workspace root — where relative paths resolve. */
  workspaceRoot: string;
  /** The policy mode the session is running under. */
  sandboxMode: SandboxMode;
  /**
   * Whether the OS sandbox is really in force:
   *   true      a backend exists and will be used
   *   false     confinement was requested but no backend is available
   *   undefined an explicit waiver (--no-sandbox / --yolo / full autonomy) — off on purpose
   */
  confinementEnforced?: boolean;
  /** Extra granted roots (--add-dir / additionalDirectories), already resolved. */
  additionalRoots?: readonly string[];
  /** Offline Shadow Mode. */
  offline?: boolean;
  /** A short, stable session identifier, when one exists. */
  sessionName?: string;
}

const MODE_TEXT: Record<SandboxMode, string> = {
  'read-only': 'no writes anywhere except /dev/null and friends',
  'workspace-write': 'writes confined to the workspace',
  'danger-full-access': 'no filesystem confinement (explicit waiver)',
};

/**
 * Render the block, or '' when there is nothing true to say.
 *
 * Kept to a few lines on purpose: it rides in every request, so every extra token is a permanent
 * tax on context. It says the mode, the write target, and — only when it differs from what the
 * mode implies — the enforcement reality.
 */
export function runtimeContextBlock(facts: RuntimeContextFacts): string {
  const lines: string[] = [];
  const mode = MODE_TEXT[facts.sandboxMode] ?? 'unknown';

  let state = `- sandbox: ${facts.sandboxMode} — ${mode}`;
  if (facts.confinementEnforced === false) {
    // The dangerous case: the mode promises a boundary the host cannot bind.
    state +=
      ' — WARNING: no sandbox backend is available on this host, so this is NOT enforced. ' +
      'Commands run unconfined; treat writes as unguarded and do not claim otherwise.';
  } else if (facts.confinementEnforced === undefined) {
    state += ' — confinement explicitly waived for this session (runs unconfined on purpose).';
  }
  lines.push(state);

  lines.push(`- workspace root: ${facts.workspaceRoot}`);
  if (facts.additionalRoots?.length) {
    lines.push(`- also granted: ${facts.additionalRoots.join(', ')}`);
  }
  if (facts.offline) lines.push('- network: offline — no egress beyond the local model server');
  if (facts.sessionName) lines.push(`- session: ${facts.sessionName}`);

  return `## Runtime context\n${lines.join('\n')}`;
}