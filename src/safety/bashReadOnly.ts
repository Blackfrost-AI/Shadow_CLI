/**
 * Bash read-only auto-allow — prefix rules for shell commands that are safe to
 * run without confirmation at auto-read autonomy and above.
 */

/** Prefixes (after normalization) that indicate a read-only shell command. */
export const READ_ONLY_PREFIXES: readonly string[] = [
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git rev-parse',
  'git describe',
  'git blame',
  'rg ',
  'rg\t',
  'grep ',
  'grep\t',
  'ls ',
  'ls\t',
  'ls',
  'cat ',
  'cat\t',
  'head ',
  'head\t',
  'tail ',
  'tail\t',
  'find ',
  'find\t',
  'docker ps',
  'docker images',
  'docker inspect',
  'npm test',
  'npm run test',
  'npm run -s test',
  'pnpm test',
  'yarn test',
  'pwd',
  'echo ',
  'which ',
  'wc ',
  'file ',
  'stat ',
  'du ',
  'tree ',
  'sort ',
  'uniq ',
  'id',
  'whoami',
  'date',
  'printenv',
  'type ',
  'command -v',
];

/** Destructive find sub-operations that disqualify read-only classification. */
const FIND_DENY_RE = /(?:^|\s)-(?:exec|delete|ok|execdir|fprint|fls)(?:\s|=|$)/i;

/**
 * True when `command` is a read-only shell invocation (prefix match on a
 * normalized form). Every segment of a pipeline and every link of a `;`/`&`/
 * `&&`/`||` chain must independently be read-only.
 */
export function isBashReadOnly(command: string): boolean {
  // A newline can smuggle a second command past a read-only-looking first line
  // (e.g. `echo ok\nbash evil.sh`), and normalization would collapse it to a
  // space and hide the boundary. Reject on the RAW command before normalizing.
  if (/[\r\n]/.test(command)) return false;

  const normalized = normalizeCommand(command);
  if (!normalized) return false;

  // Output redirection WRITES to a file — `echo secret > important.txt` / `cmd >> f` / `cmd &> f`
  // must never ride the read-only fast path (it would overwrite/truncate with no approval). We do
  // NOT reject a bare `2>&1` (stderr→stdout, no file). Anything else with `>` falls through to the gate.
  if (/(?:^|[^0-9&])>>?|&>/.test(normalized.replace(/2>&1/g, ''))) return false;

  // A command substitution `$(...)`, legacy backticks, or process substitution
  // `<(...)`/`>(...)` can hide arbitrary work behind a read-only-looking prefix
  // (e.g. `grep x $(rm -rf ~)`). Such a command can never qualify for the
  // no-confirm fast path — it falls through to the permission gate / denylist
  // instead. (Plain `${VAR}` parameter expansion does not execute, so it stays.)
  if (/\$\(|`|<\(|>\(/.test(normalized)) return false;

  // Split the chain on `;`, `&` (background), `&&`, and `||`. Every link must
  // be read-only — a single mutating link disqualifies the whole command.
  const chainParts = normalized.split(/\s*(?:&&|\|\||;|&)\s*/);
  if (chainParts.length === 0) return false;

  for (const part of chainParts) {
    // Every stage of a pipeline must be read-only — `cat f | bash` is not.
    for (const segment of part.split(/\s*\|\s*/)) {
      const head = segment.trim();
      if (!head || !isReadOnlySegment(head)) return false;
    }
  }
  return true;
}

function isReadOnlySegment(head: string): boolean {
  if (/^find\b/i.test(head) && FIND_DENY_RE.test(head)) return false;
  // `git branch` is read-only only for LISTING — a delete/move/copy/force flag mutates refs
  // (branch deletion, history-losing renames) and must not auto-run.
  if (/^git\s+branch\b/.test(head) && /(?:^|\s)(?:-[dDmMcC]|-f|--(?:delete|move|copy|force))\b/.test(head)) {
    return false;
  }
  for (const prefix of READ_ONLY_PREFIXES) {
    if (head === prefix) return true;
    if (!head.startsWith(prefix)) continue;
    // Require a token boundary after the prefix so `ls` does not match
    // `lsof`/`lsblk` and `id` does not match `identify`. Prefixes that already
    // end in whitespace (e.g. `cat `) carry their own boundary.
    if (/\s$/.test(prefix)) return true;
    const nextChar = head[prefix.length];
    if (nextChar === ' ' || nextChar === '\t') return true;
  }
  return false;
}

function normalizeCommand(command: string): string {
  return command
    .trim()
    .replace(/^[#$]\s*/, '')
    .replace(/\s+/g, ' ');
}