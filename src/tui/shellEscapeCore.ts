/**
 * Explicit operator shell escape — the shared recognition and rejection core.
 *
 * The ONLY way a raw shell command is launched from the composer is an explicit
 * `/!` prefix typed by the operator. Everything else — pasted multiline text,
 * paste chips, model/tool output, queue/steer payloads — is refused before any
 * lock is taken or any pipeline is entered.
 */

export const SHELL_ESCAPE_PREFIX = '/!';

export interface ShellEscapeVerdict {
  ok: boolean;
  command?: string;
  reason?: string;
}

/**
 * Classify one submitted composer line for shell escape.
 *
 * REJECTED as unsafe (never reaches the execution-policy pipeline):
 * - not `/!`-prefixed → not a shell escape at all (no reason; caller routes normally)
 * - empty payload → the operator typed `/!` with nothing to run
 * - payload containing a paste chip (`[Pasted text #N …]`) — the operator did not
 *   type this command by hand; expanded pasted text must never implicitly launch a shell
 * - payload containing a newline — a single typed line cannot carry one; anything
 *   multiline came from a paste, and pastes never launch shells
 */
export function rejectUnsafeShellInput(raw: string): ShellEscapeVerdict {
  if (!raw.startsWith(SHELL_ESCAPE_PREFIX)) return { ok: false };
  const payload = raw.slice(SHELL_ESCAPE_PREFIX.length);
  const command = payload.replace(/^[ \t]+/, '').trim();
  if (!command) {
    return { ok: false, reason: 'Usage: /! <command> — runs through the full permission, denylist and sandbox policy.' };
  }
  if (payload.includes('[Pasted text #')) {
    return { ok: false, reason: 'Pasted text cannot launch a shell. Type the command by hand.' };
  }
  if (command.includes('\n')) {
    return { ok: false, reason: 'Multiline input cannot launch a shell. Type the command on one line.' };
  }
  return { ok: true, command };
}
