/**
 * Catastrophic-command guard. Even at `full` autonomy, a matching command must be
 * explicitly confirmed (the loop's forceConfirm hook consults this). Config-extendable.
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
