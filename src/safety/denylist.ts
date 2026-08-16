/**
 * Catastrophic-command guard. The loop's forceConfirm hook consults this; config-extendable.
 *
 * CONTRACT (F07-09): a match is a HARD BLOCK, and its dialog is ACKNOWLEDGE-ONLY. The loop
 * blocks the call unconditionally — no keypress, session grant, prefix grant, or autonomy raise
 * can run a denylisted command — and the ApprovalRequest it raises carries `acknowledgeOnly:
 * true` so every gate shows acknowledge-only affordances (Enter/Escape, never approve verbs).
 * The old behavior asked y/n and then blocked inside run_shell anyway when the user pressed y:
 * a dead-end dialog, and dead-end dialogs train users to stop reading the one path that must
 * never be skimmed. The question is honest now: "do you see what the model tried?", never
 * "should it run?"
 *
 * The loop's ONE exemption from forceConfirm — an approved plan-exit — is keyed to the
 * exit_plan_mode call ITSELF (name + id), so it can never be inherited by a denylisted command,
 * not even one that reuses the same provider id (positional `call_N` fallback ids are not
 * unique across responses on OpenAI-compat servers).
 *
 * IMPORTANT: this is a FAT-FINGER guard, not a security boundary. It is a literal
 * regex match over the command string and is trivially bypassed by indirection
 * (env vars, $(...) subshells, base64|sh, aliases). The real boundary against a
 * hostile command is the OS-level sandbox (deferred) + the permission gate. Do not
 * rely on this to contain an adversary; rely on it to catch an honest mistake.
 *
 * Returns a human-readable reason when a command is dangerous, else null.
 */
export type Denylist = (command: string) => string | null;

interface Rule {
  test: (cmd: string) => boolean;
  why: string;
}

// A recursive flag in any form: -r, -R, -rf, -fr, --recursive (single or double dash,
// force optional — `rm -r ~/` is just as catastrophic as `rm -rf ~/`).
const RM_RECURSIVE = /(^|\s)-{1,2}[a-z]*r[a-z]*/i;
// A dangerous delete target: any ABSOLUTE path (/, /etc, …), HOME (~, ~/x, $HOME, $HOME/x),
// or a bare glob (*). A relative path inside the workspace is intentionally NOT flagged.
const DANGER_TARGET = /(\s|^)(\/\S*|~\S*|\$HOME\S*|\*)(\s|$)/;

const RULES: Rule[] = [
  {
    why: 'recursive delete of an absolute, home, or glob target',
    test: (c) => /\brm\b/.test(c) && RM_RECURSIVE.test(c) && DANGER_TARGET.test(c),
  },
  {
    // BYPASS review (P2-07): `find / -delete` is `rm -rf /` by another name, and it used to be
    // in NEITHER tier. Scoped to roots that start at an absolute path, ~, or $HOME (right after
    // `find`, optionally quoted) so workspace maintenance (`find . -name '*.tmp' -delete`) stays
    // legal; the opt-in classifier separately hard-denies every `find … -delete`.
    why: 'find -delete rooted at an absolute path, home, or $HOME',
    test: (c) => /(?:^|\s)-delete\b/.test(c) && /\bfind\s+['"\\]?(\/|~|\$HOME)/.test(c),
  },
  { why: 'filesystem creation (mkfs) — destroys data', test: (c) => /\bmkfs(\.\w+)?\b/.test(c) },
  {
    why: 'raw write to a block device (dd of=/dev/…)',
    test: (c) => /\bdd\b[^|;&]*\bof=\/dev\/(disk|sd|nvme|hd|vd|mmcblk)/i.test(c),
  },
  {
    why: 'redirect/overwrite of a block device',
    test: (c) => />\s*\/dev\/(disk|sd|nvme|hd|vd|mmcblk)/i.test(c),
  },
  {
    why: 'fork bomb',
    test: (c) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:?\s*&\s*\}\s*;\s*:/.test(c),
  },
  {
    why: 'recursive world-writable permissions on root/home',
    test: (c) => /\bchmod\b[^|;&]*-R[^|;&]*\b777\b[^|;&]*(\s\/(\s|$)|\s~)/.test(c),
  },
  {
    why: 'recursive ownership change on root',
    test: (c) => /\bchown\b[^|;&]*-R[^|;&]*\s\/(\s|$)/.test(c),
  },
  { why: 'disk shredder on a device', test: (c) => /\bshred\b[^|;&]*\/dev\//i.test(c) },
  { why: 'partition table edit', test: (c) => /\b(parted|fdisk|gdisk)\b[^|;&]*\/dev\//i.test(c) },
  { why: 'shell history wipe', test: (c) => /\bhistory\s+-c\b/.test(c) },
];

/** Build a denylist from the defaults plus any extra regex-source strings from config. */
export function makeDenylist(extra: string[] = []): Denylist {
  const extraRules: Rule[] = extra.map((src) => {
    const re = new RegExp(src, 'i');
    return { test: (c: string) => re.test(c), why: `matched configured denylist pattern /${src}/` };
  });
  const all = [...RULES, ...extraRules];
  return (command: string): string | null => {
    const cmd = command.trim();
    // Also test a quote-stripped copy so a quoted target can't hide the danger: `rm -rf "/"` and
    // `rm -rf '/'` must trip the same rule as `rm -rf /`. This is a confirm-guard (not a hard block),
    // so biasing toward an extra confirmation on an edge case is the safe trade.
    const dequoted = cmd.replace(/["']/g, '');
    for (const r of all) {
      if (r.test(cmd) || (dequoted !== cmd && r.test(dequoted))) return r.why;
    }
    return null;
  };
}

/** The default denylist (no extra patterns). */
export const defaultDenylist: Denylist = makeDenylist();
